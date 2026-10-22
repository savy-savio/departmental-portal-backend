/*
 * Browser helper for real-time portal notifications (Socket.IO).
 *   npm install socket.io-client
 *
 *   import { connectRealtime } from "./realtime-client.js";
 *   const rt = connectRealtime({
 *     url: "https://api.your-university.edu",        // the API origin (must be in the server's CLIENT_ORIGINS)
 *     role: "student",                                 // "student" | "lecturer" | "hod"
 *     getToken: () => localStorage.getItem("token"),   // called on every (re)connect, so a refreshed token is always used
 *     onReady: ({ unreadCount }) => setBadge(unreadCount),
 *     onNotification: (n) => { addToList(n); bumpBadge(); },   // n = { id, kind, title, body, link, complaintId, read, createdAt }
 *     onRead: (e) => e.all ? clearBadge() : markReadInUi(e.id), // another tab / device marked it read
 *     onAuthError: () => { refreshLoginOrSignOut(); },          // then call rt.reconnect()
 *   });
 *   on logout:  rt.disconnect();
 *
 * The server only pushes events to the signed-in user's own room: there is nothing to subscribe to and nothing to send.
 * The REST endpoints (/notifications ...) stay the source of truth: load the list from them, and use the socket just to stay live.
 */
import { io } from "socket.io-client";

export function connectRealtime({ url, role, getToken, onReady, onNotification, onRead, onAuthError, onConnectionChange }) {
  const socket = io(url, {
    // A function: evaluated on every connection attempt, so the token is never stale. It goes in the handshake (never in the URL).
    auth: (cb) => cb({ token: getToken(), role }),
    transports: ["websocket", "polling"],
    reconnection: true,
  });
  socket.on("connect", () => onConnectionChange?.(true));
  socket.on("disconnect", () => onConnectionChange?.(false));
  socket.on("ready", (info) => onReady?.(info));
  socket.on("notification:new", (n) => onNotification?.(n));
  socket.on("notification:read", (e) => onRead?.(e));
  socket.on("connect_error", (err) => {
    // After a refused handshake Socket.IO does NOT retry by itself: the app decides (refresh the token, or sign the user out).
    if (!socket.active) onAuthError?.(err);
  });
  return {
    socket,
    reconnect: () => socket.connect(),
    disconnect: () => socket.disconnect(),
  };
}
