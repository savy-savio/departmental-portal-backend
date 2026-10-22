import { test } from "node:test";
import assert from "node:assert/strict";
import { sniffImage } from "../src/utils/image";

test("recognises JPEG, PNG and WebP by magic bytes", () => {
  assert.equal(sniffImage(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]))?.ext, "jpg");
  assert.equal(sniffImage(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]))?.ext, "png");
  const webp = Buffer.concat([Buffer.from("RIFF"), Buffer.from([1, 2, 3, 4]), Buffer.from("WEBP")]);
  assert.equal(sniffImage(webp)?.ext, "webp");
});

test("rejects non-images even if they would be named .jpg", () => {
  assert.equal(sniffImage(Buffer.from("<script>alert(1)</script>")), null);
  assert.equal(sniffImage(Buffer.from("GIF89a....")), null);
  assert.equal(sniffImage(Buffer.alloc(0)), null);
});
