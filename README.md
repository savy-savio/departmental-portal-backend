# Departmental Portal Backend (Student phase)

Multi-department university portal API. TypeScript, Express, MongoDB/Mongoose, JWT, bcryptjs, Resend, Zod.

## Done so far (Student backend + anti-proxy attendance + Course Rep / Assistant Course Rep)
Foundation, Department model, matric parsing, Student model + seeding, first-time onboarding,
email/password login, forgot/reset password, change password, auth middleware, student profile (view/edit/photo), courses & enrollment (catalogue, selection, carryover, history), timetable, announcements, materials, assignments + submissions, attendance, complaints, notifications, departmental elections.

## Setup
```bash
npm install
cp .env.example .env      # set MONGODB_URI, JWT_SECRET (32+ chars), CLIENT_URL
npm run seed:departments  # seeds/departments.json (CSC: 100-400, MLS: 100-500)
npm run seed:terms        # seeds/academic-terms.json (current session/semester per department)
npm run seed:courses      # seeds/courses.json (course catalogue; stand-in for the later HOD/course-rep upload)
npm run seed:students     # seeds/students.json   (add --dry-run to validate only)
npm run seed:hods         # seeds/hods.json (SYSTEM provisioning of department heads: prints one-time activation links; run after departments)
npm run seed:lecturers    # seeds/lecturers.json (HOD stand-in: creates INVITED lecturers, prints activation links, assigns current-term courses; run AFTER courses/terms)
npm run seed:representatives # seeds/representatives.json (run AFTER students are seeded AND onboarded, and after content)
npm run seed:elections    # seeds/elections.json (sample elections; run AFTER students)
npm run seed:content      # seeds/academic-content.json (sample timetable/announcements/materials/assignments; run AFTER students)
npm run dev
npm test                  # unit tests (no database needed)
```
Without `RESEND_API_KEY` (development only) emails are printed to the server console,
so you can copy the reset token from there.

## Architecture rules
- `matric.service.ts` is the only code that knows the matric format; it returns a department *code*.
- `department.service.ts` maps that code to a Department via `Department.matricCode` (data, not code).
  Adding Physics = add a Department record. No auth code changes.
- Levels live on the Department (`levels: ["100",...]`), validated at seed time.
- JWTs carry only the subject. Role/department/status are re-read from the DB on every request
  (`middleware/auth.ts` sets `req.student` and `req.department`). Validators are `.strict()`,
  so a client-sent `departmentId`, `studentId` or `role` is rejected, never trusted.
- Future roles plug in as new route modules under `routes/index.ts`; authorisation = role + department + assigned resource.

## Endpoints (`/api/v1/student`)
| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | /onboarding/verify | none | `{fullName, matricNumber}` -> short-lived onboarding token |
| POST | /onboarding/complete | onboarding token | `{email, password, confirmPassword}` -> JWT + profile |
| POST | /auth/login | none | `{email, password}` -> JWT + profile |
| POST | /auth/forgot-password | none | `{email}` (same reply whether or not it exists) |
| POST | /auth/reset-password | none | `{token, password, confirmPassword}` |
| POST | /auth/logout | JWT | stateless; client drops the token |
| GET | /courses | JWT | my registered courses for the current term + total units |
| GET | /courses/available | JWT | catalogue for my department, my level, current term (each flagged `enrolled`) |
| GET | /courses/carryover-options | JWT | earlier-level / earlier-session courses I could carry over this semester |
| GET | /courses/history | JWT | every term I've registered in, grouped by session + semester |
| POST | /courses | JWT | `{courseId, enrollmentType?: "REGULAR"\|"CARRYOVER"}` |
| PATCH | /courses/:enrollmentId | JWT | `{enrollmentType}` (re-validated) |
| DELETE | /courses/:enrollmentId | JWT | remove a registration (current term, registration open only) |
| GET | /timetable | JWT | `?view=combined\|class\|mine` (default combined) for the current term |
| GET | /announcements | JWT | `?page&limit`; only items addressed to me |
| GET | /announcements/:id | JWT | 404 if not addressed to me |
| GET | /materials | JWT | `?courseCode&type&semester&academicSession&page&limit` |
| GET | /assignments | JWT | `?status=all\|pending\|submitted`; only my registered courses this term |
| GET | /assignments/:id | JWT | detail + my submission |
| POST | /assignments/:id/submissions | JWT | multipart: `content` (text) and/or `file` (PDF/DOCX/JPEG/PNG/WebP) |
| GET | /attendance | JWT | `?courseCode`; my sessions this term + per-course attendance summary |
| GET | /attendance/device | JWT | my attendance-device status (+ whether THIS device is the registered one) |
| POST | /attendance/device/verification | JWT | `{password}`; emails a 6-digit code (register a first device, or replace the current one) |
| POST | /attendance/device/register | JWT | `{code, label?}` -> `{deviceToken}` (shown ONCE). Replaces and revokes the old device if one exists |
| POST | /attendance/:sessionId/challenge | JWT + `X-Attendance-Device` | checks everything, returns a 90 s single-use `attendanceToken` |
| POST | /attendance/:sessionId | JWT + `X-Attendance-Device` | `{attendanceToken, latitude, longitude, accuracyMeters?, code?}`; marks present/late |
| GET | /complaints | JWT | `?search&status`; my complaints |
| GET | /complaints/stats | JWT | counts for the dashboard cards |
| GET | /complaints/upload-constraints | JWT | max files / size / extensions |
| POST | /complaints | JWT | `{type:"COURSE"\|"HOD", title, message, courseId?}` |
| GET / PATCH | /complaints/:id | JWT | view; edit `{title, message, removeAttachmentIds}` while still editable |
| POST | /complaints/:id/attachments | JWT | multipart `file` (max 3 per complaint, 5 MB each) |
| GET | /notifications | JWT | `?unread=true&page&limit` (+ `unreadCount`) |
| PATCH | /notifications/read-all, /notifications/:id/read | JWT | mark read |
| GET | /elections | JWT | elections I'm eligible for (my department, level, session) |
| GET | /elections/:electionId | JWT | positions + approved candidates + which positions I've voted in |
| POST | /elections/:electionId/vote | JWT | `{votes:[{positionId, candidateId}]}`; all-or-nothing, one vote per position |
| GET | /elections/:electionId/results | JWT | only after voting closes AND results are published |
| PATCH | /change-password | JWT | `{currentPassword, password, confirmPassword}` -> fresh JWT |
| GET | /profile | JWT | current student |
| PATCH | /profile | JWT | `{phone?, sex?}` only; any other field (level, department, matricNumber, role, email, names) is rejected with 422 |
| POST | /profile/picture | JWT | multipart, field `photo`; JPEG/PNG/WebP, max `MAX_PROFILE_PHOTO_MB`; type checked from file bytes |
| DELETE | /profile/picture | JWT | removes the photo and deletes the file |
| GET | /health (root, not versioned) | none | liveness + DB status |

Success: `{ success: true, message?, data }`. Errors: `{ success: false, message, errors? }`.

## Manual test script
```bash
B=http://localhost:5000/api/v1/student
# 1. verify (note the loose capitalisation/spacing on purpose)
curl -s $B/onboarding/verify -H 'Content-Type: application/json' \
  -d '{"fullName":"  john   DOE","matricNumber":"25/208csc/987"}'
# 2. complete (use onboardingToken from step 1)
curl -s $B/onboarding/complete -H 'Content-Type: application/json' -H "Authorization: Bearer $ONB" \
  -d '{"email":"john@example.com","password":"Passw0rdA","confirmPassword":"Passw0rdA"}'
# 3. login, profile
curl -s $B/auth/login -H 'Content-Type: application/json' -d '{"email":"john@example.com","password":"Passw0rdA"}'
curl -s $B/profile -H "Authorization: Bearer $TOKEN"
# 4. forgot -> read token from server console -> reset
curl -s $B/auth/forgot-password -H 'Content-Type: application/json' -d '{"email":"john@example.com"}'
curl -s $B/auth/reset-password -H 'Content-Type: application/json' \
  -d '{"token":"<from console>","password":"NewPassw0rd","confirmPassword":"NewPassw0rd"}'
```
Things that should fail: unknown dept code in seed (whole seed aborts), level 500 for CSC,
re-running verify after onboarding (409), reusing a reset token (400), old JWT after a password change (401),
sending `{"departmentId": "..."}` anywhere (422).

## Profile test script (Stage 6)
```bash
curl -s -X PATCH $B/profile -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{"phone":"+234 801 234 5678","sex":"MALE"}'
curl -s -X PATCH $B/profile -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{"level":"400"}'          # 422
curl -s -X PATCH $B/profile -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{"departmentId":"x"}'      # 422
curl -s -F photo=@me.jpg $B/profile/picture -H "Authorization: Bearer $TOKEN"
curl -s -F photo=@notes.txt $B/profile/picture -H "Authorization: Bearer $TOKEN"                                                  # 415
curl -s -X DELETE $B/profile/picture -H "Authorization: Bearer $TOKEN"
```
Photos are stored on Cloudinary (`CLOUDINARY_*` env vars), cropped to 400x400. Without them, uploads return 503 in development.

## Courses & enrollment rules (Stage 7)
- `Course` = catalogue entry (department, code, title, units, level, semester, session, status). Students can never create or edit one.
- `AcademicTerm` = a department's current session + semester, registration switch/dates and unit cap. Exactly one current term per department.
- `CourseEnrollment` = student + course + term + type (REGULAR / CARRYOVER). A carryover points at the *original* Course record; nothing is copied.
- REGULAR: same department, same level as the student, current session and semester, course ACTIVE.
- CARRYOVER: same department, offered in the current semester, from a lower level or an earlier session, never from a higher level; archived records are allowed.
- Also enforced: registration open, one registration per course code per term, unit cap (default 24), student's own session must match the current term.
- Another department's course id or another student's enrollment id returns 404. Request bodies reject `studentId` / `departmentId` / `level`.
- Course prefixes are not tied to the department: a CSC catalogue can hold MTH201 or STA111 as service courses.

```bash
curl -s $B/courses/available -H "Authorization: Bearer $TOKEN"
curl -s $B/courses -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{"courseId":"<id>"}'
curl -s $B/courses/carryover-options -H "Authorization: Bearer $TOKEN"
curl -s $B/courses -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{"courseId":"<id>","enrollmentType":"CARRYOVER"}'
curl -s -X DELETE $B/courses/<enrollmentId> -H "Authorization: Bearer $TOKEN"
```
To exercise carryover, seed a 200-level CSC student (e.g. add one to seeds/students.json) and carry over STA111.

## Academic features (Stage 8)
All four are department-scoped: the department comes from the JWT, never from the request.
- **Timetable** is read-only. `class` = everything for my level this term; `mine` = slots for courses I'm registered in (carryovers from other levels included), matched by course code.
- **Announcements** have an audience: `DEPARTMENT`, `LEVEL`, `CLASS` (level + session), `COURSE` (enrolled students) or `GROUP` (named students). Drafts, future-dated and expired items are hidden. An announcement not meant for me is a 404, not a 403.
- **Materials** show for courses I'm registered in, plus class-wide resources for my level and session. Another department's material appears only if it was explicitly shared with my department (and level, when the share names levels).
- **Assignments** show only for courses I'm registered in this term, never drafts. Submissions are always looked up by my own id. Rules: deadline enforced unless late submissions are allowed (then `isLate` is set), resubmission allowed until graded, scores/feedback hidden until graded.
- **Submission files** go to Cloudinary as *authenticated* uploads (no public URL). The API returns a signed link only to the owner. Types are checked from bytes; limit `MAX_SUBMISSION_MB`.
- Creation of timetable/announcements/materials/assignments belongs to the HOD / lecturer / course-rep phases; `seed:content` stands in until then. Sample material file URLs are placeholders.

To exercise it: seed in order departments, terms, courses, students, content; onboard `24/208CSC/101` (Chidi Okafor, 200 level CSC), register CSC201 and carry over STA111, then call the endpoints above. Seed content and compare what the MLS student `25/208MLS/123` sees: none of CSC's items should appear.

## Student services (Stage 9)
**Attendance.** Sessions belong to a department and course. A student can mark only if the session is in their department, belongs to the current term, is for a course they're registered in (carryovers included), and is open right now. Optional in-class code (stored only as a hash, compared in constant time, rate-limited). Late after `lateAfterMinutes`. One mark per student per session is enforced by a unique index. A closed session you didn't mark shows as `ABSENT`. Lecturers opening sessions (and being checked against their assigned courses) arrives in the lecturer phase; `seed:content` creates sample sessions with times relative to "now", so re-run it to reopen them (code for the open CSC201 session: `4821`).

**Complaints.** The student never chooses a recipient id. `HOD` goes to their own department's HOD; `COURSE` requires a course from their own department that they're registered for this term, and goes to that course's lecturer. Routing is stored as role + department (+ course) and a staff `userId` is filled in by the later HOD/lecturer phases. Reference numbers like `CMP-CSC-2026-00001` come from an atomic counter. Editing and attachments are allowed only while the status is `SUBMITTED`/`PENDING` (the API returns `editable`). Attachments are private Cloudinary uploads with signed links for the owner. Another student's complaint id is a 404. Cross-department complaints, and the "explicitly authorised" exception from the spec, are not supported yet; that needs an authorisation model from the HOD phase.

**Notifications.** `notify()` in `services/notification.service.ts` is the single entry point every future role will use. Currently created for: account setup and complaint submission. Students can only read/mark their own. Old notifications expire after 90 days.

## Elections (Stage 10)
- **Scope:** every election belongs to one department. A student only ever sees elections of their own department whose `eligibleLevels` (empty = all) include their level and whose session matches theirs. Anything else is a 404, so other departments' elections can't even be detected. CSC and MLS each run their own.
- **One vote per position** is guaranteed by a unique index on `(position, student)` in `VoteParticipation`, not just by code, so double-clicks and parallel requests can't double-vote. A multi-position ballot is all-or-nothing (earlier inserts are rolled back if a later one fails).
- **Ballot secrecy:** `VoteParticipation` records *that* a student voted for a position; `Vote` records *what* was voted with no student field, no timestamps and a random UUID `_id`. Nothing in the API links the two, and the confirmation notification doesn't name the candidate. Residual risk: anyone with raw database access could still correlate insertion order across the two collections. If the committee needs stronger guarantees, keep votes in a separate database with restricted access or use a cryptographic ballot scheme.
- **Voting rules:** the window must be open; the candidate must be APPROVED and standing for that exact position of that exact election; candidates are listed alphabetically.
- **Results** need `resultsPublished = true` AND a closed window; they include per-candidate votes, ties (no single winner), and turnout against eligible active students.
- Creating elections, positions and candidates, approving candidates and releasing results is done by the HOD (see **HOD election management** below); `seed:elections` remains for sample data.
- An election's electorate is `electorateMode`: `DEPARTMENT` (everyone), `LEVELS` (the listed levels) or `GROUP` (an explicit list of students). The vote endpoint re-checks this on the server (`isEligibleVoter`); the frontend is never trusted.
- Vote compensation uses plain inserts/deletes so it works on a standalone MongoDB. If you deploy on a replica set (e.g. Atlas), wrapping `castVotes` in a transaction is a good hardening step.

To exercise it: seed in order departments, terms, courses, students, content, elections. Log in as a CSC student and vote; log in as the MLS 100-level student (`25/208MLS/310`, Kemi Ola) and confirm the MLS election is invisible (level restriction) and the CSC election returns 404.

## Anti-proxy attendance (device binding + location + audit)

**Threat:** Student A uses Student B's account (or logs into B on A's phone) so B is marked present. Goal: make that much
harder by requiring several independent signals together. It does **not** prove who is physically holding a device.

| Signal | How it is enforced |
|---|---|
| Authenticated student | JWT only. No `studentId` / `deviceId` / `courseId` / `departmentId` is ever read from the request (validators are `.strict()`) |
| Bound attendance device | `X-Attendance-Device` header -> server hashes it -> must be THIS student's ACTIVE device. Another student's device => `DEVICE_BOUND_TO_OTHER_STUDENT` |
| Session | belongs to the student's own department, current term, status ACTIVE, inside its time window |
| Enrollment | student registered for that course code this semester (carryovers included) |
| Location | server computes haversine distance to the session's coordinates; client never says "I'm inside". Accuracy cap `ATTENDANCE_MAX_ACCURACY_METERS` |
| Short-lived token | single-use challenge bound to student + device + session; 90 s; consumed atomically; expired / replayed / someone else's => rejected |
| One mark per session | unique index `(session, student)` on `AttendanceRecord` (not just the button) |
| IP / user agent | recorded on every attempt for audit + suspicious-activity flags and rate limiting. Never an identity: 40 students on one Wi-Fi can all attend |
| Audit | `AttendanceSecurityLog` row for every attempt (success AND rejection) with student, session, course, device fingerprint, IP, location result, reason, flags |

**Device lifecycle (only affects attendance; other portal use on any device is unchanged)**
1. `POST /attendance/device/verification {password}`: step-up. Password must be right; a 6-digit code is emailed (HMAC-stored, 10 min, 5 tries, single use).
2. `POST /attendance/device/register {code, label?}`: server generates a 256-bit token, stores only its SHA-256 hash, returns the raw token once.
   If the student already has a device this is a **replacement**: the old one is revoked (`REPLACED`) and its token stops working. Max `DEVICE_CHANGE_LIMIT_30D` (default 2) replacements per 30 days; beyond that the department must reset it (HOD phase).
3. A device that is ACTIVE for another student can't be registered by anyone else (even with the right password + code). A *revoked* device is free to be claimed.
4. Knowing a classmate's password is not enough to bind a device to their account: the emailed code is also required.

**Frontend contract (important):**
- Keep the raw `deviceToken` in persistent storage **separate from the login session** and do NOT clear it on logout. Clearing it on logout is exactly what would let Student B on Student A's phone look like a brand-new device.
- Send it as `X-Attendance-Device` on `/attendance/:sessionId/challenge` and `/attendance/:sessionId`.
- Flow per class: challenge -> read GPS -> mark within 90 s with `attendanceToken` + coordinates.
- Rejections carry a stable `code` (`DEVICE_BOUND_TO_OTHER_STUDENT`, `DEVICE_NOT_REGISTERED`, `DEVICE_UNRECOGNISED`, `DEVICE_REVOKED`, `LOCATION_OUTSIDE_RADIUS`, `ALREADY_MARKED`, `ATTENDANCE_TOKEN_INVALID`, `SESSION_CLOSED`, `NOT_ENROLLED`, ...) so the UI can send the student to the right step.
- Run behind a proxy? Set `TRUST_PROXY` correctly or every IP in the logs will be the proxy's.

**Known limitations (be honest with stakeholders):**
- A token in browser storage can be cleared or copied by a determined user; a phone that was never registered cannot be told apart from a wiped one. Stronger options (native app / WebAuthn / platform attestation) are outside this web API.
- GPS from a web page can be spoofed with mock-location tools. The radius check plus device binding plus audit flags make cheating costlier and detectable, not impossible.
- A student who already holds the account password AND the owner's mailbox can still enrol a device as that student.
- Sessions without coordinates (created before this feature) skip the location check; all sessions created via `createAttendanceSession` require it.

**Breaking change:** `POST /attendance/:sessionId` previously took only an optional class code. It now requires the device header, a challenge token and (for sessions with a location) coordinates. The class code, if the session has one, is still checked.

**Session creation foundation (Stage 3):** `services/attendance/session.service.ts#createAttendanceSession(creator, input)` for the lecturer / course-rep / HOD phases. It derives department and term from the creator, requires the course to be in that department's current catalogue, validates window/radius/coordinates, and authorises: HOD for their own department's courses, lecturers / course reps only for assigned courses. No cross-department or global bypass. Not exposed to students.

**Tests:** `npm test` runs the attack scenarios (`tests/attendance-security.test.ts`) against the real decision engine using an in-memory store that enforces the same uniqueness/atomicity rules as the MongoDB indexes. Covered: normal success; double marking (engine + store level); B on A's account from B's phone; wrong password / wrong code; B on A's phone (attend and register); B on own device; same public IP; outside radius, no/low-accuracy GPS; closed / not-yet-open sessions; not enrolled; other department's session; forged / unknown / hashed device values; someone else's, expired, replayed and cross-session tokens; verified phone replacement, code expiry/lockout/single use, change cap; audit contents; flags; 40 students on one IP with zero flags; MLS works like CSC.
Not run here (needs packages / a database): the zod `.strict()` rejection of extra body fields, the Express wiring, and the MongoDB store (`mongo-store.ts`) itself.

## Course Rep + Assistant Course Rep (`/api/v1/representative`)

**Architecture:** a representative is an ordinary Student. They log in with the normal student JWT, keep every student feature, and gain
representative powers only from an ACTIVE `CourseRepresentativeAssignment` (student + department + course + level + session + semester + role + status +
assignedBy/At). `Student.role` is never consulted, there is no endpoint that creates an assignment, and sending `{"role":"COURSE_REP"}` anywhere does nothing.
Assignments are created / revoked / suspended through `services/representative/assignment.service.ts` (HOD of the same department only; reps of either kind can never call it).
Until the HOD phase exists, `npm run seed:representatives` creates them through that same service so all rules apply.

**Authorization chain, on every request, from the database (nothing cached, so revoking takes effect on the next call):**
`authenticateStudent` -> `requireRepresentative` (ACTIVE assignment in the department's CURRENT term, own department) ->
`requireAssignedCourse` (the named course must be one of the caller's assigned courses) -> `requireRepresentativePermission(perm)` -> the service checks the exact
course, the role's permission and ownership again. A course id that isn't yours (or doesn't exist) always answers `NOT_ASSIGNED_TO_COURSE`; announcement/resource/timetable
ids outside your class answer 404, so ids can't be used to probe other classes or departments. Denied attempts are audited (`ACCESS_DENIED`).
An assignment from last term stops granting anything when the department's current term moves on, until it is renewed.

**Permissions (data in `services/representative/policy.ts`, frozen at runtime, overridable for later changes):**

| | COURSE_REP | ASSISTANT_COURSE_REP |
|---|---|---|
| View course, members, timetable, announcements, resources, overview, notifications | yes | yes |
| Announcements: create / edit own / unpublish own | yes | yes (priority up to IMPORTANT) |
| Announcements: delete own (soft delete) | yes | no |
| Announcements: priority URGENT | yes | no |
| Class resources: upload / edit own / delete own | yes | yes |
| **Class timetable: create / edit / delete / publish** | **yes** | **no (view only)** |

To let assistants help with the timetable later, add `timetable:create` / `timetable:update` / `timetable:delete` to `ASSISTANT_COURSE_REP` in the table (the tests show it working for her own class only).
No role can hold: assigning / revoking reps or changing roles, editing student profiles / level / department, enrollment, the course catalogue, official lecturer materials,
the OFFICIAL departmental timetable, or any attendance action. Those aren't just denied; the permissions don't exist, and the route table is checked by a test.

**Endpoints**
| Method | Path | Notes |
|---|---|---|
| GET | /profile, /assignments, /overview | my assignments + permissions (student profile stays the source of identity); history; dashboard summary |
| GET | /courses, /courses/:courseId | course info + enrolled count + lecturer names where known (read-only) |
| GET | /courses/:courseId/members | `?page&limit&search`; name, matric, photo, level, regular/carryover only (no email / phone) |
| GET | /announcements | `?courseId` |
| POST / PATCH / DELETE | /announcements, /announcements/:announcementId | audience is always exactly the assigned class; `message` field; DELETE is a soft delete |
| GET | /resources | `?courseId`; official materials appear read-only (`canEdit:false`) |
| POST / PATCH / DELETE | /resources, /resources/:resourceId | multipart `file` (PDF/DOCX/PPTX/XLSX/JPEG/PNG/WebP, type checked from bytes, `MAX_RESOURCE_MB`) OR JSON `fileUrl` (https); always `CLASS_RESOURCE`, never official; only your own; official lecturer material -> `OFFICIAL_MATERIAL_PROTECTED` |
| GET | /timetable | `?courseId&view=course\|class` (drafts only for people who can manage it) |
| POST | /timetable | Course Rep: `{courseId?, dayOfWeek? \| date?, startTime, endTime, venue?, lecturerName?, title?, type?, status?}` |
| PATCH / DELETE | /timetable/:id | Course Rep, class entries only; official entries -> `OFFICIAL_TIMETABLE_PROTECTED` |
| GET | /notifications | the student's own notification feed |

**Class timetable details:** stored in the existing `TimetableEntry` model with new optional fields (`source` OFFICIAL|CLASS_REP, `status` DRAFT|PUBLISHED, `date`, `course`, `createdByStudent`),
so published entries show up in the existing `GET /student/timetable` automatically and students still cannot modify anything. Drafts never reach students. The class (department, level, session,
semester, course) is derived from the assignment, never from the request. Slots are validated (HH:mm, end after start, weekday/date agree) and a course can't have clashing slots. Publishing /
changing / deleting a published slot notifies the class (`TIMETABLE` notification).

**Shared models changed (all additions optional, existing data and student endpoints keep working):** `Announcement` (+course, level, session, semester, createdByStudent; statuses +UNPUBLISHED, DELETED),
`Material` (+course, createdByStudent, resourceType), `TimetableEntry` (above). Students see a class announcement only while its term is current.
New: `CourseRepresentativeAssignment` (unique ACTIVE Course Rep per course; one ACTIVE role per student per course; max 2 assistants per course), `RepresentativeAuditLog` (announcement / resource / timetable / assignment actions and denied attempts).

**Tests:** `npm test` runs 110 tests. The authorization + action engine runs against an in-memory store with the same department / ownership filters as the Mongo store. Covered: all 28 requested scenarios plus the 8 timetable scenarios
(create / edit / delete, other class, other department, assistant view-only, enabling assistant timetable permission later, student cannot modify, revocation), audit trail, and route-table guards (representative surface is exactly the intended list; every route is behind the student login + representative check;
student routes untouched; representative code never reads `student.role`; schemas are strict and accept no identity fields).
**Not run here** (needs packages / a database): the Express wiring and zod strictness at HTTP level, `mongo-store.ts`, `assignment.service.ts`, and Cloudinary uploads.
Items 20-24 and 27 are verified by the permission table + route guards rather than by sending HTTP requests.

## Lecturer backend (`/api/v1/lecturer`)

**Accounts.** Lecturers never self-register. The HOD phase (until then `npm run seed:lecturers`, via `services/lecturer/account.service.ts`) creates a `Lecturer` (status INVITED, department = the creator's department) and
emails a one-time activation link (72 h, only its hash is stored). `POST /auth/activate {token,password,confirmPassword}` sets the password and activates. Then email + password login, lockout after 5 failures, forgot / reset password,
change password (old tokens die). Lecturer JWTs have their **own audience** (`lecturer-access`): a student token can't be used here and vice versa. Role, status and department are re-read from the database on every request, so a suspended
lecturer or deactivated department is refused on the next call.

**Authority = an ACTIVE `LecturerCourseAssignment`** (lecturer + department + course + session + semester) in the department's CURRENT term. Chain on every course route:
`authenticateLecturer` (valid lecturer token, ACTIVE lecturer, active department) -> `requireLecturer` -> `requireLecturerCourseAssignment` (assigned to exactly this course; "not yours", "other department" and "doesn't exist" give the same answer)
-> the service re-checks. Resource-id routes (`:materialId`, `:announcementId`, `:assignmentId`, `:sessionId`) are resolved to their course and checked against the lecturer's assignments: outside her courses = 404, a colleague's item in her own course = 403 `NOT_OWNER`
(she may *view* a co-lecturer's items, never change them). Revoking an assignment, suspending a lecturer, or the term rolling over takes effect on the next request. Denied attempts are audited.

| Method | Path | Notes |
|---|---|---|
| POST | /auth/login, /auth/activate, /auth/forgot-password, /auth/reset-password | public (rate limited) |
| POST / PATCH | /auth/logout, /change-password | |
| GET / PATCH | /profile | PATCH accepts **only `phone`**; name, email, staffId, department, role are rejected (422) and unreachable in the store |
| POST | /profile/picture | multipart `photo` (type checked from bytes) |
| GET | /dashboard | profile, department, term, assigned courses, upcoming assignments, recent announcements, attendance sessions (open / recent), notifications, per-course statistics |
| GET | /courses, /courses/:courseId | assigned courses only; detail has counts + schedule |
| GET | /courses/:courseId/students | read-only: name, matric, photo, level, regular/carryover (no email / phone) |
| GET / POST | /courses/:courseId/materials | **official** materials only (a rep's class resources are never mixed in); multipart `file` or JSON `fileUrl` |
| PATCH / DELETE | /materials/:materialId | only OFFICIAL materials you published |
| GET / POST | /announcements | `?courseId`; POST body needs `courseId` (an assigned course): the audience is always that class, there is no system-wide announcement |
| PATCH / DELETE | /announcements/:announcementId | own only; DELETE is a soft delete |
| GET | /assignments | `?courseId` |
| POST | /courses/:courseId/assignments | `{title, description, dueDate(future), allowLateSubmission?, published? (default false), fileUrl? \| file}` |
| PATCH / DELETE | /assignments/:assignmentId | publish / unpublish via `published`; DELETE refused once students have submitted (`ASSIGNMENT_HAS_SUBMISSIONS`: unpublish instead) |
| GET | /assignments/:assignmentId/submissions | submissions + counts; private files via signed links; **no grades / marks anywhere** |
| GET / POST | /courses/:courseId/attendance | history with counts / create a session |
| GET | /courses/:courseId/attendance/statistics | per-student and per-session attendance |
| GET | /attendance/:sessionId | live view: records (with distance), not-yet-marked, counts, flagged attempts |
| PATCH | /attendance/:sessionId/close, /open | **owner only**; reopen for `durationMinutes` |
| GET | /timetable | `?courseId`: VIEW only (official + the Course Rep's published class slots; drafts hidden) |
| GET / PATCH | /notifications, /notifications/:notificationId/read, /notifications/read-all | same `Notification` collection students use (`recipientType: LECTURER`) |

**Attendance location (GPS) and the existing student security.** The lecturer creates a session with `latitude`, `longitude`, `allowedRadiusInMeters` (10-1000), start / end (or `durationMinutes`), optional class `code`, `lateAfterMinutes`.
Course, department, level, session, semester and lecturer are derived from the assignment. One open session per course at a time. The student endpoint sends `{latitude, longitude}` (numbers, required): the **server** computes the Haversine distance
and rejects with `You are outside the allowed attendance location.` when it exceeds that session's own radius. Missing / malformed coordinates are rejected; a session with no location is refused (fail closed). IP is recorded in the record and the
security log only (audit, rate limiting by student, suspicious-activity flags): never `one IP = one student`. Still enforced: student JWT, enrollment in the course for the current term, department scope, active window (a lecturer's close is immediate),
bound device, single-use 90 s attendance token, unique `(session, student)` index, audit log. Course Reps / Assistants cannot create or manage sessions (`authorizeSessionCreator` now admits only LECTURER-with-assignment and HOD).
GPS is one layer, not proof: coordinates from a browser can be spoofed with mock-location tools. The layers together (account, enrollment, GPS radius, bound device, short-lived token, one mark, audit flags such as repeated out-of-range tries or a device used by two accounts) raise the cost of cheating and make it investigable; they don't make it impossible.

**Models.** New: `Lecturer`, `LecturerCourseAssignment`, `LecturerAuditLog` (a separate model because the existing audit logs are scoped to reps / attendance; the HOD phase can unify them). Changed (all additions optional, old data still valid):
`AttendanceSession` (+`lecturer`, `course`, `location.allowedRadiusInMeters`; legacy `radiusMeters` still read), `Announcement` (+`createdByLecturer`), `Material` (+`lecturer`), `Assignment` (+`course`, `lecturer`, `attachment`), `Notification` (+`recipientType`, default STUDENT).
Student-side changes: assignment DTO shows the attachment; attendance list includes early-closed sessions (an unmarked closed session is an absence); student submissions notify the course's lecturers; coordinates are now required on `POST /student/attendance/:sessionId`.

**Not built (as instructed):** HOD / admin, SUPER_ADMIN, elections, Campus Hub, polls, grading / results, any UI for assigning lecturers or creating courses, university-wide timetable administration.

**Sample requests**
```bash
L=http://localhost:5000/api/v1/lecturer
# after `npm run seed:lecturers` copy the printed activation token
curl -s $L/auth/activate -H 'Content-Type: application/json' -d '{"token":"<token>","password":"Str0ngPass","confirmPassword":"Str0ngPass"}'   # -> token
curl -s $L/auth/login -H 'Content-Type: application/json' -d '{"email":"a.bello@university.example","password":"Str0ngPass"}'
curl -s $L/courses -H "Authorization: Bearer $T"                                  # note a course id: $C
curl -s $L/courses/$C/students -H "Authorization: Bearer $T"
curl -s $L/courses/$C/attendance -H "Authorization: Bearer $T" -H 'Content-Type: application/json' \
  -d '{"latitude":9.0765,"longitude":7.3986,"allowedRadiusInMeters":100,"durationMinutes":90,"code":"4821"}'
curl -s -X PATCH $L/attendance/$S/close -H "Authorization: Bearer $T" -H 'Content-Type: application/json' -d '{}'
curl -s $L/announcements -H "Authorization: Bearer $T" -H 'Content-Type: application/json' -d '{"courseId":"'$C'","title":"Test Friday","content":"Chapters 1-3","priority":"IMPORTANT"}'
curl -s $L/courses/$C/materials -H "Authorization: Bearer $T" -F title="Lecture 1" -F file=@lecture1.pdf
curl -s $L/courses/$C/assignments -H "Authorization: Bearer $T" -H 'Content-Type: application/json' -d '{"title":"Linked lists","description":"Implement a list","dueDate":"2026-12-15T23:59:00Z","published":true}'
curl -s $L/assignments/$A/submissions -H "Authorization: Bearer $T"
curl -s -X PATCH $L/profile -H "Authorization: Bearer $T" -H 'Content-Type: application/json' -d '{"departmentId":"x"}'   # 422
curl -s $L/courses/<another lecturer's course id> -H "Authorization: Bearer $T"                                       # 403 NOT_ASSIGNED_TO_COURSE
```
Seed order for the whole system: departments, terms, courses, students, content, **lecturers**, then onboard students, then representatives, elections.

**Tests (`npm test`, 152).** `tests/lecturer.test.ts` (engine against an in-memory store with the Mongo store's filters): assigned vs unassigned vs other-department courses; revoked / old-term assignments; materials, announcements, assignments CRUD incl. publish / unpublish / submissions / delete-protection; read-only students; timetable view-only; attendance create / validate / close / reopen / live / statistics / unauthorised close; the real student attendance engine run against a lecturer-created session (outside radius, wrong device, one mark, closed); profile immutability; IDOR id-swapping across every resource type; audit trail with IP; notifications; dashboard; CSC<->MLS isolation.
`tests/lecturer-auth.test.ts`: login, lockout, inactive / suspended / invited, token tampering / expiry / student-token rejection, role & department from the database, activation, reset. `tests/lecturer-guards.test.ts`: route table is exactly the intended surface, every route behind the lecturer guard, strict schemas, no grading anywhere, student attendance protections and DB uniqueness still present.
The Student and Course Rep suites still pass unchanged (apart from the two intended attendance changes above).
**Not run here** (no network): Express wiring and zod strictness at HTTP level, the Mongo stores / account service / seeder, JWT signing (a tiny HMAC token stands in for the JWT library in the auth tests; the audience check is what's tested), bcrypt, Cloudinary, Resend.

## HOD / department admin (`/api/v1/hod`)

**Accounts.** No public signup, ever. A department head is provisioned by the system (`npm run seed:hods` -> `services/hod/account.service.ts`, callable only by `SYSTEM_SETUP` / a future `SUPER_ADMIN`; a HOD can't create or promote a HOD).
The `Hod` record starts INVITED and is activated with a one-time emailed token (`POST /auth/activate`), then email + password login (lockout, forgot / reset, change password: the same engine as lecturers, configured for role HOD).
HOD tokens have their own audience (`hod-access`): student and lecturer tokens don't verify here. A department has exactly **one current HOD** (unique partial index); a replaced HOD (`isCurrent: false`) can no longer sign in.
Role, department and staffId are immutable; the only editable profile field is the phone.

**Authorization chain on every request:** `authenticateHod` (valid HOD token; HOD exists, is current and ACTIVE; department active) -> `requireHod` -> `requireDepartmentScope` -> handler -> store.
Role, status and department are re-read from the database each time, so suspending a HOD or deactivating a department bites on the next request.

**Department-isolation rules**
1. The department is always the authenticated HOD's own. No handler or service method takes a department from the request.
2. `requireDepartmentScope`: a `departmentId` / `department` in the path, query or body that isn't the HOD's own => 403 `DEPARTMENT_SCOPE_VIOLATION` and a `SCOPE_VIOLATION` audit entry (their own is ignored). Validators are also `.strict()`, so unknown keys never reach a handler.
3. Every store method takes the HOD's department and filters by it, so another department's student / lecturer / course / complaint / representative / session / announcement / document answers **exactly like a missing one (404)**, and every such attempt is audited (`ACCESS_DENIED`). No id can be used to probe other departments.
4. Update calls copy only whitelisted fields before reaching storage (extra keys like `matricNumber`, `role`, `departmentId`, `courseCode` are dropped even if a caller bypassed validation).
5. Levels, sessions, courses, terms, announcements and documents are all per department: CSC 100-400 and MLS 100-500 coexist; nothing assumes a fixed level set or a department name.

| Area | Endpoints | Rules |
|---|---|---|
| Auth / profile | POST /auth/login, /auth/activate, /auth/forgot-password, /auth/reset-password, /auth/logout; PATCH /change-password; GET / PATCH /profile; POST /profile/picture | PATCH profile = phone only |
| Dashboard | GET /dashboard | students (total / active / pending / suspended), lecturers, Course Reps, Assistant Course Reps, active courses, current session + semester, active announcements, open attendance sessions, pending complaints, recent activity (HOD + lecturer + rep actions) |
| Department | GET /department; PATCH /department/settings; PUT /department/academic-term; PATCH /department/registration | settings: name, faculty, contact, **levels** only (a level can't be removed while students / courses use it; at least one level). code, matric code, id, active flag = system-level. Term: forward only, one step, new session starts FIRST, needs `confirm: true` (assignments are per-term so they go inert until renewed), audited |
| Students | GET /students (`search, level, academicSession, status, sort, page, limit`), GET /students/:id, PATCH /students/:id/status, GET /students/:id/courses, GET /students/:id/attendance, PATCH /students/:id/academic-record, POST /students/academic-record/bulk | suspend / reactivate onboarded students only (effective immediately); academic record = level (must exist in the department) + session; bulk is all-or-nothing and capped at 500; matric number, department, role, names can't change |
| Lecturers | GET / POST /lecturers, GET / PATCH /lecturers/:id, PATCH .../status, POST .../invitation, GET / POST .../courses, DELETE .../courses/:courseId | create = INVITED + emailed activation link (department = the HOD's; raw token never returned; email failure doesn't roll back, reissue available); update = name + phone; assignment reuses `LecturerCourseAssignment`: same department, current-term course, not suspended, no duplicates |
| Courses | GET / POST /courses, GET / PATCH /courses/:id, PATCH .../status | create: department = HOD's, level must be one the department offers, code normalised, unique per (department, code, session, semester), session current or next; code + session fixed afterwards; level / semester locked once students are enrolled or lecturers / reps assigned |
| Representatives | GET / POST /representatives, PATCH .../:id/status, DELETE .../:id | reuses `CourseRepresentativeAssignment`: student and course in the HOD's department, student ACTIVE **and enrolled in that course**, course in the current term, one Course Rep per course, max 2 assistants, no duplicate role; revoke is immediate and final. No student-facing way to create one, so nobody can appoint themselves |
| Timetable | GET /timetable, GET /timetable/conflicts | **read-only**: filters + venue / lecturer / level clash report. The Course Rep keeps ownership; there is no edit / override |
| Announcements | GET / POST /announcements, PATCH / DELETE .../:id | department-wide or level-targeted (never university-wide); only the HOD's own can be edited (lecturers' and reps' are visible, `NOT_OWNER` on change); delete is soft; publishing notifies the students |
| Documents / materials | GET / POST /documents, PATCH / DELETE .../:id, GET /materials | department documents are their own record type (`DepartmentDocument`), shown to students at `GET /student/department-documents`. `/materials` is a read-only view of lecturers' official materials and reps' class resources with their real owners: the HOD never owns or edits them |
| Attendance | GET /attendance (`courseId, lecturerId, state, from, to`), GET /attendance/statistics, GET /attendance/:sessionId | **read-only**: sessions, who marked + distance, flagged-attempt counts, per-course percentages, courses below 60% flagged. No create / mark / edit / delete route or method exists, and the student attendance path is untouched |
| Complaints | GET /complaints (`status, type, courseId, assignedLecturerId, from, to, search, sort`), GET .../:id, PATCH .../:id/status, POST .../:id/assign, POST .../:id/respond | student -> HOD review -> lecturer. Transitions are enforced (resolved can only close; rejected / closed are final); resolve needs a resolution, reject needs a reason; assign only to an ACTIVE lecturer of the department (for a course complaint, one assigned to that course this term); every step writes to the student-visible timeline and notifies the student (and the lecturer) |
| Notifications | GET /notifications, PATCH /notifications/read-all, PATCH /notifications/:id/read | same `Notification` collection (`recipientType: HOD`); a new student complaint notifies the department's current HOD |

**Audit.** `HodAuditLog` (actor, name, role, department, action, resource type + id, IP, detail, time) for lecturer create / reinvite / update / status / assign / unassign, course create / update / status, representative appoint / status / revoke, student status and academic-record changes, complaint status / assign / respond / resolve, announcements, documents, department settings, term and registration changes, HOD provisioning / activation, plus `ACCESS_DENIED` and `SCOPE_VIOLATION`. The dashboard's activity feed merges HOD, lecturer and representative logs of the department only.

**Models.** New: `Hod`, `HodAuditLog`, `DepartmentDocument`. Changed (all additions optional, old data stays valid): `Department` (+contact), `Course` (+description), `Announcement` (+createdByHod), `Complaint` (+assignedLecturer, assignedAt, resolution, resolvedAt, reviewedBy), `Notification` (+recipientType HOD). Reused unchanged: `Lecturer`, `LecturerCourseAssignment`, `CourseRepresentativeAssignment`, `Course`, `CourseEnrollment`, `AcademicTerm`, `TimetableEntry`, attendance models, `Student`.
Shared code changed: the lecturer login engine is now role-parameterised (HOD reuses it); `token.service` (+HOD audience); `email.service` (+HOD links); rate limiters (+HOD, keyed by HOD).
Student-side changes (additive): a new complaint notifies the HOD and is reviewed by the HOD first; the student complaint view shows `resolution` / `resolvedAt`; `GET /student/department-documents`.

**Environment variables:** none new. (`CLIENT_URL` is used for activation / reset links; Resend and Cloudinary settings as before.)

**Run it.** Seed order: departments, terms, courses, students, content, `seed:hods`, `seed:lecturers`, onboard students, `seed:representatives`, `seed:elections`. Activate a HOD with the printed link, then:
```bash
H=http://localhost:5000/api/v1/hod
curl -s $H/auth/activate -H 'Content-Type: application/json' -d '{"token":"<token>","password":"Str0ngPass","confirmPassword":"Str0ngPass"}'   # -> token $T
curl -s $H/auth/login -H 'Content-Type: application/json' -d '{"email":"hod.csc@university.example","password":"Str0ngPass"}'
curl -s $H/dashboard -H "Authorization: Bearer $T"
curl -s "$H/students?level=200&search=obi&limit=20&sort=lastName" -H "Authorization: Bearer $T"
curl -s -X PATCH $H/students/$S/status -H "Authorization: Bearer $T" -H 'Content-Type: application/json' -d '{"status":"SUSPENDED"}'
curl -s $H/lecturers -H "Authorization: Bearer $T" -H 'Content-Type: application/json' -d '{"firstName":"Ada","lastName":"Okoro","email":"a.okoro@university.example","staffId":"CSC-010"}'
curl -s $H/lecturers/$L/courses -H "Authorization: Bearer $T" -H 'Content-Type: application/json' -d '{"courseId":"'$C'"}'
curl -s $H/courses -H "Authorization: Bearer $T" -H 'Content-Type: application/json' -d '{"courseCode":"CSC301","title":"Algorithms","units":3,"level":"300","semester":"FIRST"}'
curl -s $H/representatives -H "Authorization: Bearer $T" -H 'Content-Type: application/json' -d '{"studentId":"'$S'","courseId":"'$C'","role":"COURSE_REP"}'
curl -s $H/announcements -H "Authorization: Bearer $T" -H 'Content-Type: application/json' -d '{"title":"Departmental meeting","content":"Friday 2pm, LT1","priority":"IMPORTANT"}'
curl -s "$H/attendance?state=OPEN" -H "Authorization: Bearer $T"; curl -s $H/attendance/statistics -H "Authorization: Bearer $T"
curl -s -X PATCH $H/complaints/$X/status -H "Authorization: Bearer $T" -H 'Content-Type: application/json' -d '{"status":"UNDER_REVIEW"}'
curl -s $H/complaints/$X/assign -H "Authorization: Bearer $T" -H 'Content-Type: application/json' -d '{"lecturerId":"'$L'"}'
curl -s $H/complaints/$X/respond -H "Authorization: Bearer $T" -H 'Content-Type: application/json' -d '{"message":"We are looking into this."}'
# must all fail:
curl -s -X PATCH $H/profile -H "Authorization: Bearer $T" -H 'Content-Type: application/json' -d '{"role":"SUPER_ADMIN"}'                 # 422
curl -s "$H/students?departmentId=<another department>" -H "Authorization: Bearer $T"                                                       # 403 DEPARTMENT_SCOPE_VIOLATION
curl -s $H/students/<an MLS student id> -H "Authorization: Bearer $T"                                                                       # 404
```

**Tests (`npm test`, 197).** `tests/hod.test.ts` (28, the engine against an in-memory store with the Mongo store's department filters): dashboard isolation; a CSC HOD vs every MLS resource type (35 attempts, all 404 and audited) and the reverse; IDOR; students list / search / filter / sort / paginate / view / status / academic record / bulk; lecturers create / invite / update / status / assignment rules; courses create / duplicates / levels / sessions / structure lock / archive; levels; settings; term; registration; representative appointment preconditions, status, revoke; timetable read-only + conflicts; announcements; documents + materials; attendance oversight read-only; complaint list / filter / review / assign / respond / resolve / reject / close and isolation; notifications; privilege escalation; activity feed; audit trail.
`tests/hod-auth.test.ts` (6): login, invalid, lockout, inactive / invited / replaced, JWT validation (tampered, expired, lecturer / student tokens refused), role / department from the database, activation. `tests/hod-guards.test.ts`: policy rules, the exact route table (no signup, no attendance / timetable write, no election / campus-hub), every route behind the HOD guard chain, strict schemas, provisioning not reachable over HTTP, existing protections still present.
Regression: the Student, Course Rep, Lecturer and attendance-security suites all still pass unchanged.
**Not run here** (no network / database): the Express wiring and zod strictness over HTTP, the Mongo store / provisioning service / seeder, JWT signing (an HMAC stand-in is used in the auth tests; the audience check is what's tested), bcrypt, Cloudinary and Resend.

**Known limits / next.** A forwarded complaint reaches the lecturer as a notification only; lecturer-side complaint handling is not part of the lecturer backend yet. No bulk term rollover (move students level by level with the bulk endpoint). Next stage: the Departmental Election System (the HOD / election-admin side).


## HOD election management (`/api/v1/hod/elections`)

Same auth chain as the rest of `/hod` (HOD token, current + active HOD, department scope). The department is always the HOD's own; another department's election, position or candidate id answers 404 and is audited as `ACCESS_DENIED`.

**Status** is derived: `DRAFT` and `CANCELLED` are stored; `SCHEDULED` (published, before the start), `ACTIVE` (inside the window) and `CLOSED` follow the clock, so voting opens and closes by itself. *Open now* moves the start to the present, *Close now* ends the window; the student endpoints keep using the same window, so nothing else changes.

| Method | Path | Notes |
|---|---|---|
| GET / POST | `/elections` | list (`?status=DRAFT\|SCHEDULED\|ACTIVE\|CLOSED\|CANCELLED&search=&page=&limit=`) / create a draft |
| GET / PATCH / DELETE | `/elections/:id` | detail with positions and every candidate / edit before voting starts / delete a **draft** |
| GET | `/elections/:id/readiness` | what still blocks publishing |
| POST | `/elections/:id/publish` \| `open` \| `close` \| `cancel` | Draft to Scheduled / begin voting now / end voting now / call off |
| GET | `/elections/:id/turnout` | counts only, available once published |
| GET | `/elections/:id/results` | **403 until the election has closed**; ranked tallies, winners, ties |
| PUT | `/elections/:id/results-release` | `{published}`; shows / hides results to eligible students (closed only) |
| GET | `/elections/student-search?search=&level=` | active students of the department, no contact details |
| GET | `/elections/:id/group-members` | members of a `GROUP` electorate |
| GET / POST | `/elections/:id/positions` | list / add |
| PUT | `/elections/:id/positions/order` | `{positionIds:[...]}` (every position once) |
| PATCH / DELETE | `/elections/:id/positions/:positionId` | edit / remove (removes its candidates) |
| GET / POST | `/elections/:id/candidates` | POST is JSON or multipart (`positionId`, `studentId`, `manifesto`, `approve`, optional `photo` file) |
| PATCH / DELETE | `/elections/:id/candidates/:candidateId` | manifesto / remove |
| PATCH | `/elections/:id/candidates/:candidateId/decision` | `{decision:"APPROVED"\|"REJECTED"}` |
| PUT / DELETE | `/elections/:id/candidates/:candidateId/photo` | multipart field `photo` (JPEG / PNG / WebP, checked from the bytes) / remove |

Create body: `{title, description?, academicSession? (defaults to the current term), votingOpensAt, votingClosesAt, electorate?: {mode: "DEPARTMENT"} | {mode: "LEVELS", levels: ["200"]} | {mode: "GROUP", studentIds: [...]}}`.

Rules enforced in the service:
- **Frozen once voting can start.** Details, electorate, schedule, positions and candidates change only while `DRAFT` or `SCHEDULED`; later attempts get 409 `ELECTION_LOCKED`. Only drafts are deleted; scheduled / active elections are cancelled and keep their records.
- **Candidates are HOD-controlled.** Only an existing, active student of the department can be added, only by the HOD (there is no student route), starting `PENDING`; only `APPROVED` candidates reach a ballot. A student can stand for one position per election.
- **Publishing needs** at least one position, an approved candidate in every position, at least one eligible voter, and a start time in the future.
- **Nothing leaks early.** Candidate tallies are unreadable until voting has closed; turnout exposes counts only, never who voted for whom.
- **Candidate photos** go to Cloudinary (`portal/election-candidates`, 600px square) and are deleted when replaced / removed / the candidate or position is deleted. Students see the candidate photo, falling back to the student's profile photo.
- Every action is written to the HOD audit log (`ELECTION_*` actions).

## Lecturer complaints (`/api/v1/lecturer/complaints`)

Lecturers work on complaints the HOD **forwarded to them**. There is no separate complaint system: it is the same `Complaint` record and `timeline` the student and HOD APIs use. The HOD's "forward" sets `assignedLecturer` (+ `assignedAt`, status `ASSIGNED`); a lecturer's list is simply "complaints in my department whose `assignedLecturer` is me", with the lecturer id taken from the token.

| Method | Path | Notes |
|---|---|---|
| GET | `/complaints` | `?status=&courseId=&from=&to=&search=&sort=&order=&page=&limit=`; title, description, student name + matric number (no contact data), course, submitted / forwarded dates, status, the HOD's forwarding message |
| GET | `/complaints/:complaintId` | full detail, signed attachment links, resolution, timeline |
| GET | `/complaints/:complaintId/history` | the complaint's timeline: forwarding, lecturer / HOD replies, status changes, who and when |
| POST | `/complaints/:complaintId/respond` | `{message, visibleToStudent?}`; the first reply to a freshly forwarded complaint acknowledges it (`ASSIGNED` to `IN_PROGRESS`) |
| PATCH | `/complaints/:complaintId/status` | `{status: "IN_PROGRESS" \| "UNDER_REVIEW", note?, visibleToStudent?}` |

Rules:
- **Scope.** Not forwarded to you, forwarded to someone else, another department's, or missing: the same audited `404`.
- **The HOD decides.** A lecturer can set only `IN_PROGRESS` or hand the complaint back (`UNDER_REVIEW`, note required, used for a recommendation). Resolving, rejecting, closing and re-forwarding stay on the HOD routes (`403 HOD_ONLY_ACTION` if attempted). After a hand-back the lecturer can still reply but not change the status. Replies are refused once the HOD has resolved or closed it.
- **No lost updates.** Each write is conditional on the complaint still being assigned to you and in the status you read, so a concurrent HOD decision is never overwritten (`409 COMPLAINT_CHANGED`).
- **Visibility.** Timeline events gain optional `byId`, `byName` and `internal`. Replies and "in progress" are visible to the student by default; a hand-back is HOD-only by default (`internal: true`). Internal events are filtered out of the student API and shown to the HOD and lecturer.
- **Notifications.** The HOD is told of every lecturer reply / status change; the student only of visible ones.
- **Audit.** `COMPLAINT_RESPONDED` and `COMPLAINT_STATUS_CHANGED` in the lecturer audit log.

## Lecturer names on courses
Every course view now carries `lecturers`: the lecturers with an ACTIVE assignment on that course (suspended lecturers and other departments are never shown).
- **HOD** `GET /hod/courses` and `/hod/courses/:id`, **Lecturer** `GET /lecturer/courses`, `/lecturer/courses/:id` and the dashboard: `lecturers: [{ lecturerId, name }]` (co-lecturers see each other).
- **Student** my courses, available courses, carryover options, course history and add / update registration: `lecturers: [{ name }]` only (no id, email or phone).

## Push notifications (Web Push)

Browser push is layered on the **existing in-app notification system**: every workflow already creates its notification through `notify()`. After a notification is saved, `notify()` fires push without awaiting it, so a push problem can never fail or undo the original action, and the in-app entry always exists. Push subscription means "this browser/device is registered"; it is not a paid membership.

**What is pushed** (everything else stays in-app only): announcements, timetable and course-material updates, assignments (published, plus a deadline reminder), and complaint events (student updates, HOD forwarding to a lecturer, lecturer response, HOD status/resolution). Campus Hub / Market are not involved. Recipients are exactly the users the existing workflow already chose (department, course enrolment, lecturer assignment); a device only receives notifications of the department it is registered in.

**Lock-screen privacy.** Complaint pushes always read "Complaint update: open the portal to view it": no reference, title, names or message text. Other pushes show the public title and a short body.

### Setup
1. `npm install` (adds `web-push`, and `@types/web-push` for development).
2. Generate VAPID keys once: `npx web-push generate-vapid-keys`.
3. Set in `.env` (all three, or none to keep push off): `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` (secret, never commit or expose), `VAPID_SUBJECT=mailto:you@university.edu`. Optional: `PUSH_EXTRA_ENDPOINT_HOSTS`, `PUSH_MAX_DEVICES_PER_USER` (default 10).
4. Frontend: host `frontend-push/sw.js` at the **root of the portal's origin** (`/sw.js`) over **HTTPS** (localhost is allowed in development); copy `frontend-push/push-client.js` into the app. iOS/iPadOS only supports web push for a portal added to the Home Screen.
5. Deadline reminders: schedule `npm run reminders:deadlines` hourly (cron or your host's scheduler). It is idempotent: each student is reminded once per assignment.

### Endpoints
The same 8 routes exist under `/api/v1/student` (reps included), `/api/v1/lecturer` and `/api/v1/hod`, each behind that API's own authentication. The owner is always the authenticated user.

| Method | Path | Notes |
|---|---|---|
| GET | `/push/config` | `{supported, publicKey}`: the public key only |
| POST | `/push/subscriptions` | body = the browser's `subscription.toJSON()` (+ optional `deviceLabel`); registers this device |
| DELETE | `/push/subscriptions` | `{endpoint}`: removes this device (own devices only, idempotent) |
| GET | `/push/subscriptions` | your devices (no endpoints or keys) |
| DELETE | `/push/subscriptions/:id` | remove one of your devices |
| GET / PUT | `/push/preferences` | `{pushEnabled, categories: {announcements, timetablesAndMaterials, assignments, complaints}}`; affects push only, never in-app history |
| POST | `/push/test` | sends a fixed test message to your own devices |

### Security notes
- The endpoint URL is called by the server, so only https URLs on known browser push services are accepted (Chrome/Edge/FCM, Firefox, Safari, Windows), preventing server-side request forgery. Encryption keys are `select: false` and never returned.
- A browser profile (endpoint) belongs to one user at a time: registering it after signing in as someone else moves it to them. **Call `disablePush()` on logout** and `syncPush()` after login (see `push-client.js`).
- 404/410 from the push service deletes the device; other errors are counted and the device is deactivated after 5 consecutive failures (re-registering reactivates it).
- Notification clicks only ever open same-origin portal paths (validated on the server and again in the service worker).

### Known limits
- Lecturers are not pushed HOD department-wide announcements: they have no API to read them yet.
- This repository contains no frontend; the bell/unread UI, enable button and preference screen must be wired in the actual frontend (the existing `GET /notifications` endpoints already return `unreadCount`).
- Verified by automated tests with a fake push transport and the service worker's handlers run in a sandbox. **Not yet verified** with the real `web-push` library, a real MongoDB (the new Mongo store and the idempotent `bulkWrite` in `notify()`), or in a real browser with permission granted.

## Corrections: level-wide representatives, announcement images, timetable course selection

**Representatives are appointed for a level, not a course.** `POST /hod/representatives` takes `{ studentId, level, role }` (no `courseId`); the term is the department's current term. One Course Rep and up to two Assistants per level per term; a student holds one role per level per term. A level appointment covers every course of that level this term and the whole class. It reuses `CourseRepresentativeAssignment`: appointments created before this change keep working as course-scoped until the HOD replaces them. **Run once after deploying: `npm run migrate:rep-levels`** (marks old appointments `scope: "COURSE"` and rebuilds the indexes with the new per-level uniqueness rules).

**Announcement pictures (HOD, lecturer, course rep).** The create / update announcement endpoints accept JSON as before, or `multipart/form-data` with an optional `image` file (JPEG / PNG / WebP, checked from the bytes, max `MAX_ANNOUNCEMENT_IMAGE_MB`, default 5). On update, send a new `image` to replace it or `removeImage=true` to remove it; deleting an announcement removes its picture. Responses carry `image: { url } | null` (students too). Rep announcements: `courseId` is now optional: leave it out to announce to the rep's whole level, or pass a course of their level.

**Timetable.** `POST /representative/timetable` takes `courseId` (required; one of the courses of the rep's level), and no longer takes `lecturerName`: the lecturer(s) are read from the course's lecturer assignments. The title defaults from the course ("CSC201 Lecture"). `venue` is optional (omit, `null` or empty; clear it on update with `null` / `""`). `GET /representative/courses` returns each course with its `lecturers`, for the course picker.

**Lecturers no longer see course reps' announcements** (not in the list, not on the dashboard, and a rep's announcement id answers 404).

### Lecturer venue accuracy
When a lecturer sets the venue from the browser, `accuracyMeters` (from `coords.accuracy`) must be at most `ATTENDANCE_CREATOR_MAX_ACCURACY_METERS` (default 100, max 1000), because every student is measured against the venue centre. A rejection returns `422 LOCATION_ACCURACY_LOW` with `errors: { accuracyMeters, maxAccuracyMeters, approximate }` (the API puts error details under `errors`); `approximate: true` (over 1 km) means the device has no GPS / Wi-Fi fix and is guessing from its internet connection (typical on a laptop or desktop).

## Real-time notifications (Socket.IO)
Socket.IO runs on the same port as the API and is **push-only**: the server delivers live updates to the signed-in user; clients cannot send events, join rooms or choose recipients. It complements (does not replace) the REST notification endpoints and browser push: `notify()` saves the in-app notification first, then fires push and the live socket event without awaiting either, so neither can fail the original action.

- **Install:** `npm install` (adds `socket.io`); in the frontend `npm install socket.io-client` and use `frontend-realtime/realtime-client.js`.
- **Auth:** the client passes `{ token, role }` in the handshake `auth` (`role` = `student` | `lecturer` | `hod`, only to pick the verifier). Tokens are verified with exactly the HTTP API's rules (students share `loadActiveStudent`; lecturer / HOD use their existing auth services, so suspended or removed accounts and other audiences' tokens are refused). The token is never read from the URL. All failures return the same generic message; failed handshakes are limited per IP.
- **Rooms:** a socket joins only `user:<TYPE>:<id>` for its own verified account.
- **Events to the client:** `ready { role, unreadCount }` on connect; `notification:new { id, kind, title, body, link, complaintId, read, createdAt }` for every new notification (same shape as `GET /notifications`); `notification:read { id } | { all: true }` when the user marks notifications read on another tab/device.
- **Limits:** at most 5 sockets per user (oldest dropped); a session lasts at most `SOCKET_MAX_SESSION_MINUTES` (default 60) before the client reconnects with a fresh token, so revoked access stops quickly. `SOCKET_ENABLED=false` turns it off.
- **CORS:** the same `CLIENT_ORIGINS` allow-list as the API.
- **Scaling note:** rooms live in one process. Behind several server instances you need the Socket.IO Redis adapter (not included) so an event emitted on one instance reaches a socket connected to another; sticky sessions are also required for the polling transport (or use websocket-only).
- **Tested** with fakes (handshake rules, rooms, delivery, limits, wiring). **Not yet tested** with the real `socket.io` library or a browser: please connect once from the frontend and watch for `ready` and `notification:new`.

## Network status banner and staying signed in (frontend-session/)

**Backend**
- `GET /api/v1/ping` (also `HEAD`): no login, no database, `204`, never cached. It sits before the global rate limiter on purpose (campus NAT puts many users behind one IP) with its own very high ceiling.
- Session-ending responses now carry a machine-readable `code`: `TOKEN_EXPIRED`, `TOKEN_INVALID`, `PASSWORD_CHANGED` (all three roles), plus `ONBOARDING_REQUIRED`, `ACCOUNT_INACTIVE`, `DEPARTMENT_INACTIVE` on students. The frontend can sign out only when a session truly ended.
- At startup the server logs a warning if `JWT_EXPIRES_IN` is under 1 day (the default is `7d`; a short value signs people out whenever they are away that long).

**Frontend files (framework-agnostic, `NetworkBanner.jsx` is React)**
- `network-monitor.js`: probes `/ping` and reports `online`, `unstable` or `offline` (with messages "No network connection..." / "Your network is unstable..." / "You're back online."). Instant on the browser's offline event, paused in hidden tabs, faster probing while things are bad, and "back online" only after consecutive good probes. `monitor.setSocketConnected(bool)` feeds in the Socket.IO state.
- `api-client.js`: signs the user out ONLY on 401 with `TOKEN_EXPIRED` / `TOKEN_INVALID` / `PASSWORD_CHANGED`. A network error (`NetworkError`), 429, 5xx, 403 or any other 401 never does. It also reports every request to the monitor.
- `session-store.js`: keeps the token in `localStorage` (never `sessionStorage`), survives closed tabs and locked phones, falls back to memory if storage is blocked, and syncs logout across tabs.
- Wire-up: `const monitor = new NetworkMonitor({ pingUrl: API + "/api/v1/ping" }); monitor.start();` then `<NetworkBanner monitor={monitor} />` once near the app root, and `createApiClient({ baseUrl, session, monitor, onSessionEnded })` for all calls. Disable attendance marking and other writes while `status === "offline"`.

### Attendance location tolerance
A phone's location is an estimate: two devices lying side by side routinely report positions 20-80 m apart (more indoors), and each reading says how uncertain it is (`accuracy`). The server therefore widens the allowed radius by the **combined uncertainty** (the student's accuracy plus the venue's, which is now saved with the session when the lecturer sets it), **capped** at `ATTENDANCE_ACCURACY_ALLOWANCE_MAX_METERS` (default 50; `0` = strict radius). The cap exists because accuracy is reported by the device and must not become a way to stretch the area. Distance is still computed on the server.

A rejected student now gets `403 LOCATION_OUTSIDE_RADIUS` with a message such as "You appear to be about 150 m from the attendance location (allowed: 60 m)..." and `errors: { distanceMeters (rounded to 10 m), allowedRadiusInMeters, accuracyAllowanceMeters, effectiveRadiusMeters, yourAccuracyMeters }`. Set `ATTENDANCE_SHOW_DISTANCE=false` for the old generic message. The exact distance is always kept in the audit log, and the lecturer's session view shows `venueAccuracyMeters`.

Practical advice: GPS cannot tell rooms apart, so use a radius of roughly 50-100 m for a classroom building, and set the venue from a phone, outdoors or by a window.

## Live quiz
Implements the "Live quiz: API contract". A class rep writes quizzes and hosts a game; students of that class enter a 6-digit PIN and answer on their phones; the **server owns the clock, the phase and the scores**.

- **REST (rep):** `/api/v1/representative/quizzes[/:id]`, `POST /quizzes/:id/games`, `/quiz-games`, `/quiz-games/:gameId`, `.../start`, `.../end-question`, `.../next`, `.../cancel`, `DELETE .../players/:playerId`. **REST (student):** `/api/v1/student/quiz/join`, `/active`, `/results`, `/games/:gameId`, `.../answer`, `.../leave`, `.../result`.
- **Real-time** (the existing Socket.IO connection, to the students' personal rooms): `quiz:state` (host: `HostState`; each player: their own `PlayerState`, sent on every phase change and on every lobby change for the host), `quiz:lobby { gameId, count }` (players, no names), `quiz:progress { gameId, questionIndex, answered, total }` (host, at most ~4/s).
- **Permissions:** `quiz:manage` and `quiz:host` are in the representative permission table for both Course Rep and Assistant (edit `ROLE_PERMISSIONS` to change that). A rep only ever reaches their own quizzes and games. The quiz's level comes from the rep's appointment.
- **State machine:** `LOBBY -> QUESTION -> REVEAL -> ... -> FINISHED`, or `CANCELLED`. Every change is a compare-and-set, so a timer, "everyone answered" and the host button racing give exactly one reveal. Scores are applied at the reveal, so nobody can read their result off a score change before time is up. Players never receive `correctIndex` before the reveal.
- **Time:** an answer is accepted until `endsAt + 1 s` (latency grace); the automatic reveal comes after that grace, so an answer sent at the last moment still counts. Speed is `received - questionStartedAt` on the server. Points, streak bonus, ranking (score, then lower total time over correct answers, then earlier join, so ranks are unique) and the fastest-three are exactly as in section 4a.
- **Housekeeping:** `resume()` at startup re-arms the clock of any running question (games are not cancelled by a restart); `sweepIdle()` every minute cancels games with no host action for 30 minutes (automatic reveals do not count as host activity).
- **Limits:** the live quiz paths are exempt from the per-IP global limiter (a class shares one campus IP and polls every few seconds) and use per-student limits instead; PIN entry is limited to 30 tries per 10 minutes.
- **Error codes** are those in section 9, plus `INVALID_NICKNAME`, `INVALID_QUIZ`, `INVALID_CHOICE`, `INVALID_ANSWER`, `QUIZ_NOT_FOUND`, `ALREADY_IN_GAME`, `GAME_FULL`. No session-ending code (`TOKEN_*`, `PASSWORD_CHANGED`) is used for anything else.
- **Choices to know about:** a student who is already a player gets their player back when they enter the PIN again, in any phase (so a refresh mid-game works). Nicknames allow letters, numbers, spaces, `. _ ' -` and emoji in any language, 2 to 20 visible characters (an emoji family counts as 1); markup, control and invisible characters are rejected. A game is capped at 500 players. A removed student receives a `quiz:state` with `phase: "CANCELLED"` and a 403 `NOT_ELIGIBLE` afterwards.
- **Limits of this version:** timers live in one process, so run a single instance (or sticky sessions plus the Socket.IO Redis adapter). An answer that reaches the server in the few milliseconds while a question is being closed can be stored without being scored. Tested with an in-memory store and a fake clock; **not yet run against a real MongoDB or the real app**.

### Playing for money (the live quiz pays dollars, not points)
Every old "point" is now **one dollar**, so the numbers did not change (a lightning-fast correct answer is worth **$1,000**, down to **$500** at the last second). All existing fields (`score`, `points`, `streakBonus`) keep their names and stay plain integers, so an older frontend keeps working; the fields below are **added** next to them and are ready to show.

| What | Rule |
|---|---|
| **Cash per answer** | `$1,000` (instant) down to `$500` (last second); wrong or no answer = `$0` and the streak resets |
| **Hot-streak bonus** | `$0, $100, $200 ...` for consecutive correct answers, capped at `$500` (`streakBonus`) |
| **JACKPOT question** | The rep flags a question with `"jackpot": true` (create/update a quiz). It pays **double** (base + streak bonus). Players are told with the question (`question.jackpot`), before they answer |
| **Net-worth title** | Judged against `$1,000 x questions`, so a short and a long quiz mean the same: `Broke` (0), `Pocket Change`, `Saving Up` (20%), `Big Spender` (40%), `High Roller` (60%), `Millionaire` (80%), `Billionaire` (100%). Players level up as the game goes on |

**New fields** (all additive):
- `PlayerState.me`: `scoreText` (`"$12,500"`), `tier { level, id, title, emoji }`.
- `PlayerState.question`: `jackpot`. `HostState.question` and `HostState.reveal`: `jackpot`.
- `PlayerState.reveal`: `pointsText`, `scoreText`, `jackpot`, `tier`, `headline` (the cash-register line, for example `"🎰 JACKPOT! +$1,900"`, `"🔥 3 in a row! +$1,150"`, `"⚡ Fastest hands in the room! +$1,050"`, `"💰 Cha-ching! +$950"`, `"💸 Ouch! No cash this round."`), and `levelUp` (the new `tier` when this answer lifted the player into a higher title, otherwise `null`: show the celebration when it is set).
- Every leaderboard row (`topFive`, `top`, `leaderboard`): `scoreText`, `tier`. `PlayerState.final`: `scoreText`, `tier`.
- Results (`/results`, `/games/:gameId/result`): `scoreText`, `tier`, and per question `pointsText`, `jackpot`.

Quizzes saved before this change have no jackpot questions and behave exactly as before.

#### Cash drops
After each question is paid out, **the player who answered correctly fastest steals 5% of the leader's cash** (capped at $500, in whole tens). Nobody is robbed when the fastest player *is* the leader, when nobody was right, or when the leader has under $200. The money moves between players; none is created. The leader is judged **after** this question's prizes are paid. Ties for fastest go to whoever the server received first.

#### True/false questions
A question has an optional `"type"`: `"MULTIPLE_CHOICE"` (the default) or `"TRUE_FALSE"`. A true/false question needs **no `options`**: its answers are always `["True", "False"]` (index `0` = True, `1` = False), and `correctIndex` is `0` or `1`. If a client does send `options`, they must be True then False. It can also be a jackpot. Players answer it with the same `POST .../answer` call (`choice` 0 or 1).
```json
{ "text": "The sun is a star.", "type": "TRUE_FALSE", "correctIndex": 0, "jackpot": false }
```

**More new fields** (all additive; older clients ignore them):
- `PlayerState.question.type`, `PlayerState.reveal.type`, `HostState.question.type`, `HostState.reveal.type`: `"MULTIPLE_CHOICE" | "TRUE_FALSE"` (so the frontend can draw two big True / False buttons). Results review questions carry `type` too.
- `PlayerState.reveal`: `cashDrop` (`null` or `{ amount, amountText, thief: { nickname, you? }, victim: { nickname, you? }, message }`; `message` is already written for the reader, for example `"😱 CY stole $180 from you!"`), `change` / `changeText` (everything that happened to this player's money on the question, the answer and any drop together, for example `"+$950"` or `"-$120"`), and `levelDown` (the lower tier when a robbery demoted the player; the counterpart of `levelUp`). `points` is still just what the answer itself paid.
- `HostState.reveal`: `cashDrop` (same shape, written for the room: `"🦹 CY stole $180 from the leader, ADA!"`).
 The currency symbol is `$` (US dollars) in the `*Text` fields; the numbers themselves are plain integers if the frontend prefers its own formatting.

## Sign-in rate limits
A whole class shares one campus Wi-Fi IP, so the public sign-in routes are limited **per person, not per IP** (`src/middleware/rateLimiters.ts`). Each limiter is a pair: a per-identity limit and a generous per-IP flood backstop.

| Routes | Limited by | Allowance | Counts |
|---|---|---|---|
| `/auth/login` (student, lecturer, HOD) | email (trimmed, lower case) | 10 per 15 min | failed attempts only |
| `/onboarding/verify` | matric number | 10 per 15 min | failed attempts only |
| `/auth/forgot-password` (all roles) | email | 5 per hour | **every** request (each one sends a mail) |
| `/onboarding/complete`, `/auth/reset-password`, `/auth/activate` | IP only (the request already carries a signed or random token) | flood backstop | failed attempts only |

One student's typos therefore never block a classmate, and a successful sign-in never uses up the allowance. A request with no email or matric number is counted under the IP. Set `TRUST_PROXY` correctly in production, otherwise every user appears to come from the proxy's IP and the IP backstop is shared by everyone. The global per-IP limit is 6,000 requests per 15 minutes, and the live quiz paths are exempt from it.

## AI complaint assistant (`/api/v1/student/complaints/ai-assist`)

Powers the **Improve with AI** button on the complaint form. It is stateless: it returns a suggestion and saves nothing, so the student stays in control ("nothing changes until you approve it").

### Setup
Add to `.env` (no new npm package: it uses Node's built-in `fetch`). Leave the key empty to switch the feature off.

```
GEMINI_API_KEY=AIza...              # FREE: https://aistudio.google.com/apikey (no card; rate limits apply)
# ANTHROPIC_API_KEY=sk-ant-...      # paid alternative: https://console.anthropic.com
# AI_PROVIDER=gemini                # optional: "gemini" or "anthropic". When unset, the provider whose key is set is used (Gemini first)
# AI_MODEL=gemini-2.5-flash-lite    # optional. Defaults: gemini-2.5-flash-lite / claude-haiku-5-5
AI_TIMEOUT_MS=25000                 # optional
PORTAL_TIMEZONE=Africa/Lagos        # optional; the date printed on a letter
```

**Free tier and privacy.** The Gemini free tier has rate limits (a handful of requests per minute, shared by *all* students, and a daily cap), so at busy times students may see "the AI assistant is busy": the form itself keeps working. Google's free-tier terms also allow it to use submitted content to improve its products, and human reviewers may read it. Complaint drafts are personal, so tell students not to put passwords or sensitive details in the text, and consider a paid key (Gemini paid tier or Anthropic) before a wide rollout. Limits and terms change; check https://ai.google.dev/gemini-api/docs/rate-limits.

### Endpoints (student token required)

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/complaints/ai-assist` | `{ available, minMessageChars, maxMessageChars, actions: [{ id, label, description, target }] }`. Use `available` to show/hide the button and `actions` to draw the cards. |
| `POST` | `/complaints/ai-assist` | Run one action on the current draft (below). |

`POST` body (strict; unknown fields are rejected):

```json
{ "action": "IMPROVE", "message": "at least 20 characters...", "title": "optional", "courseId": "optional" }
```

| `action` | Result | `target` (where to put it if the student accepts) |
|---|---|---|
| `IMPROVE` | Better wording and structure | `message` |
| `PROFESSIONAL` | Formal, respectful tone | `message` |
| `GRAMMAR` | Spelling and punctuation only | `message` |
| `CLEARER` | Shorter, easier to follow | `message` |
| `SUMMARIZE` | Short summary (about 60 words) | `none` (display only) |
| `SUGGEST_TITLE` | One clear title (max 150 chars) | `title` |
| `DRAFT_LETTER` | The complaint written as a formal letter to the Head of Department | `letter` |

Response: `{ success, data: { action, target, result } }`. For `DRAFT_LETTER`, `data` also has `body` (just the paragraphs, for the message field) and `letter` (`senderLines`, `date`, `recipientLines`, `salutation`, `subject`, `paragraphs`, `closing`, `signatureLines`) so the frontend can lay it out or print it; `result` is the whole letter as plain text.

`courseId` is optional context (a course of the student's own department) used only to name the course in a title or letter.

### How it stays safe
- The student's identity in a letter (name, matric number, level, department, faculty, date) comes from the authenticated student's record. The model only writes the subject and body, so it cannot invent or change who the letter is from.
- The draft is fenced as data and any tag-like text inside it is removed, so a complaint that says "ignore your instructions" is just treated as text. The prompt also forbids inventing facts, names, dates or accusations.
- A cut-off or empty reply is rejected rather than returned, so a suggestion can never silently drop the end of a complaint.
- Limited to 30 calls per student per hour (`aiAssistLimiter`). Complaint text is sent to the AI provider (that is the feature) but is never logged.

Errors: `422` draft too short/long or bad field, `503` assistant off (`AI_NOT_CONFIGURED`), unavailable or busy, `504` timed out, `502` the model returned an unusable reply (try again).

Tests: `tests/complaint-ai.test.ts` (prompts, cleaning, letter assembly, provider error handling with a fake `fetch`, validator).
