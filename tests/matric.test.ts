import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeMatricNumber, parseMatricNumber } from "../src/services/matric.service";

test("parses a Computer Science matric number", () => {
  const p = parseMatricNumber("25/208CSC/987");
  assert.deepEqual(p, {
    normalized: "25/208CSC/987",
    entryYear: "25",
    programmeNumber: "208",
    departmentCode: "CSC",
    serial: "987",
  });
});

test("parses any department code, not only CSC/MLS", () => {
  assert.equal(parseMatricNumber("24/101PHY/045")?.departmentCode, "PHY");
  assert.equal(parseMatricNumber("23/310BCH/1200")?.departmentCode, "BCH");
});

test("normalises case, whitespace and separators", () => {
  assert.equal(normalizeMatricNumber("  25 / 208csc / 987 "), "25/208CSC/987");
  assert.equal(normalizeMatricNumber("25\\208mls\\123"), "25/208MLS/123");
  assert.equal(parseMatricNumber("25/208mls/123")?.normalized, "25/208MLS/123");
});

test("rejects malformed matric numbers", () => {
  for (const bad of ["", "CSC/987", "25/208/987", "25/208CSC", "2025/208CSC/987", "25/208CSC/987/1", "25/208C5C/987", "25/208CSC/abc"]) {
    assert.equal(parseMatricNumber(bad), null, `should reject "${bad}"`);
  }
});
