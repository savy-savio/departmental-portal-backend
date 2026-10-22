import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac, randomBytes } from "node:crypto";
import { LecturerAuthService, type AuthLecturerRow, type LecturerAuthStore } from "../src/services/lecturer/auth.service";
import { sha256 } from "../src/utils/crypto";
import { AppError } from "../src/utils/AppError";

/* The SAME engine as the lecturers', configured with role "HOD", its own store and its own token audience. */
const SECRET = "test-secret";
const sign = (aud: string, sub: string, iat: number, exp: number) => {
  const body = Buffer.from(JSON.stringify({ aud, sub, iat, exp })).toString("base64url");
  return `${body}.${createHmac("sha256", SECRET).update(body).digest("base64url")}`;
};
function world() {
  const clock = { now: new Date("2026-10-10T10:00:00Z") };
  const sec = () => Math.floor(clock.now.getTime() / 1000);
  const rows: AuthLecturerRow[] = [];
  const depts = new Map([["d-csc", { id: "d-csc", name: "Computer Science", code: "CSC", isActive: true }]]);
  const store: LecturerAuthStore = {
    findByEmail: async (e) => rows.find((r) => r.email === e) ?? null, findById: async (id) => rows.find((r) => r.id === id) ?? null,
    findByActivationHash: async (h) => rows.find((r) => r.activationTokenHash === h) ?? null, findByResetHash: async (h) => rows.find((r) => r.resetPasswordTokenHash === h) ?? null,
    update: async (id, set, unset = []) => { const r = rows.find((x) => x.id === id)!; Object.assign(r, set); for (const k of unset) delete (r as unknown as Record<string, unknown>)[k as string]; },
    consumeToken: async (id, field, hash) => { const r = rows.find((x) => x.id === id)!; if (r[field] !== hash) return false; delete r[field]; return true; },
    getDepartment: async (id) => depts.get(id) ?? null,
  };
  const auth = new LecturerAuthService({
    store, now: () => new Date(clock.now), role: "HOD", notRoleCode: "NOT_A_HOD",
    hashPassword: async (p) => `h:${p}`, verifyPassword: async (p, h) => h === `h:${p}`, fakePasswordCheck: async () => undefined,
    signAccessToken: (id) => sign("hod-access", id, sec(), sec() + 3600),
    verifyAccessToken: (t) => {
      const [body, sig] = t.split(".");
      if (!body || sig !== createHmac("sha256", SECRET).update(body).digest("base64url")) throw new AppError(401, "Invalid authentication token.");
      const p = JSON.parse(Buffer.from(body, "base64url").toString());
      if (p.aud !== "hod-access") throw new AppError(401, "Invalid authentication token."); // lecturer / student tokens don't verify
      if (p.exp < sec()) throw new AppError(401, "Your session has expired. Please log in again.");
      return { lecturerId: p.sub, issuedAt: p.iat };
    },
    generateToken: () => randomBytes(16).toString("hex"), resetTtlMinutes: 30, sendResetEmail: async () => undefined,
  });
  const add = (over: Partial<AuthLecturerRow> = {}) => { const r: AuthLecturerRow = { id: `h${rows.length + 1}`, firstName: "Hope", lastName: "Chief", email: `h${rows.length + 1}@uni.example`, staffId: `HOD-${rows.length + 1}`, departmentId: "d-csc", role: "HOD", status: "ACTIVE", passwordHash: "h:Correct-pw1", failedLoginAttempts: 0, ...over }; rows.push(r); return r; };
  return { auth, add, clock, sec, depts };
}
const reject = async (p: Promise<unknown>) => { try { await p; } catch (e) { const x = e as AppError; return { status: x.statusCode, code: x.code }; } throw new Error("expected rejection"); };

test("valid HOD login: token + public profile with role HOD and the department; no secrets", async () => {
  const w = world(); const h = w.add({ email: "hope@uni.example" });
  const res = await w.auth.login("hope@uni.example", "Correct-pw1");
  assert.deepEqual([res.lecturer.role, res.lecturer.department.code], ["HOD", "CSC"]);
  assert.ok(!JSON.stringify(res).includes("h:Correct"));
  const ctx = await w.auth.authenticate(res.token);
  assert.deepEqual([ctx.actor.lecturerId, ctx.actor.departmentId], [h.id, "d-csc"]); // identity + department come from the database record
});
test("invalid login, lockout, inactive / invited / replaced HODs", async () => {
  const w = world(); w.add({ email: "a@uni.example" }); w.add({ email: "s@uni.example", status: "SUSPENDED" }); w.add({ email: "i@uni.example", status: "INVITED" });
  assert.deepEqual(await reject(w.auth.login("a@uni.example", "bad")), { status: 401, code: "INVALID_CREDENTIALS" });
  assert.deepEqual(await reject(w.auth.login("ghost@uni.example", "bad")), { status: 401, code: "INVALID_CREDENTIALS" });
  assert.equal((await reject(w.auth.login("s@uni.example", "Correct-pw1"))).code, "ACCOUNT_INACTIVE");
  assert.equal((await reject(w.auth.login("i@uni.example", "Correct-pw1"))).code, "ACCOUNT_NOT_ACTIVATED");
  for (let i = 0; i < 5; i++) await reject(w.auth.login("a@uni.example", "bad"));
  assert.equal((await reject(w.auth.login("a@uni.example", "Correct-pw1"))).code, "ACCOUNT_LOCKED");
});
test("inactive HOD: a suspended / replaced HOD's live token stops working on the next request", async () => {
  const w = world(); const h = w.add({ email: "a@uni.example" });
  const { token } = await w.auth.login("a@uni.example", "Correct-pw1");
  h.status = "SUSPENDED"; // (a replaced HOD is mapped to SUSPENDED by the Mongo store)
  assert.equal((await reject(w.auth.authenticate(token))).code, "ACCOUNT_INACTIVE");
});
test("JWT validation: tampered, expired, other-audience (lecturer / student) tokens are refused", async () => {
  const w = world(); const h = w.add({ email: "a@uni.example" });
  const good = (await w.auth.login("a@uni.example", "Correct-pw1")).token;
  assert.equal((await reject(w.auth.authenticate(good.slice(0, -2) + "xx"))).status, 401);
  assert.equal((await reject(w.auth.authenticate("garbage"))).status, 401);
  assert.equal((await reject(w.auth.authenticate(sign("lecturer-access", h.id, w.sec(), w.sec() + 3600)))).status, 401);
  assert.equal((await reject(w.auth.authenticate(sign("student-access", h.id, w.sec(), w.sec() + 3600)))).status, 401);
  assert.equal((await reject(w.auth.authenticate(sign("hod-access", h.id, w.sec() - 7200, w.sec() - 3600)))).status, 401);
  assert.equal((await reject(w.auth.authenticate(sign("hod-access", "ghost", w.sec(), w.sec() + 3600)))).status, 401);
});
test("a LECTURER-role record can never authenticate as HOD (and the department must be active)", async () => {
  const w = world(); const l = w.add({ email: "l@uni.example", role: "LECTURER" });
  assert.equal((await reject(w.auth.authenticate(sign("hod-access", l.id, w.sec(), w.sec() + 3600)))).code, "NOT_A_HOD");
  const h = w.add({ email: "h@uni.example" });
  const { token } = await w.auth.login("h@uni.example", "Correct-pw1");
  w.depts.get("d-csc")!.isActive = false;
  assert.equal((await reject(w.auth.authenticate(token))).code, "DEPARTMENT_INACTIVE");
  void h;
});
test("activation (the only way an invited HOD gets a password) is single-use and expires; password change kills old tokens", async () => {
  const w = world(); const raw = "a".repeat(32);
  w.add({ email: "n@uni.example", status: "INVITED", passwordHash: undefined, activationTokenHash: sha256(raw), activationExpires: new Date(w.clock.now.getTime() + 3600_000) });
  const res = await w.auth.activate(raw, "New-pw-123");
  assert.equal(res.lecturer.status, "ACTIVE");
  assert.equal((await reject(w.auth.activate(raw, "Other-pw-1"))).code, "ACTIVATION_INVALID");
  const old = (await w.auth.login("n@uni.example", "New-pw-123")).token;
  w.clock.now = new Date(w.clock.now.getTime() + 2000);
  await w.auth.changePassword(res.lecturer.id, "New-pw-123", "Newer-pw-456");
  assert.equal((await reject(w.auth.authenticate(old))).status, 401);
});
