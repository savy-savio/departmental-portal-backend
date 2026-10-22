import { randomUUID } from "node:crypto";
import { DEFAULT_CATEGORY_PREFS, PUSH_CATEGORIES, type PushCategoryPrefs, type PushUserType } from "../../src/services/push/rules";
import { ownerKey, type DeliverableSubscription, type Preferences, type PushOwner, type PushStore, type SubscriptionKeys, type SubscriptionView } from "../../src/services/push/store";
import type { PushSender } from "../../src/services/push/push.service";

interface Row { id: string; userId: string; userType: PushUserType; departmentId: string; endpoint: string; keys: SubscriptionKeys; active: boolean; failureCount: number; deviceLabel: string; createdAt: Date; lastUsedAt: Date | null }

/** Same ownership / uniqueness rules as the Mongo store: endpoint is unique and re-attaches to the current owner. */
export class PushMemoryStore implements PushStore {
  rows: Row[] = [];
  prefs = new Map<string, Preferences>();
  private view = (r: Row): SubscriptionView => ({ id: r.id, deviceLabel: r.deviceLabel, createdAt: r.createdAt, lastUsedAt: r.lastUsedAt, active: r.active });

  async upsertSubscription(o: PushOwner, i: { endpoint: string; keys: SubscriptionKeys; deviceLabel: string; now: Date }) {
    let r = this.rows.find((x) => x.endpoint === i.endpoint);
    if (r) Object.assign(r, { userId: o.userId, userType: o.userType, departmentId: o.departmentId, keys: i.keys, active: true, failureCount: 0, deviceLabel: i.deviceLabel, lastUsedAt: i.now });
    else { r = { id: randomUUID(), userId: o.userId, userType: o.userType, departmentId: o.departmentId, endpoint: i.endpoint, keys: i.keys, active: true, failureCount: 0, deviceLabel: i.deviceLabel, createdAt: i.now, lastUsedAt: i.now }; this.rows.push(r); }
    return this.view(r);
  }
  async trimToLimit(o: PushOwner, keep: string, max: number) {
    const mine = this.rows.filter((r) => r.userId === o.userId && r.userType === o.userType).sort((a, b) => (b.lastUsedAt?.getTime() ?? 0) - (a.lastUsedAt?.getTime() ?? 0));
    const surplus = mine.filter((r) => r.endpoint !== keep).slice(Math.max(0, max - 1));
    this.rows = this.rows.filter((r) => !surplus.includes(r));
    return surplus.length;
  }
  async listForOwner(o: Pick<PushOwner, "userId" | "userType">) { return this.rows.filter((r) => r.userId === o.userId && r.userType === o.userType).map(this.view); }
  async removeByEndpoint(o: Pick<PushOwner, "userId" | "userType">, endpoint: string) { const n = this.rows.length; this.rows = this.rows.filter((r) => !(r.endpoint === endpoint && r.userId === o.userId && r.userType === o.userType)); return this.rows.length < n; }
  async removeById(o: Pick<PushOwner, "userId" | "userType">, id: string) { const n = this.rows.length; this.rows = this.rows.filter((r) => !(r.id === id && r.userId === o.userId && r.userType === o.userType)); return this.rows.length < n; }
  async deliverableFor(users: { userId: string; userType: PushUserType }[]): Promise<DeliverableSubscription[]> {
    const keys = new Set(users.map(ownerKey));
    return this.rows.filter((r) => r.active && keys.has(ownerKey(r))).map((r) => ({ id: r.id, endpoint: r.endpoint, keys: r.keys, userId: r.userId, userType: r.userType, departmentId: r.departmentId }));
  }
  async deleteSubscription(id: string) { this.rows = this.rows.filter((r) => r.id !== id); }
  async recordSuccess(id: string, at: Date) { const r = this.rows.find((x) => x.id === id); if (r) { r.failureCount = 0; r.lastUsedAt = at; } }
  async recordFailure(id: string, _at: Date, after: number) { const r = this.rows.find((x) => x.id === id); if (r) { r.failureCount++; if (r.failureCount >= after) r.active = false; } }

  private def = (): Preferences => ({ pushEnabled: true, categories: { ...DEFAULT_CATEGORY_PREFS } });
  async getPreferences(o: Pick<PushOwner, "userId" | "userType">) { return this.prefs.get(ownerKey(o)) ?? this.def(); }
  async getPreferencesFor(users: { userId: string; userType: PushUserType }[]) { const m = new Map<string, Preferences>(); for (const u of users) { const p = this.prefs.get(ownerKey(u)); if (p) m.set(ownerKey(u), p); } return m; }
  async setPreferences(o: Pick<PushOwner, "userId" | "userType">, patch: { pushEnabled?: boolean; categories?: Partial<PushCategoryPrefs> }) {
    const cur = await this.getPreferences(o);
    const next: Preferences = { pushEnabled: patch.pushEnabled ?? cur.pushEnabled, categories: { ...cur.categories } };
    for (const c of PUSH_CATEGORIES) if (patch.categories?.[c] !== undefined) next.categories[c] = patch.categories[c]!;
    this.prefs.set(ownerKey(o), next);
    return next;
  }
}

export class FakeSender implements PushSender {
  sent: { endpoint: string; payload: { title: string; body: string; url: string; tag: string; category: string }; topic: string; ttl: number }[] = [];
  /** endpoint -> status code to fail with (0 = a plain network error without a status) */
  failWith = new Map<string, number>();
  throwAll = false;
  async send(sub: { endpoint: string }, payload: string, opts: { ttlSeconds: number; topic: string }) {
    if (this.throwAll) throw new Error("boom");
    const code = this.failWith.get(sub.endpoint);
    if (code !== undefined) throw Object.assign(new Error("push service refused"), code ? { statusCode: code } : {});
    this.sent.push({ endpoint: sub.endpoint, payload: JSON.parse(payload), topic: opts.topic, ttl: opts.ttlSeconds });
  }
}
