import { test } from "node:test";
import assert from "node:assert/strict";
import { namesMatch } from "../src/utils/name";

test("ignores case, whitespace and order", () => {
  assert.ok(namesMatch("  john   DOE ", "John", "Doe"));
  assert.ok(namesMatch("Doe John", "John", "Doe"));
});

test("ignores accents, hyphens and apostrophes", () => {
  assert.ok(namesMatch("Ọlá Ade Bayo", "Ola", "Ade-Bayo"));
  assert.ok(namesMatch("Mary O'Neil", "Mary", "ONeil"));
});

test("does not match a different or partial name", () => {
  assert.equal(namesMatch("John", "John", "Doe"), false);
  assert.equal(namesMatch("Jane Doe", "John", "Doe"), false);
  assert.equal(namesMatch("John Michael Doe", "John", "Doe"), false);
  assert.equal(namesMatch("Joh Doe", "John", "Doe"), false);
});
