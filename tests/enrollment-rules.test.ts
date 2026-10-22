import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateEligibility, sessionStartYear, CourseScope, StudentScope, TermScope } from "../src/services/enrollment-rules";

const student: StudentScope = { departmentId: "csc", level: "200", academicSession: "2026/2027" };
const term: TermScope = { academicSession: "2026/2027", semester: "FIRST" };
const course = (over: Partial<CourseScope> = {}): CourseScope => ({
  departmentId: "csc",
  level: "200",
  semester: "FIRST",
  academicSession: "2026/2027",
  status: "ACTIVE",
  ...over,
});
const reason = (r: ReturnType<typeof evaluateEligibility>) => (r.ok ? "" : r.reason);

test("session start year", () => assert.equal(sessionStartYear("2026/2027"), 2026));

test("regular: same department, level, term is allowed (prefix does not matter)", () => {
  assert.equal(evaluateEligibility(student, course(), term, "REGULAR").ok, true);
});

test("regular: other department is refused", () => {
  assert.equal(evaluateEligibility(student, course({ departmentId: "mls" }), term, "REGULAR").ok, false);
  assert.equal(evaluateEligibility(student, course({ departmentId: "mls" }), term, "CARRYOVER").ok, false);
});

test("regular: wrong level, wrong semester, archived, old session are refused", () => {
  assert.equal(evaluateEligibility(student, course({ level: "300" }), term, "REGULAR").ok, false);
  assert.equal(evaluateEligibility(student, course({ level: "100" }), term, "REGULAR").ok, false);
  assert.equal(evaluateEligibility(student, course({ semester: "SECOND" }), term, "REGULAR").ok, false);
  assert.equal(evaluateEligibility(student, course({ status: "ARCHIVED" }), term, "REGULAR").ok, false);
  assert.equal(evaluateEligibility(student, course({ academicSession: "2025/2026" }), term, "REGULAR").ok, false);
});

test("carryover: lower-level course in the current semester is allowed", () => {
  assert.equal(evaluateEligibility(student, course({ level: "100" }), term, "CARRYOVER").ok, true);
});

test("carryover: same-level course from an earlier session is allowed, even if archived", () => {
  assert.equal(evaluateEligibility(student, course({ academicSession: "2025/2026", status: "ARCHIVED" }), term, "CARRYOVER").ok, true);
});

test("carryover: higher level, other semester, or a plain regular course is refused", () => {
  assert.equal(evaluateEligibility(student, course({ level: "300", academicSession: "2025/2026" }), term, "CARRYOVER").ok, false);
  assert.equal(evaluateEligibility(student, course({ level: "100", semester: "SECOND" }), term, "CARRYOVER").ok, false);
  assert.match(reason(evaluateEligibility(student, course(), term, "CARRYOVER")), /regular/i);
});

test("student record behind the current session is refused", () => {
  const old: StudentScope = { ...student, academicSession: "2025/2026" };
  assert.match(reason(evaluateEligibility(old, course(), term, "REGULAR")), /academic record/i);
});
