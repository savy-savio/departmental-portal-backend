import { test } from "node:test";
import assert from "node:assert/strict";
import { hashAttendanceCode } from "../src/utils/crypto";

test("attendance codes ignore case and surrounding spaces", () => {
  assert.equal(hashAttendanceCode(" ab12 "), hashAttendanceCode("AB12"));
});
test("different codes hash differently", () => {
  assert.notEqual(hashAttendanceCode("4821"), hashAttendanceCode("4822"));
});
