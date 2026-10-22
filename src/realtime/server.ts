import type { Server as HttpServer } from "node:http";
import { Server } from "socket.io";
import { env } from "../config/env";
import { loadActiveStudent } from "../middleware/auth";
import { Notification } from "../models/Notification";
import { hodAuth } from "../services/hod";
import { lecturerAuth } from "../services/lecturer";
import { logger } from "../utils/logger";
import { createHandshakeAuth, FailedAuthLimiter, HandshakeError } from "./handshake";
import { realtime } from "./instance";
import type { RealtimeIdentity } from "./rooms";

/**
 * Attaches Socket.IO to the HTTP server. Same CORS allow-list and same token rules as the REST API. Clients cannot send events or choose rooms:
 * the server only pushes ("ready", "notification:new", "notification:read") to the authenticated owner's personal room.
 */
export function attachRealtime(http: HttpServer): { close: () => Promise<void> } | null {
  if (!env.socketEnabled) { logger.info("Real-time (Socket.IO) is disabled (SOCKET_ENABLED=false)."); return null; }

  const io = new Server(http, {
    cors: { origin: (origin, cb) => cb(null, !origin || env.clientOrigins.includes(origin)), methods: ["GET", "POST"] },
    maxHttpBufferSize: 10_000, // clients never send data, so keep the limit tiny
    connectTimeout: 10_000, pingInterval: 25_000, pingTimeout: 20_000,
  });

  const authenticate = createHandshakeAuth({
    STUDENT: async (token) => { const { student, department } = await loadActiveStudent(token); return { userId: String(student._id), userType: "STUDENT", departmentId: String(department._id) }; },
    LECTURER: async (token) => {
      const { actor, lecturer } = await lecturerAuth.authenticate(token);
      if (lecturer.role !== "LECTURER" || lecturer.status !== "ACTIVE") throw new Error("not a lecturer");
      return { userId: actor.lecturerId, userType: "LECTURER", departmentId: actor.departmentId };
    },
    HOD: async (token) => {
      const { actor, lecturer } = await hodAuth.authenticate(token);
      if (lecturer.role !== "HOD" || lecturer.status !== "ACTIVE") throw new Error("not a HOD");
      return { userId: actor.lecturerId, userType: "HOD", departmentId: actor.departmentId };
    },
  });
  const limiter = new FailedAuthLimiter();

  io.use(async (socket, next) => {
    const ip = socket.handshake.address;
    if (limiter.blocked(ip)) return next(new Error("Too many attempts. Try again shortly."));
    try {
      socket.data.who = await authenticate({ auth: socket.handshake.auth }); // the URL query string is never consulted
      next();
    } catch (err) {
      limiter.recordFailure(ip);
      next(new Error(err instanceof HandshakeError ? err.message : "Authentication failed."));
    }
  });
  io.on("connection", (socket) => { void realtime.onConnect(socket, socket.data.who as RealtimeIdentity); });

  realtime.configure({
    maxSessionMs: env.SOCKET_MAX_SESSION_MINUTES * 60_000, // forces a reconnect (and a fresh token / account check) at least this often
    countUnread: (who) => Notification.countDocuments({ recipient: who.userId, readAt: { $exists: false } }),
    log: logger,
  });
  realtime.attach(io);
  logger.info("Real-time (Socket.IO) is on.");
  return { close: () => new Promise<void>((resolve) => { void io.close(() => resolve()); }) };
}
