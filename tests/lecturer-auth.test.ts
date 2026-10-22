import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac, randomBytes } from "node:crypto";
import { LecturerAuthService, type AuthLecturerRow, type LecturerAuthStore } from "../src/services/lecturer/auth.service";
import { sha256 } from "../src/utils/crypto";
import { AppError } from "../src/utils/AppError";

/* A tiny HMAC token stands in for the JWT library (not installable here); the audience check is what matters. */
const SECRET = "test-secret";
const sign = (aud: string, sub: string, iat: number, exp: number) => {
  const body = Buffer.from(JSON.stringify({ aud, sub, iat, exp })).toString("base64url");
  return `${body}.${createHmac("sha256", SECRET).update(body).digest("base64url")}`;
};

function world() {
  const clock = { now: new Date("2026-10-10T10:00:00Z") };
  const sec = () => Math.floor(clock.now.getTime() / 1000);
  const rows: AuthLecturerRow[] = [];
  const depts = new Map([["d-csc", { id: "d-csc", name: "Computer Science", code: "CSC", isActive: true }], ["d-mls", { id: "d-mls", name: "MLS", code: "MLS", isActive: true }]]);
  const store: LecturerAuthStore = {
    findByEmail: async (e) => rows.find((r) => r.email === e) ?? null,
    findById: async (id) => rows.find((r) => r.id === id) ?? null,
    findByActivationHash: async (h) => rows.find((r) => r.activationTokenHash === h) ?? null,
    findByResetHash: async (h) => rows.find((r) => r.resetPasswordTokenHash === h) ?? null,
    update: async (id, set, unset = []) => { const r = rows.find((x) => x.id === id)!; Object.assign(r, set); for (const k of unset) delete (r as unknown as Record<string, unknown>)[k as string]; },
    consumeToken: async (id, field, hash) => { const r = rows.find((x) => x.id === id)!; if (r[field] !== hash) return false; delete r[field]; return true; },
    getDepartment: async (id) => depts.get(id) ?? null,
  };
  const emails: { to: string; token: string }[] = [];
  const auth = new LecturerAuthService({
    store, now: () => new Date(clock.now),
    hashPassword: async (p) => `h:${p}`, verifyPassword: async (p, h) => h === `h:${p}`, fakePasswordCheck: async () => undefined,
    signAccessToken: (id) => sign("lecturer-access", id, sec(), sec() + 3600),
    verifyAccessToken: (t) => {
      const [body, sig] = t.split(".");
      if (!body || sig !== createHmac("sha256", SECRET).update(body).digest("base64url")) throw new AppError(401, "Invalid authentication token.");
      const p = JSON.parse(Buffer.from(body, "base64url").toString());
      if (p.aud !== "lecturer-access") throw new AppError(401, "Invalid authentication token."); // e.g. a student token
      if (p.exp < sec()) throw new AppError(401, "Your session has expired. Please log in again.");
      return { lecturerId: p.sub, issuedAt: p.iat };
    },
    generateToken: () => randomBytes(16).toString("hex"), resetTtlMinutes: 30,
    sendResetEmail: async (to, _n, token) => void emails.push({ to, token }),
  });
  const add = (over: Partial<AuthLecturerRow> = {}): AuthLecturerRow => {
    const r: AuthLecturerRow = { id: `l${rows.length + 1}`, firstName: "Ada", lastName: "Staff", email: `l${rows.length + 1}@uni.example`, staffId: `S-${rows.length + 1}`, departmentId: "d-csc", role: "LECTURER", status: "ACTIVE", passwordHash: "h:Correct-pw1", failedLoginAttempts: 0, ...over };
    rows.push(r);
    return r;
  };
  return { auth, rows, add, clock, emails, depts, sec };
}
const reject = async (p: Promise<unknown>) => { try { await p; } catch (e) { const x = e as AppError; return { status: x.statusCode, code: x.code }; } throw new Error("expected rejection"); };

test("valid lecturer login returns a token + public profile (no secrets)", async () => {
  const w = world(); const l = w.add({ email: "a@uni.example" });
  const res = await w.auth.login("a@uni.example", "Correct-pw1");
  assert.equal(res.lecturer.department.code, "CSC");
  assert.equal(res.lecturer.role, "LECTURER");
  assert.ok(!JSON.stringify(res).includes("passwordHash") && !JSON.stringify(res).includes("h:Correct"));
  assert.equal((await w.auth.authenticate(res.token)).actor.lecturerId, l.id);
});
test("invalid login: wrong password and unknown email give the same answer", async () => {
  const w = world(); w.add({ email: "a@uni.example" });
  assert.deepEqual(await reject(w.auth.login("a@uni.example", "nope")), { status: 401, code: "INVALID_CREDENTIALS" });
  assert.deepEqual(await reject(w.auth.login("ghost@uni.example", "nope")), { status: 401, code: "INVALID_CREDENTIALS" });
});
test("5 wrong passwords lock the account; the lock expires", async () => {
  const w = world(); w.add({ email: "a@uni.example" });
  for (let i = 0; i < 5; i++) await reject(w.auth.login("a@uni.example", "bad"));
  assert.equal((await reject(w.auth.login("a@uni.example", "Correct-pw1"))).code, "ACCOUNT_LOCKED");
  w.clock.now = new Date(w.clock.now.getTime() + 16 * 60_000);
  assert.ok((await w.auth.login("a@uni.example", "Correct-pw1")).token);
});
test("inactive lecturers: suspended and not-yet-activated cannot log in (state revealed only after the right password); suspension kills live tokens", async () => {
  const w = world();
  w.add({ email: "s@uni.example", status: "SUSPENDED" }); w.add({ email: "i@uni.example", status: "INVITED" });
  assert.equal((await reject(w.auth.login("s@uni.example", "Correct-pw1"))).code, "ACCOUNT_INACTIVE");
  assert.equal((await reject(w.auth.login("i@uni.example", "Correct-pw1"))).code, "ACCOUNT_NOT_ACTIVATED");
  assert.equal((await reject(w.auth.login("s@uni.example", "wrong"))).code, "INVALID_CREDENTIALS"); // no state leak without the password
  const live = w.add({ email: "x@uni.example" });
  const { token } = await w.auth.login("x@uni.example", "Correct-pw1");
  live.status = "SUSPENDED";
  assert.equal((await reject(w.auth.authenticate(token))).code, "ACCOUNT_INACTIVE"); // checked against the database on every request
});
test("JWT validation: tampered, expired, other-audience (student) and unknown-subject tokens are refused", async () => {
  const w = world(); const l = w.add({ email: "a@uni.example" });
  const good = (await w.auth.login("a@uni.example", "Correct-pw1")).token;
  assert.equal((await reject(w.auth.authenticate(good.slice(0, -2) + "xx"))).status, 401);
  assert.equal((await reject(w.auth.authenticate("garbage"))).status, 401);
  assert.equal((await reject(w.auth.authenticate(sign("student-access", l.id, w.sec(), w.sec() + 3600)))).status, 401); // a student token is not a lecturer token
  assert.equal((await reject(w.auth.authenticate(sign("lecturer-access", l.id, w.sec() - 7200, w.sec() - 3600)))).status, 401);
  assert.equal((await reject(w.auth.authenticate(sign("lecturer-access", "nobody", w.sec(), w.sec() + 3600)))).status, 401);
});
test("role / department come from the database, never the token; an inactive department blocks access", async () => {
  const w = world(); const l = w.add({ email: "a@uni.example" });
  const { token } = await w.auth.login("a@uni.example", "Correct-pw1");
  assert.equal((await w.auth.authenticate(token)).actor.departmentId, "d-csc");
  l.role = "HOD" as never; // someone who is no longer a plain lecturer record
  assert.equal((await reject(w.auth.authenticate(token))).code, "NOT_A_LECTURER");
  l.role = "LECTURER";
  w.depts.get("d-csc")!.isActive = false;
  assert.equal((await reject(w.auth.authenticate(token))).code, "DEPARTMENT_INACTIVE");
});
test("activation: one-time token, expiry, then normal login; no self-registration path", async () => {
  const w = world(); const raw = "a".repeat(32);
  w.add({ email: "n@uni.example", status: "INVITED", passwordHash: undefined, activationTokenHash: sha256(raw), activationExpires: new Date(w.clock.now.getTime() + 3600_000) });
  assert.equal((await reject(w.auth.activate("b".repeat(32), "New-pw-123"))).code, "ACTIVATION_INVALID");
  const res = await w.auth.activate(raw, "New-pw-123");
  assert.equal(res.lecturer.status, "ACTIVE");
  assert.equal((await reject(w.auth.activate(raw, "Other-pw-1"))).code, "ACTIVATION_INVALID"); // single use
  assert.ok((await w.auth.login("n@uni.example", "New-pw-123")).token);
  w.add({ email: "e@uni.example", status: "INVITED", passwordHash: undefined, activationTokenHash: sha256("c".repeat(32)), activationExpires: new Date(w.clock.now.getTime() - 1000) });
  assert.equal((await reject(w.auth.activate("c".repeat(32), "New-pw-123"))).code, "ACTIVATION_INVALID"); // expired
});
test("forgot / reset password: silent for unknown emails, hashed single-use token, old tokens die", async () => {
  const w = world(); const l = w.add({ email: "a@uni.example" });
  await w.auth.forgotPassword("ghost@uni.example");
  assert.equal(w.emails.length, 0);
  const old = (await w.auth.login("a@uni.example", "Correct-pw1")).token;
  await w.auth.forgotPassword("a@uni.example");
  const raw = w.emails[0].token;
  assert.equal(l.resetPasswordTokenHash, sha256(raw)); // only the hash is stored
  w.clock.now = new Date(w.clock.now.getTime() + 1000);
  await w.auth.resetPassword(raw, "Brand-new-1");
  assert.equal((await reject(w.auth.resetPassword(raw, "Again-new-1"))).code, "RESET_INVALID");
  assert.equal((await reject(w.auth.authenticate(old))).status, 401); // password change invalidates earlier tokens
  assert.ok((await w.auth.login("a@uni.example", "Brand-new-1")).token);
});
