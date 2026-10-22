import { AppError } from "../../utils/AppError";
import {
  buildPushPayload, categoryOf, deviceLabelFrom, isAllowedPushEndpoint, isGoneStatus, MAX_CONSECUTIVE_FAILURES,
  type PushableNotification, type PushCategoryPrefs,
} from "./rules";
import { ownerKey, type DeliverableSubscription, type PushOwner, type PushStore, type SubscriptionKeys } from "./store";

/** Transport (the `web-push` library in production, a fake in tests). Throws an error carrying `statusCode` when the push service refuses. */
export interface PushSender {
  send(sub: { endpoint: string; keys: SubscriptionKeys }, payload: string, opts: { ttlSeconds: number; topic: string; urgency: "normal" | "high" }): Promise<void>;
}
export interface PushConfig {
  /** VAPID keys + subject present and the sender usable. Without it every push operation is a quiet no-op. */
  enabled: boolean;
  publicKey: string | null;
  extraEndpointHosts: string[];
  maxDevicesPerUser: number;
}
export interface PushDeps { store: PushStore; sender: PushSender; config: PushConfig; now: () => Date; log?: { warn: (...a: unknown[]) => void } }
export interface DispatchSummary { attempted: number; sent: number; removed: number; failed: number; skippedByPreference: number; notPushable: number }

const TTL_SECONDS = 24 * 60 * 60; // a notification the device couldn't receive within a day is stale
const CHUNK = 200; // notifications handled per round: bounds memory and database fan-out for large classes
const CONCURRENCY = 25;

const emptySummary = (): DispatchSummary => ({ attempted: 0, sent: 0, removed: 0, failed: 0, skippedByPreference: 0, notPushable: 0 });

/**
 * Browser push delivery. It is deliberately separate from in-app storage: it receives notifications that were ALREADY saved (recipient, department and
 * link decided by the existing workflow), never recipient ids from a client, and nothing it does can fail or roll back the action that caused it.
 */
export class PushService {
  constructor(private readonly d: PushDeps) {}

  get enabled() { return this.d.config.enabled; }
  /** Safe to show the browser: the PUBLIC key only. */
  publicConfig() { return { supported: this.d.config.enabled, publicKey: this.d.config.enabled ? this.d.config.publicKey : null }; }

  /* ------------------------------ subscriptions ------------------------------ */
  async register(owner: PushOwner, input: { endpoint: string; keys: SubscriptionKeys; deviceLabel?: string }, userAgent?: string) {
    if (!this.d.config.enabled) throw new AppError(503, "Push notifications aren't available on this server.", undefined, "PUSH_NOT_CONFIGURED");
    if (!isAllowedPushEndpoint(input.endpoint, this.d.config.extraEndpointHosts)) {
      throw new AppError(422, "That browser push service isn't supported.", undefined, "UNSUPPORTED_PUSH_ENDPOINT");
    }
    const view = await this.d.store.upsertSubscription(owner, { endpoint: input.endpoint, keys: input.keys, deviceLabel: deviceLabelFrom(userAgent, input.deviceLabel), now: this.d.now() });
    await this.d.store.trimToLimit(owner, input.endpoint, this.d.config.maxDevicesPerUser);
    return view;
  }
  /** Idempotent: always the same answer, so nobody can probe which endpoints exist. Only the caller's own registration is touched. */
  async unregister(owner: Pick<PushOwner, "userId" | "userType">, endpoint: string) {
    return { removed: await this.d.store.removeByEndpoint(owner, endpoint) };
  }
  async unregisterById(owner: Pick<PushOwner, "userId" | "userType">, id: string) {
    if (!(await this.d.store.removeById(owner, id))) throw new AppError(404, "Device not found.", undefined, "NOT_FOUND");
  }
  listDevices(owner: Pick<PushOwner, "userId" | "userType">) { return this.d.store.listForOwner(owner); }

  /* ------------------------------ preferences ------------------------------ */
  getPreferences(owner: Pick<PushOwner, "userId" | "userType">) { return this.d.store.getPreferences(owner); }
  /** Turning push off keeps the devices and, above all, the in-app notification history. */
  setPreferences(owner: Pick<PushOwner, "userId" | "userType">, patch: { pushEnabled?: boolean; categories?: Partial<PushCategoryPrefs> }) { return this.d.store.setPreferences(owner, patch); }

  /* ------------------------------ delivery ------------------------------ */
  /** Never rejects: any failure is logged and swallowed, so callers can fire and forget. */
  async dispatchSafely(items: PushableNotification[]): Promise<DispatchSummary> {
    try { return await this.dispatch(items); } catch (err) {
      this.d.log?.warn("Push dispatch failed:", err instanceof Error ? err.message : err);
      return emptySummary();
    }
  }

  /** Pushes already-stored notifications to their recipients' devices, respecting the master switch and category preferences. */
  async dispatch(items: PushableNotification[]): Promise<DispatchSummary> {
    const summary = emptySummary();
    if (!this.d.config.enabled || !items.length) return summary;
    for (let i = 0; i < items.length; i += CHUNK) await this.dispatchChunk(items.slice(i, i + CHUNK), summary);
    return summary;
  }

  private async dispatchChunk(chunk: PushableNotification[], summary: DispatchSummary) {
    const classified = chunk.flatMap((n) => { const category = categoryOf(n); if (!category) { summary.notPushable++; return []; } return [{ n, category }]; });
    if (!classified.length) return;
    const users = [...new Map(classified.map(({ n }) => [ownerKey({ userId: n.recipientId, userType: n.recipientType }), { userId: n.recipientId, userType: n.recipientType }])).values()];
    const [prefs, subs] = await Promise.all([this.d.store.getPreferencesFor(users), this.d.store.deliverableFor(users)]);
    const subsByUser = new Map<string, DeliverableSubscription[]>();
    for (const s of subs) { const k = ownerKey(s); subsByUser.set(k, [...(subsByUser.get(k) ?? []), s]); }

    const jobs: { sub: DeliverableSubscription; body: string; topic: string }[] = [];
    for (const { n, category } of classified) {
      const k = ownerKey({ userId: n.recipientId, userType: n.recipientType });
      const p = prefs.get(k);
      if (p && (!p.pushEnabled || !p.categories[category])) { summary.skippedByPreference++; continue; }
      const payload = JSON.stringify(buildPushPayload(n, category));
      // A device only ever receives notifications of the department it is registered in: no cross-department delivery.
      for (const sub of subsByUser.get(k) ?? []) if (sub.departmentId === n.departmentId) jobs.push({ sub, body: payload, topic: n.id });
    }
    summary.attempted += jobs.length;
    for (let i = 0; i < jobs.length; i += CONCURRENCY) await Promise.all(jobs.slice(i, i + CONCURRENCY).map((j) => this.deliver(j, summary)));
  }

  private async deliver(j: { sub: DeliverableSubscription; body: string; topic: string }, summary: DispatchSummary) {
    const at = this.d.now();
    try {
      await this.d.sender.send({ endpoint: j.sub.endpoint, keys: j.sub.keys }, j.body, { ttlSeconds: TTL_SECONDS, topic: j.topic, urgency: "normal" });
      summary.sent++;
      await this.d.store.recordSuccess(j.sub.id, at).catch(() => undefined);
    } catch (err) {
      const status = (err as { statusCode?: number }).statusCode;
      if (isGoneStatus(status)) { // expired / unsubscribed in the browser: remove it for good
        summary.removed++;
        await this.d.store.deleteSubscription(j.sub.id).catch(() => undefined);
      } else {
        summary.failed++;
        await this.d.store.recordFailure(j.sub.id, at, MAX_CONSECUTIVE_FAILURES).catch(() => undefined);
        this.d.log?.warn(`Push delivery failed (status ${status ?? "none"})`); // never the payload, endpoint or keys
      }
    }
  }

  /** "Send me a test": the caller's own devices only, fixed text, ignores category preferences (the user asked for it). */
  async sendTest(owner: PushOwner) {
    if (!this.d.config.enabled) throw new AppError(503, "Push notifications aren't available on this server.", undefined, "PUSH_NOT_CONFIGURED");
    const subs = (await this.d.store.deliverableFor([owner])).filter((s) => s.departmentId === owner.departmentId);
    const summary = emptySummary();
    const body = JSON.stringify({ title: "Notifications are on", body: "You will now receive portal updates on this device.", url: owner.userType === "STUDENT" ? "/student" : owner.userType === "LECTURER" ? "/lecturer" : "/hod", tag: "push-test", category: "announcements" });
    summary.attempted = subs.length;
    await Promise.all(subs.map((sub) => this.deliver({ sub, body, topic: "push-test" }, summary)));
    return { devices: subs.length, sent: summary.sent, failed: summary.failed, removed: summary.removed };
  }
}
