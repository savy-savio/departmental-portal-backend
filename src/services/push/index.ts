import { env } from "../../config/env";
import { logger } from "../../utils/logger";
import { MongoPushStore } from "./mongo-store";
import { PushService } from "./push.service";
import type { PushableNotification } from "./rules";
import { createWebPushSender } from "./sender";

const vapid = env.pushConfigured ? { publicKey: env.VAPID_PUBLIC_KEY!, privateKey: env.VAPID_PRIVATE_KEY!, subject: env.VAPID_SUBJECT! } : null;

export const pushService = new PushService({
  store: new MongoPushStore(),
  sender: vapid ? createWebPushSender(vapid) : { send: async () => { throw new Error("push not configured"); } },
  config: { enabled: Boolean(vapid), publicKey: vapid?.publicKey ?? null, extraEndpointHosts: env.pushExtraHosts, maxDevicesPerUser: env.PUSH_MAX_DEVICES_PER_USER },
  now: () => new Date(),
  log: logger,
});

/** Fire-and-forget: called after a notification is SAVED. Never throws and is never awaited by the action that triggered it. */
export function dispatchPushSafely(items: PushableNotification[]): void {
  if (!pushService.enabled || !items.length) return;
  setImmediate(() => { void pushService.dispatchSafely(items); });
}
