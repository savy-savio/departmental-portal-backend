import type { PushCategoryPrefs, PushUserType } from "./rules";

export interface PushOwner { userId: string; userType: PushUserType; departmentId: string }
export interface SubscriptionKeys { p256dh: string; auth: string }
export interface SubscriptionView { id: string; deviceLabel: string; createdAt: Date; lastUsedAt: Date | null; active: boolean }
/** Includes the secret keys: only the delivery code ever sees this. */
export interface DeliverableSubscription { id: string; endpoint: string; keys: SubscriptionKeys; userId: string; userType: PushUserType; departmentId: string }
export interface Preferences { pushEnabled: boolean; categories: PushCategoryPrefs }

export interface PushStore {
  /**
   * Creates the registration, or re-attaches an existing one (same endpoint = same browser profile) to THIS authenticated user: the endpoint
   * is unique, so a browser that is now signed in as someone else stops receiving the previous user's notifications.
   */
  upsertSubscription(o: PushOwner, input: { endpoint: string; keys: SubscriptionKeys; deviceLabel: string; now: Date }): Promise<SubscriptionView>;
  /** Deletes the oldest registrations of this user beyond `max` (the one just saved is kept). */
  trimToLimit(o: PushOwner, keepEndpoint: string, max: number): Promise<number>;
  listForOwner(o: Pick<PushOwner, "userId" | "userType">): Promise<SubscriptionView[]>;
  /** Only the owner's own registration can be removed; returns whether one was. */
  removeByEndpoint(o: Pick<PushOwner, "userId" | "userType">, endpoint: string): Promise<boolean>;
  removeById(o: Pick<PushOwner, "userId" | "userType">, id: string): Promise<boolean>;

  /** Active registrations of these users (secrets included). */
  deliverableFor(users: { userId: string; userType: PushUserType }[]): Promise<DeliverableSubscription[]>;
  deleteSubscription(id: string): Promise<void>;
  recordSuccess(id: string, at: Date): Promise<void>;
  /** Counts the failure; deactivates the registration once `deactivateAfter` consecutive failures are reached. */
  recordFailure(id: string, at: Date, deactivateAfter: number): Promise<void>;

  getPreferences(o: Pick<PushOwner, "userId" | "userType">): Promise<Preferences>;
  getPreferencesFor(users: { userId: string; userType: PushUserType }[]): Promise<Map<string, Preferences>>;
  setPreferences(o: Pick<PushOwner, "userId" | "userType">, patch: { pushEnabled?: boolean; categories?: Partial<PushCategoryPrefs> }): Promise<Preferences>;
}
export const ownerKey = (o: { userId: string; userType: PushUserType }) => `${o.userType}:${o.userId}`;
