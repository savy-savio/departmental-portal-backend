import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { CSC as HCSC, hodC, hodM, makeHodWorld, meta as hmeta } from "./helpers/hod-world";
import { actor, makeLecturerWorld, MLS as LMLS, meta, rejection, T0 } from "./helpers/lecturer-world";

const read = (p: string) => fs.readFileSync(path.resolve(__dirname, "..", p), "utf8");
const q = (over: object = {}) => ({ page: 1, limit: 20, ...over });
const lecA = actor("lecA"), lecB = actor("lecB"), lecC = actor("lecC"), lecM = actor("lecM", LMLS);

/**
 * The real HodService and the real LecturerService over the SAME complaint records: the HOD forwards, the lecturer acts, the HOD sees it.
 * (One shared array stands in for the single Complaint collection.)
 */
function world() {
  const h = makeHodWorld();
  const l = makeLecturerWorld();
  l.store.complaints = h.store.complaints;
  h.store.lecturers.push({ id: "lecB", firstName: "lecB", lastName: "Staff", email: "lecB@uni.example", staffId: "CSC-002", departmentId: HCSC, role: "LECTURER", status: "ACTIVE" } as never);
  return { h, l, hod: h.svc, lec: l.svc, complaints: h.store.complaints };
}
/** Complaint "1" (CSC201, john), "2" (department, ada) and MLS "m1" (mia) exist; the HOD forwards "1" and "2" to lecA and "m1" to lecM. */
async function forwarded() {
  const w = world();
  await w.hod.assignComplaint(hodC, "1", { lecturerId: "lecA", note: "Please check the marks" }, hmeta);
  await w.hod.assignComplaint(hodC, "2", { lecturerId: "lecA", note: "Is this clash real?" }, hmeta);
  await w.hod.assignComplaint(hodM, "m1", { lecturerId: "lecM", note: "Lab access" }, hmeta);
  return w;
}

/* ============================ viewing ============================ */
test("1. A forwarded complaint appears in that lecturer's list with the permitted details (and no student contact data)", async () => {
  const w = await forwarded();
  const list = await w.lec.listComplaints(lecA, q());
  assert.deepEqual(list.items.map((c) => c.id).sort(), ["1", "2"]);
  const c = list.items.find((x) => x.id === "1")!;
  assert.deepEqual([c.title, c.status, c.hodMessage, c.type], ["Missing marks entry for CSC201", "ASSIGNED", "Please check the marks", "COURSE"]);
  assert.deepEqual(c.student, { name: "John Doe", matricNumber: "25/208CSC/987" });
  assert.equal(c.course?.courseCode, "CSC201");
  assert.ok(c.forwardedAt instanceof Date && c.submittedAt instanceof Date && typeof c.description === "string");
  assert.deepEqual([c.canRespond, c.canUpdateStatus, c.allowedStatuses], [true, true, ["IN_PROGRESS", "UNDER_REVIEW"]]);
  const json = JSON.stringify(list);
  for (const leak of ["private.example", "+2348000000000", "studentId", "recipient"]) assert.ok(!json.includes(leak), leak);
  assert.equal((await w.lec.listComplaints(lecA, q())).total, 2);
});
test("2. Search, status, course and date filters and pagination", async () => {
  const w = await forwarded();
  assert.deepEqual((await w.lec.listComplaints(lecA, q({ search: "clash" }))).items.map((c) => c.id), ["2"]);
  assert.deepEqual((await w.lec.listComplaints(lecA, q({ search: "25/208CSC/987" }))).items.map((c) => c.id), ["1"]);
  assert.deepEqual((await w.lec.listComplaints(lecA, q({ courseId: w.l.csc201.id }))).items.map((c) => c.id), ["1"]);
  assert.equal((await w.lec.listComplaints(lecA, q({ status: "IN_PROGRESS" }))).total, 0);
  assert.equal((await w.lec.listComplaints(lecA, q({ status: "ASSIGNED" }))).total, 2);
  assert.equal((await w.lec.listComplaints(lecA, q({ from: new Date(T0.getTime() + 60_000) }))).total, 0); // nothing submitted after "now"
  const page = await w.lec.listComplaints(lecA, q({ limit: 1, page: 2 }));
  assert.deepEqual([page.items.length, page.total, page.totalPages], [1, 2, 2]);
});
test("3. A single complaint: full details, forwarding message, attachments as signed links, and the history so far", async () => {
  const w = await forwarded();
  w.complaints.find((c) => c.id === "1")!.attachments.push({ id: "att1", name: "scan.pdf", mimeType: "application/pdf", sizeBytes: 10, publicId: "pub-scan", resourceType: "raw" });
  const c = await w.lec.getComplaint(lecA, "1", meta);
  assert.equal(c.description, "Missing marks entry for CSC201".length ? c.description : "");
  assert.equal(c.hodMessage, "Please check the marks");
  assert.deepEqual(c.attachments.map((a) => a.url), ["https://signed.example/pub-scan"]);
  assert.deepEqual(c.timeline.map((e) => [e.status, e.by.role]), [["SUBMITTED", null], ["ASSIGNED", "HOD"]]);
});

/* ============================ isolation ============================ */
test("4. A lecturer cannot see, read, answer or update another lecturer's complaint (404, audited); same-course colleagues too", async () => {
  const w = await forwarded();
  assert.equal((await w.lec.listComplaints(lecB, q())).total, 0);
  assert.equal((await w.lec.listComplaints(lecC, q())).total, 0); // lecC teaches CSC201 too, but "1" was forwarded to lecA only
  for (const who of [lecB, lecC]) {
    for (const p of [w.lec.getComplaint(who, "1"), w.lec.complaintHistory(who, "1"), w.lec.respondToComplaint(who, "1", { message: "I will handle it" }), w.lec.setComplaintStatus(who, "1", { status: "IN_PROGRESS" })]) {
      assert.equal((await rejection(p)).status, 404);
    }
  }
  assert.equal(w.complaints.find((c) => c.id === "1")!.status, "ASSIGNED");
  assert.equal(w.complaints.find((c) => c.id === "1")!.timeline.length, 2); // nothing was appended
  assert.ok(w.l.store.audit.filter((a) => a.action === "ACCESS_DENIED" && a.resourceType === "COMPLAINT").length >= 8);
});
test("5. Another department's complaints are unreachable in both directions", async () => {
  const w = await forwarded();
  assert.deepEqual((await w.lec.listComplaints(lecM, q())).items.map((c) => c.id), ["m1"]);
  for (const p of [w.lec.getComplaint(lecA, "m1"), w.lec.respondToComplaint(lecA, "m1", { message: "hello there" }), w.lec.setComplaintStatus(lecA, "m1", { status: "IN_PROGRESS" })]) assert.equal((await rejection(p)).status, 404);
  for (const p of [w.lec.getComplaint(lecM, "1"), w.lec.complaintHistory(lecM, "2")]) assert.equal((await rejection(p)).status, 404);
  // even a lecturer whose token says CSC can't reach an MLS complaint that (wrongly) names them as assignee
  w.complaints.find((c) => c.id === "m1")!.assignedLecturer = { id: "lecA", name: "lecA" };
  assert.equal((await rejection(w.lec.getComplaint(lecA, "m1"))).status, 404);
});
test("6. Complaints that were never forwarded, and ids that don't exist, answer 404", async () => {
  const w = world();
  assert.equal((await w.lec.listComplaints(lecA, q())).total, 0);
  assert.equal((await rejection(w.lec.getComplaint(lecA, "1"))).status, 404); // still SUBMITTED
  assert.equal((await rejection(w.lec.getComplaint(lecA, "ffffffffffffffffffffffff"))).status, 404);
  assert.equal((await rejection(w.lec.respondToComplaint(lecA, "ffffffffffffffffffffffff", { message: "hi there" }))).code, "NOT_FOUND");
});

/* ============================ responding ============================ */
test("7. Responding records who, what and when; the first reply acknowledges (ASSIGNED -> IN_PROGRESS); HOD and student are told", async () => {
  const w = await forwarded();
  const r = await w.lec.respondToComplaint(lecA, "1", { message: "I rechecked the script and found the error." }, meta);
  assert.equal(r.status, "IN_PROGRESS");
  const ev = w.complaints.find((c) => c.id === "1")!.timeline.at(-1)!;
  assert.deepEqual([ev.byRole, ev.byId, ev.byName, ev.note, ev.internal, ev.status], ["LECTURER", "lecA", "lecA Staff", "I rechecked the script and found the error.", false, "IN_PROGRESS"]);
  assert.ok(ev.at instanceof Date);
  assert.deepEqual(w.l.hodNotes.map((n) => [n.kind, n.complaintId]), [["RESPONSE", "1"]]);
  assert.deepEqual(w.l.studentNotes.map((n) => [n.studentId, n.kind]), [["john", "RESPONSE"]]);
  const again = await w.lec.respondToComplaint(lecA, "1", { message: "Marks corrected, awaiting your confirmation." });
  assert.equal(again.status, "IN_PROGRESS");
  assert.equal(w.complaints.find((c) => c.id === "1")!.timeline.length, 4);
  assert.deepEqual(w.l.store.audit.filter((a) => a.action === "COMPLAINT_RESPONDED").map((a) => a.resourceId), ["1", "1"]);
});
test("8. A reply can be kept HOD-only: stored as internal, with no student notification", async () => {
  const w = await forwarded();
  await w.lec.respondToComplaint(lecA, "2", { message: "Private note for the HOD.", visibleToStudent: false });
  assert.equal(w.complaints.find((c) => c.id === "2")!.timeline.at(-1)!.internal, true);
  assert.equal(w.l.studentNotes.length, 0);
  assert.equal(w.l.hodNotes.length, 1);
  // and the student-facing complaint view drops internal events
  assert.match(read("src/services/student-complaints.service.ts"), /timeline: c\.timeline\.filter\(\(e\) => !e\.internal\)/);
});
test("9. Replies are refused once the HOD has decided; the HOD's decision is never overwritten", async () => {
  const w = await forwarded();
  await w.hod.setComplaintStatus(hodC, "1", { status: "RESOLVED", resolution: "Corrected by the HOD." }, hmeta);
  const r = await rejection(w.lec.respondToComplaint(lecA, "1", { message: "one more thing" }));
  assert.deepEqual([r.status, r.code], [409, "COMPLAINT_CLOSED"]);
  assert.equal(w.complaints.find((c) => c.id === "1")!.status, "RESOLVED");
  // read access remains, so the lecturer can see the outcome
  const c = await w.lec.getComplaint(lecA, "1");
  assert.deepEqual([c.status, c.resolution, c.canRespond, c.canUpdateStatus], ["RESOLVED", "Corrected by the HOD.", false, false]);
});
test("10. Request validation lives at the HTTP boundary: strict schemas, no identity fields, only the two lecturer statuses", () => {
  const v = read("src/validators/lecturer.validators.ts");
  assert.match(v, /complaintIdParams = z\.object\(\{ complaintId: objectId \}\)\.strict\(\)/);
  assert.match(v, /complaintRespondSchema = z\.object\(\{ message: z\.string\(\)\.trim\(\)\.min\(3\)\.max\(5000\), visibleToStudent: z\.boolean\(\)\.optional\(\) \}\)\.strict\(\)/);
  assert.match(v, /complaintStatusSchema = z\.object\(\{ status: z\.enum\(\["IN_PROGRESS", "UNDER_REVIEW"\]\)/);
  assert.match(v, /lecturerComplaintsQuery = z\.object\(\{[\s\S]*?\}\)\.strict\(\)/);
});

/* ============================ status workflow ============================ */
test("11. Status: IN_PROGRESS, then hand back to the HOD (UNDER_REVIEW) with a required recommendation; handing back is HOD-only by default", async () => {
  const w = await forwarded();
  const a = await w.lec.setComplaintStatus(lecA, "1", { status: "IN_PROGRESS", note: "Collected the scripts" }, meta);
  assert.deepEqual([a.status, a.allowedStatuses], ["IN_PROGRESS", ["UNDER_REVIEW"]]);
  assert.equal(w.complaints.find((c) => c.id === "1")!.timeline.at(-1)!.internal, false); // pick-up is visible to the student
  assert.equal((await rejection(w.lec.setComplaintStatus(lecA, "1", { status: "UNDER_REVIEW" }))).code, "NOTE_REQUIRED");
  const b = await w.lec.setComplaintStatus(lecA, "1", { status: "UNDER_REVIEW", note: "Marks were mis-keyed; I recommend resolving." }, meta);
  assert.deepEqual([b.status, b.canUpdateStatus, b.canRespond], ["UNDER_REVIEW", false, true]);
  const last = w.complaints.find((c) => c.id === "1")!.timeline.at(-1)!;
  assert.deepEqual([last.label, last.internal, last.byName], ["Returned to the HOD for review", true, "lecA Staff"]);
  assert.deepEqual(w.l.store.audit.filter((x) => x.action === "COMPLAINT_STATUS_CHANGED").map((x) => x.detail), [
    { reference: w.complaints[0].referenceNumber, from: "ASSIGNED", to: "IN_PROGRESS" }, { reference: w.complaints[0].referenceNumber, from: "IN_PROGRESS", to: "UNDER_REVIEW" },
  ]);
  // after the hand-back the lecturer can't change the status again (the HOD decides), but can still answer questions
  assert.equal((await rejection(w.lec.setComplaintStatus(lecA, "1", { status: "IN_PROGRESS" }))).code, "COMPLAINT_TRANSITION_REFUSED");
  assert.equal((await w.lec.respondToComplaint(lecA, "1", { message: "Happy to explain further." })).status, "UNDER_REVIEW");
});
test("12. A lecturer can never approve, resolve, reject, close or re-forward: HOD-only (403, audited), nothing changes", async () => {
  const w = await forwarded();
  for (const status of ["RESOLVED", "REJECTED", "CLOSED", "ASSIGNED", "SUBMITTED", "PENDING"] as const) {
    const r = await rejection(w.lec.setComplaintStatus(lecA, "1", { status, note: "trying", } as never));
    assert.deepEqual([r.status, r.code], [403, "HOD_ONLY_ACTION"]);
  }
  assert.equal(w.complaints.find((c) => c.id === "1")!.status, "ASSIGNED");
  assert.equal(w.complaints.find((c) => c.id === "1")!.resolution, undefined);
  assert.equal(w.l.store.audit.filter((a) => a.action === "ACCESS_DENIED" && (a.detail as { reason?: string })?.reason === "HOD_ONLY_ACTION").length, 6);
  const src = read("src/routes/lecturer.routes.ts");
  assert.ok(!/complaints\/:complaintId\/(assign|resolve|reject|close)/.test(src), "no HOD-only complaint route on the lecturer API");
});

/* ============================ history + HOD integration ============================ */
test("13. History shows forwarding, lecturer replies, status changes and timestamps in order, from the existing timeline", async () => {
  const w = await forwarded();
  await w.lec.respondToComplaint(lecA, "1", { message: "Looking at it now." });
  await w.lec.setComplaintStatus(lecA, "1", { status: "UNDER_REVIEW", note: "Recommend resolving." });
  const h = await w.lec.complaintHistory(lecA, "1", meta);
  assert.deepEqual(h.events.map((e) => [e.status, e.by.role, e.label]), [
    ["SUBMITTED", null, "Complaint submitted"], ["ASSIGNED", "HOD", "Forwarded to a lecturer"], ["IN_PROGRESS", "LECTURER", "Response from the lecturer"], ["UNDER_REVIEW", "LECTURER", "Returned to the HOD for review"],
  ]);
  assert.equal(h.events[2].by.name, "lecA Staff");
  assert.ok(h.events.every((e) => e.at instanceof Date));
  assert.deepEqual([h.status, h.complaintId], ["UNDER_REVIEW", "1"]);
  assert.equal(w.complaints.find((c) => c.id === "1")!.timeline.length, 4); // history is the one timeline: reading it creates nothing
});
test("14. The HOD sees the lecturer's response, keeps the complaint's identity, continues the review and resolves; the lecturer sees the outcome", async () => {
  const w = await forwarded();
  const before = w.complaints.find((c) => c.id === "1")!.referenceNumber;
  await w.lec.respondToComplaint(lecA, "1", { message: "The marks were keyed against the wrong matric number." });
  await w.lec.setComplaintStatus(lecA, "1", { status: "UNDER_REVIEW", note: "Please resolve; I have corrected the entry." });
  const seen = await w.hod.getComplaint(hodC, "1");
  assert.equal(seen.referenceNumber, before);
  assert.equal(seen.status, "UNDER_REVIEW");
  assert.deepEqual(seen.assignedTo?.id, "lecA");
  const mine = seen.timeline!.filter((e) => e.by === "LECTURER");
  assert.deepEqual(mine.map((e) => [e.note, e.byName, e.internal]), [["The marks were keyed against the wrong matric number.", "lecA Staff", false], ["Please resolve; I have corrected the entry.", "lecA Staff", true]]);
  assert.equal((await w.hod.listComplaints(hodC, q({ status: "UNDER_REVIEW" }))).items.length, 1);
  const done = await w.hod.setComplaintStatus(hodC, "1", { status: "RESOLVED", resolution: "Entry corrected." }, hmeta);
  assert.equal(done.status, "RESOLVED");
  const c = await w.lec.getComplaint(lecA, "1");
  assert.deepEqual([c.status, c.resolution], ["RESOLVED", "Entry corrected."]);
  assert.equal((await w.lec.complaintHistory(lecA, "1")).events.at(-1)!.status, "RESOLVED");
});
test("15. The HOD can re-forward after a hand-back: the first lecturer loses access, the new one gains it", async () => {
  const w = await forwarded();
  await w.lec.setComplaintStatus(lecA, "2", { status: "UNDER_REVIEW", note: "Not my area; please reassign." });
  await w.hod.assignComplaint(hodC, "2", { lecturerId: "lecB", note: "Over to you" }, hmeta);
  assert.equal((await rejection(w.lec.getComplaint(lecA, "2"))).status, 404);
  const c = await w.lec.getComplaint(lecB, "2");
  assert.deepEqual([c.status, c.hodMessage], ["ASSIGNED", "Over to you"]);
  assert.equal((await w.lec.respondToComplaint(lecB, "2", { message: "I will sort the timetable clash." })).status, "IN_PROGRESS");
});
test("16. A concurrent HOD decision wins: the lecturer's conditional write is refused, nothing is overwritten", async () => {
  const w = await forwarded();
  const store = w.l.store, read1 = store.getAssignedComplaint.bind(store);
  store.getAssignedComplaint = async (...args) => {
    const stale = structuredClone(await read1(...args));
    w.complaints.find((c) => c.id === "1")!.status = "RESOLVED"; // the HOD resolves between the lecturer's read and write
    return stale;
  };
  const r = await rejection(w.lec.respondToComplaint(lecA, "1", { message: "Late reply that must not land." }));
  assert.deepEqual([r.status, r.code], [409, "COMPLAINT_CHANGED"]);
  const c = w.complaints.find((x) => x.id === "1")!;
  assert.equal(c.status, "RESOLVED");
  assert.equal(c.timeline.filter((e) => e.byRole === "LECTURER").length, 0);
});

/* ============================ surface + existing flows ============================ */
test("17. Every complaint route is lecturer-authenticated and the lecturer id never comes from the client", () => {
  const src = read("src/routes/lecturer.routes.ts");
  const chunks = src.split(/\nrouter\./).filter((c) => c.includes('"/complaints'));
  assert.equal(chunks.length, 5);
  for (const c of chunks) assert.ok(c.includes("...lec"), `unguarded: ${c.slice(0, 60)}`);
  for (const c of chunks.filter((x) => x.startsWith("post(") || x.startsWith("patch("))) assert.ok(c.includes("lecturerWriteLimiter"), "writes are rate-limited");
  const ctl = read("src/controllers/lecturer.controller.ts");
  assert.ok(!/req\.(body|query|params)\.lecturerId/.test(ctl));
  assert.match(read("src/services/lecturer/mongo-store.ts"), /assignedLecturerId: lecturerId/); // the assignee filter is set in the store from the token's id
  const v = read("src/validators/lecturer.validators.ts").split("complaints forwarded to the lecturer")[1];
  assert.ok(!/lecturerId|departmentId|assignedLecturer/.test(v), "no identity / scope fields in complaint schemas");
});
test("18. The existing HOD complaint workflow and the shared Complaint record are intact (one collection, no parallel system)", async () => {
  const w = world();
  // HOD flow unchanged without any lecturer involvement
  assert.equal((await w.hod.setComplaintStatus(hodC, "1", { status: "UNDER_REVIEW", note: "Looking into it" }, hmeta)).status, "UNDER_REVIEW");
  assert.equal((await w.hod.respondToComplaint(hodC, "2", { message: "We will look at the timetable." })).status, "UNDER_REVIEW");
  // no new model / collection was introduced
  const models = fs.readdirSync(path.resolve(__dirname, "../src/models")).filter((f) => /complaint/i.test(f));
  assert.deepEqual(models, ["Complaint.ts"]);
  assert.match(read("src/models/Complaint.ts"), /assignedLecturer: \{ type: Schema\.Types\.ObjectId, ref: "Lecturer" \}/);
});
