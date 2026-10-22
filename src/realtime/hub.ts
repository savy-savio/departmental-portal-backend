import { MAX_SOCKETS_PER_USER, userRoom, type RealtimeIdentity, type RealtimeUserType } from "./rooms";

/** The slice of Socket.IO the hub needs, so it can be tested without the library. */
export interface SocketLike {
  id: string;
  join(room: string): unknown;
  emit(event: string, payload?: unknown): unknown;
  disconnect(close?: boolean): unknown;
  on(event: "disconnect", fn: () => void): unknown;
}
export interface ServerLike { to(room: string): { emit(event: string, payload?: unknown): unknown } }
export interface Scheduler { setTimeout(fn: () => void, ms: number): { unref?: () => void } | unknown; clearTimeout(h: unknown): void }

export interface RealtimeNotification {
  id: string; recipientId: string; recipientType: RealtimeUserType; kind: string; title: string; body: string;
  link?: string | null; complaintId?: string | null; createdAt?: Date;
}

/**
 * Delivers events to the right people. It never accepts a recipient from a client: callers pass a notification that was ALREADY saved for that
 * recipient, and the only room a socket can be in is its owner's personal room. Every method swallows errors: real-time delivery is a
 * convenience and must never break (or slow) the action that triggered it.
 */
export class RealtimeHub {
  private sockets = new Map<string, SocketLike[]>();
  constructor(
    private io: ServerLike | null,
    private readonly opts: { maxSocketsPerUser?: number; maxSessionMs?: number; scheduler?: Scheduler; countUnread?: (who: RealtimeIdentity) => Promise<number>; log?: { warn: (...a: unknown[]) => void } } = {},
  ) {}

  attach(io: ServerLike) { this.io = io; }
  /** Set once at startup by the server module (kept out of the constructor so this file never imports the auth services). */
  configure(opts: NonNullable<RealtimeHub["opts"]>) { Object.assign(this.opts, opts); }
  get active() { return this.io !== null; }
  connectionCount(who: Pick<RealtimeIdentity, "userType" | "userId">) { return this.sockets.get(userRoom(who))?.length ?? 0; }

  /** Called once a socket has authenticated. Joins ONLY the owner's room; trims old connections; ends the session after `maxSessionMs` so the token is re-checked. */
  async onConnect(socket: SocketLike, who: RealtimeIdentity) {
    const room = userRoom(who);
    socket.join(room);
    const list = [...(this.sockets.get(room) ?? []), socket];
    const max = this.opts.maxSocketsPerUser ?? MAX_SOCKETS_PER_USER;
    while (list.length > max) list.shift()!.disconnect(true); // the oldest connection goes
    this.sockets.set(room, list);

    const sched = this.opts.scheduler ?? { setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms), clearTimeout: (h: unknown) => clearTimeout(h as NodeJS.Timeout) };
    const timer = this.opts.maxSessionMs ? sched.setTimeout(() => socket.disconnect(true), this.opts.maxSessionMs) : undefined;
    (timer as { unref?: () => void } | undefined)?.unref?.();
    socket.on("disconnect", () => {
      if (timer) sched.clearTimeout(timer);
      const rest = (this.sockets.get(room) ?? []).filter((s) => s !== socket);
      if (rest.length) this.sockets.set(room, rest); else this.sockets.delete(room);
    });

    let unreadCount: number | null = null;
    try { unreadCount = this.opts.countUnread ? await this.opts.countUnread(who) : null; } catch { /* the count is a nicety */ }
    socket.emit("ready", { role: who.userType.toLowerCase(), unreadCount });
  }

  emitToUser(who: Pick<RealtimeIdentity, "userType" | "userId">, event: string, payload?: unknown) {
    try { this.io?.to(userRoom(who)).emit(event, payload); } catch (err) { this.opts.log?.warn("Realtime emit failed:", err instanceof Error ? err.message : err); }
  }

  /** New, already-saved notifications -> their recipients' sockets. The payload is the same shape the REST list returns. */
  emitNotifications(items: RealtimeNotification[]) {
    if (!this.io) return;
    for (const n of items) {
      this.emitToUser({ userType: n.recipientType, userId: n.recipientId }, "notification:new", {
        id: n.id, kind: n.kind, title: n.title, body: n.body, complaintId: n.complaintId ?? null, link: n.link ?? null, read: false, createdAt: n.createdAt ?? new Date(),
      });
    }
  }
}
