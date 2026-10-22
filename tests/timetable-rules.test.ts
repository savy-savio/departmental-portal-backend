import { test } from "node:test";
import assert from "node:assert/strict";
import { dayOfDate, slotsOverlap, validateSlot } from "../src/services/representative/timetable-rules";

test("dayOfDate maps real dates and rejects fake ones", () => {
  assert.equal(dayOfDate("2026-10-14"), "WED");
  assert.equal(dayOfDate("2026-02-30"), null);
  assert.equal(dayOfDate("14-10-2026"), null);
});
test("validateSlot: times must be HH:mm and end after start; a weekday or date is needed; they must agree", () => {
  assert.deepEqual(validateSlot({ dayOfWeek: "MON", startTime: "08:00", endTime: "10:00" }).errors, []);
  assert.ok(validateSlot({ dayOfWeek: "MON", startTime: "10:00", endTime: "10:00" }).errors.length);
  assert.ok(validateSlot({ dayOfWeek: "MON", startTime: "8:00", endTime: "10:00" }).errors.length);
  assert.ok(validateSlot({ startTime: "08:00", endTime: "10:00" }).errors.some((e) => /dayOfWeek or a date/.test(e)));
  assert.equal(validateSlot({ date: "2026-10-14", startTime: "08:00", endTime: "09:00" }).dayOfWeek, "WED");
  assert.ok(validateSlot({ dayOfWeek: "MON", date: "2026-10-14", startTime: "08:00", endTime: "09:00" }).errors.length);
});
test("slotsOverlap: same day + overlapping times only; weekly vs one-off don't clash", () => {
  const w = (day: "MON" | "TUE", s: string, e: string) => ({ dayOfWeek: day, startTime: s, endTime: e });
  assert.equal(slotsOverlap(w("MON", "08:00", "10:00"), w("MON", "09:00", "11:00")), true);
  assert.equal(slotsOverlap(w("MON", "08:00", "10:00"), w("MON", "10:00", "11:00")), false);
  assert.equal(slotsOverlap(w("MON", "08:00", "10:00"), w("TUE", "08:00", "10:00")), false);
  assert.equal(slotsOverlap({ dayOfWeek: "WED", date: "2026-10-14", startTime: "08:00", endTime: "10:00" }, w("MON", "08:00", "10:00")), false);
});
