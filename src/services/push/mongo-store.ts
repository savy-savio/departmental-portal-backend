import { NotificationPreference } from "../../models/NotificationPreference";
import { PushSubscription, type PushSubscriptionDocument } from "../../models/PushSubscription";
import { DEFAULT_CATEGORY_PREFS, PUSH_CATEGORIES, type PushCategoryPrefs, type PushUserType } from "./rules";
import { ownerKey, type DeliverableSubscription, type Preferences, type PushOwner, type PushStore, type SubscriptionKeys, type SubscriptionView } from "./store";

const id = (v: unknown) => String(v);
const view = (s: PushSubscriptionDocument): SubscriptionView => ({
  id: id(s._id), deviceLabel: s.deviceLabel ?? "Browser", createdAt: (s as unknown as { createdAt: Date }).createdAt, lastUsedAt: s.lastUsedAt ?? null, active: s.active,
});
const prefsOf = (d?: { pushEnabled?: boolean; categories?: Partial<PushCategoryPrefs> } | null): Preferences => ({
  pushEnabled: d?.pushEnabled ?? true,
  categories: Object.fromEntries(PUSH_CATEGORIES.map((c) => [c, d?.categories?.[c] ?? DEFAULT_CATEGORY_PREFS[c]])) as PushCategoryPrefs,
});

/** MongoDB implementation. Every ownership-sensitive query includes the user id AND type. Secrets (`keys`) are only selected for delivery. */
export class MongoPushStore implements PushStore {
  async upsertSubscription(o: PushOwner, input: { endpoint: string; keys: SubscriptionKeys; deviceLabel: string; now: Date }) {
    // Same endpoint = same browser profile: re-attach it to the CURRENT authenticated user (and department), reactivate it, reset failures.
    const s = await PushSubscription.findOneAndUpdate(
      { endpoint: input.endpoint },
      { $set: { user: o.userId, userType: o.userType, department: o.departmentId, keys: input.keys, active: true, failureCount: 0, deviceLabel: input.deviceLabel, lastUsedAt: input.now } },
      { new: true, upsert: true, setDefaultsOnInsert: true, runValidators: true },
    );
    return view(s);
  }
  async trimToLimit(o: PushOwner, keepEndpoint: string, max: number) {
    const mine = await PushSubscription.find({ user: o.userId, userType: o.userType }).select("endpoint lastUsedAt").sort({ lastUsedAt: -1, createdAt: -1 });
    const surplus = mine.filter((s) => s.endpoint !== keepEndpoint).slice(Math.max(0, max - 1));
    if (!surplus.length) return 0;
    await PushSubscription.deleteMany({ _id: { $in: surplus.map((s) => s._id) }, user: o.userId, userType: o.userType });
    return surplus.length;
  }
  async listForOwner(o: Pick<PushOwner, "userId" | "userType">) {
    return (await PushSubscription.find({ user: o.userId, userType: o.userType }).sort({ createdAt: -1 })).map(view);
  }
  async removeByEndpoint(o: Pick<PushOwner, "userId" | "userType">, endpoint: string) {
    return (await PushSubscription.deleteOne({ endpoint, user: o.userId, userType: o.userType })).deletedCount > 0;
  }
  async removeById(o: Pick<PushOwner, "userId" | "userType">, subId: string) {
    return (await PushSubscription.deleteOne({ _id: subId, user: o.userId, userType: o.userType })).deletedCount > 0;
  }

  async deliverableFor(users: { userId: string; userType: PushUserType }[]): Promise<DeliverableSubscription[]> {
    if (!users.length) return [];
    const byType = new Map<PushUserType, string[]>();
    for (const u of users) byType.set(u.userType, [...(byType.get(u.userType) ?? []), u.userId]);
    const rows = (await Promise.all([...byType].map(([userType, ids]) => PushSubscription.find({ userType, user: { $in: ids }, active: true }).select("+keys")))).flat();
    return rows.filter((s) => s.keys?.p256dh && s.keys?.auth).map((s) => ({
      id: id(s._id), endpoint: s.endpoint, keys: { p256dh: s.keys!.p256dh, auth: s.keys!.auth }, userId: id(s.user), userType: s.userType, departmentId: id(s.department),
    }));
  }
  async deleteSubscription(subId: string) { await PushSubscription.deleteOne({ _id: subId }); }
  async recordSuccess(subId: string, at: Date) { await PushSubscription.updateOne({ _id: subId }, { $set: { lastUsedAt: at, failureCount: 0 } }); }
  async recordFailure(subId: string, at: Date, deactivateAfter: number) {
    const s = await PushSubscription.findOneAndUpdate({ _id: subId }, { $inc: { failureCount: 1 }, $set: { lastFailureAt: at } }, { new: true });
    if (s && s.failureCount >= deactivateAfter) await PushSubscription.updateOne({ _id: subId }, { $set: { active: false } });
  }

  async getPreferences(o: Pick<PushOwner, "userId" | "userType">) { return prefsOf(await NotificationPreference.findOne({ user: o.userId, userType: o.userType })); }
  async getPreferencesFor(users: { userId: string; userType: PushUserType }[]) {
    const out = new Map<string, Preferences>();
    const byType = new Map<PushUserType, string[]>();
    for (const u of users) byType.set(u.userType, [...(byType.get(u.userType) ?? []), u.userId]);
    const rows = (await Promise.all([...byType].map(([userType, ids]) => NotificationPreference.find({ userType, user: { $in: ids } })))).flat();
    for (const r of rows) out.set(ownerKey({ userId: id(r.user), userType: r.userType }), prefsOf(r)); // users without a document are simply absent = defaults (all on)
    return out;
  }
  async setPreferences(o: Pick<PushOwner, "userId" | "userType">, patch: { pushEnabled?: boolean; categories?: Partial<PushCategoryPrefs> }) {
    const $set: Record<string, boolean> = {};
    if (patch.pushEnabled !== undefined) $set.pushEnabled = patch.pushEnabled;
    for (const c of PUSH_CATEGORIES) if (patch.categories?.[c] !== undefined) $set[`categories.${c}`] = patch.categories[c]!;
    const d = await NotificationPreference.findOneAndUpdate({ user: o.userId, userType: o.userType }, { $set }, { new: true, upsert: true, setDefaultsOnInsert: true });
    return prefsOf(d);
  }
}
