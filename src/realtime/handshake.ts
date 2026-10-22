import { ROLE_HINTS, type RealtimeIdentity, type RealtimeUserType } from "./rooms";

/** Verifies a token for ONE audience and returns who it belongs to. Throws if the token or the account is not acceptable. */
export type Authenticator = (token: string) => Promise<RealtimeIdentity>;
export type Authenticators = Record<RealtimeUserType, Authenticator>;
export interface HandshakeData { auth?: Record<string, unknown>; query?: Record<string, unknown> }

export class HandshakeError extends Error {
  constructor(public readonly code: "AUTH_REQUIRED" | "AUTH_FAILED" | "RATE_LIMITED", message: string) { super(message); }
}

/**
 * Socket authentication = the same token rules as the HTTP API, for the audience the client names.
 *  - the token comes ONLY from `handshake.auth` (never the URL query string, which ends up in access logs and browser history);
 *  - `role` just picks the verifier ("student" | "lecturer" | "hod"); a token of another audience simply fails to verify;
 *  - every failure gives the same generic message, so nothing is revealed about accounts or why a token was refused.
 */
export function createHandshakeAuth(auth: Authenticators) {
  return async function authenticate(h: HandshakeData): Promise<RealtimeIdentity> {
    const token = typeof h.auth?.token === "string" ? h.auth.token.trim() : "";
    const role = typeof h.auth?.role === "string" ? ROLE_HINTS[h.auth.role.toLowerCase()] : undefined;
    if (!token || token.length > 4096) throw new HandshakeError("AUTH_REQUIRED", "Authentication required.");
    if (!role) throw new HandshakeError("AUTH_REQUIRED", "Authentication required.");
    try {
      const who = await auth[role](token);
      if (who.userType !== role) throw new Error("audience mismatch"); // defence in depth: the verifier must return the audience that was asked for
      return who;
    } catch {
      throw new HandshakeError("AUTH_FAILED", "Authentication failed.");
    }
  };
}

/** Failed handshakes per IP in a sliding window: stops token guessing / hammering without touching normal users. */
export class FailedAuthLimiter {
  private hits = new Map<string, number[]>();
  constructor(private readonly max = 20, private readonly windowMs = 60_000, private readonly now: () => number = Date.now) {}
  private recent(ip: string) { const t = this.now() - this.windowMs; const r = (this.hits.get(ip) ?? []).filter((x) => x > t); this.hits.set(ip, r); return r; }
  blocked(ip: string) { return this.recent(ip).length >= this.max; }
  recordFailure(ip: string) { this.recent(ip).push(this.now()); if (this.hits.size > 10_000) this.hits.clear(); }
}
