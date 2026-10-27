import { test, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import express, { type Request, type Response } from "express";
import { forgotPasswordLimiter, loginLimiter, verifyLimiter } from "../src/middleware/rateLimiters";

/**
 * The auth limiters are keyed by the identity being attempted (email / matric number), not by IP, and count only FAILED attempts (forgot-password
 * counts everything). Here the REAL limiters run in a tiny Express app. Every request below comes from the same IP (127.0.0.1), like a whole
 * class on one campus Wi-Fi.
 */
const app = express();
app.use(express.json());
app.post("/login", loginLimiter, (req: Request, res: Response) => (req.body.password === "good" ? res.json({ ok: true }) : res.status(401).json({ ok: false })));
app.post("/verify", verifyLimiter, (req: Request, res: Response) => (req.body.fullName === "Real Name" ? res.json({ ok: true }) : res.status(404).json({ ok: false })));
app.post("/forgot", forgotPasswordLimiter, (_req: Request, res: Response) => res.json({ ok: true }));
const server = http.createServer(app).listen(0);
const base = () => `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
after(() => { server.close(); });

const post = async (path: string, body: unknown) => {
  const r = await fetch(`${base()}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: r.status, message: ((await r.json()) as { message?: string }).message };
};

test("R1. One student's wrong passwords lock only that email: a classmate on the same Wi-Fi is never blocked", async () => {
  for (let i = 0; i < 10; i++) assert.equal((await post("/login", { email: "ada@school.edu", password: "bad" })).status, 401, `attempt ${i + 1}`);
  const blocked = await post("/login", { email: "ada@school.edu", password: "bad" });
  assert.deepEqual([blocked.status, blocked.message], [429, "Too many login attempts. Please try again later."]);
  // the same email written differently is the same person
  assert.equal((await post("/login", { email: "  ADA@School.edu ", password: "bad" })).status, 429);
  // ...but a different student on the same IP is untouched
  assert.equal((await post("/login", { email: "ben@school.edu", password: "bad" })).status, 401);
  assert.equal((await post("/login", { email: "ben@school.edu", password: "good" })).status, 200);
});

test("R2. Successful sign-ins never use up the allowance; only failures count", async () => {
  for (let i = 0; i < 25; i++) assert.equal((await post("/login", { email: "cy@school.edu", password: "good" })).status, 200, `login ${i + 1}`);
  for (let i = 0; i < 10; i++) assert.equal((await post("/login", { email: "cy@school.edu", password: "bad" })).status, 401, `fail ${i + 1}`); // still has all 10 failures
  assert.equal((await post("/login", { email: "cy@school.edu", password: "bad" })).status, 429);
});

test("R3. Identity checks are keyed by matric number, with their own message", async () => {
  for (let i = 0; i < 10; i++) assert.equal((await post("/verify", { fullName: "Wrong", matricNumber: "CSC/2020/001" })).status, 404);
  const blocked = await post("/verify", { fullName: "Wrong", matricNumber: "csc/2020/001" }); // matric numbers are not case sensitive
  assert.deepEqual([blocked.status, blocked.message], [429, "Too many verification attempts for this matric number. Please try again in a few minutes."]);
  assert.equal((await post("/verify", { fullName: "Real Name", matricNumber: "CSC/2020/002" })).status, 200); // another student, same IP
});

test("R4. Forgot-password counts EVERY request for an email (each one sends a mail), 5 an hour, per email", async () => {
  for (let i = 0; i < 5; i++) assert.equal((await post("/forgot", { email: "dee@school.edu" })).status, 200, `request ${i + 1}`);
  const blocked = await post("/forgot", { email: "dee@school.edu" });
  assert.deepEqual([blocked.status, blocked.message], [429, "Too many reset requests for this email. Please try again later."]);
  assert.equal((await post("/forgot", { email: "eve@school.edu" })).status, 200);
});

test("R5. A request with no email can't dodge the limit: it is counted under the IP instead", async () => {
  for (let i = 0; i < 10; i++) assert.equal((await post("/login", { password: "bad" })).status, 401);
  assert.equal((await post("/login", { password: "bad" })).status, 429);
});
