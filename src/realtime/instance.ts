import { RealtimeHub } from "./hub";

/**
 * The process-wide hub. Importing this file is free of side effects and of the auth services, so notification code and controllers can use it
 * without circular imports. Until the server attaches Socket.IO it is inactive and every emit is a no-op (tests, scripts, `npm run reminders:*`).
 */
export const realtime = new RealtimeHub(null);
