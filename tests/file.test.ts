import { test } from "node:test";
import assert from "node:assert/strict";
import { safeDisplayName, sniffSubmissionFile } from "../src/utils/file";

test("accepts PDF, images and DOCX by content", () => {
  assert.equal(sniffSubmissionFile(Buffer.from("%PDF-1.7 ..."), "a.pdf")?.ext, "pdf");
  assert.equal(sniffSubmissionFile(Buffer.from([0xff, 0xd8, 0xff, 0xe0]), "a.jpg")?.resourceType, "image");
  assert.equal(sniffSubmissionFile(Buffer.from([0x50, 0x4b, 0x03, 0x04, 0]), "essay.DOCX")?.ext, "docx");
});

test("rejects other zips, scripts and mislabelled files", () => {
  assert.equal(sniffSubmissionFile(Buffer.from([0x50, 0x4b, 0x03, 0x04, 0]), "archive.zip"), null);
  assert.equal(sniffSubmissionFile(Buffer.from("<?php echo 1;"), "shell.pdf"), null);
  assert.equal(sniffSubmissionFile(Buffer.from("MZ...."), "x.pdf"), null);
});

test("display names lose paths and odd characters", () => {
  assert.equal(safeDisplayName("../../etc/passwd"), "passwd");
  assert.equal(safeDisplayName("my<script>.pdf"), "my_script_.pdf");
});
