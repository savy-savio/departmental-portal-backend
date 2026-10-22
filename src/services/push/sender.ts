import { logger } from "../../utils/logger";
import type { PushSender } from "./push.service";

/**
 * The real transport, on the `web-push` package. It is loaded lazily on the first send, so the server still starts (with push inactive and a clear
 * log line) if the dependency isn't installed. The VAPID PRIVATE key lives only in this process: it is never returned by any endpoint or logged.
 */
export function createWebPushSender(vapid: { publicKey: string; privateKey: string; subject: string }): PushSender {
  let lib: typeof import("web-push") | null | undefined;
  const load = async () => {
    if (lib !== undefined) return lib;
    try {
      const mod = await import("web-push");
      lib = (mod as { default?: typeof import("web-push") }).default ?? mod;
      lib.setVapidDetails(vapid.subject, vapid.publicKey, vapid.privateKey);
    } catch (err) {
      lib = null;
      logger.error("Push notifications are inactive: the 'web-push' package could not be loaded. Run `npm install web-push`.", err instanceof Error ? err.message : err);
    }
    return lib;
  };
  return {
    async send(sub, payload, opts) {
      const wp = await load();
      if (!wp) throw Object.assign(new Error("web-push unavailable"), { statusCode: 0 });
      await wp.sendNotification({ endpoint: sub.endpoint, keys: sub.keys }, payload, { TTL: opts.ttlSeconds, topic: opts.topic, urgency: opts.urgency, timeout: 10_000 });
    },
  };
}
