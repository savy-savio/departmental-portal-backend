import type { Types } from "mongoose";
import { Notification, NotificationDocument } from "../models/Notification";
import type { StudentDocument } from "../models/Student";
import { AppError } from "../utils/AppError";
import type { NotificationKind } from "../utils/constants";
import { logger } from "../utils/logger";
import { dispatchPushSafely } from "./push";
import { realtime } from "../realtime/instance";
import type { PushableNotification } from "./push/rules";
import { pageMeta } from "./student-context.service";

export interface NewNotification {
  recipient: Types.ObjectId;
  recipientType?: "STUDENT" | "LECTURER" | "HOD";
  department: Types.ObjectId;
  kind: NotificationKind;
  title: string;
  body: string;
  complaintId?: Types.ObjectId;
  link?: string;
  /** Optional idempotency key: a second notify() with the same (recipient, key) is ignored (no duplicate in-app entry, no second push). */
  dedupeKey?: string;
}

const toPushable = (n: { _id: unknown; recipient: unknown; recipientType?: string; department: unknown; kind: string; title: string; body: string; link?: string | null; complaintId?: unknown }): PushableNotification => ({
  id: String(n._id), recipientId: String(n.recipient), recipientType: (n.recipientType ?? "STUDENT") as PushableNotification["recipientType"], departmentId: String(n.department),
  kind: n.kind, title: n.title, body: n.body, link: n.link ?? null, complaintId: n.complaintId ? String(n.complaintId) : null,
});

/**
 * Used by every feature (and by HOD / lecturer / course-rep phases later) to notify students.
 * Best-effort: a notification failure must never fail the action that triggered it.
 */
export async function notify(input: NewNotification | NewNotification[]): Promise<void> {
  const items = Array.isArray(input) ? input : [input];
  if (!items.length) return;
  try {
    const plain = items.filter((i) => !i.dedupeKey);
    const keyed = items.filter((i) => i.dedupeKey);
    const created: PushableNotification[] = [];

    if (plain.length) {
      const docs = await Notification.insertMany(plain);
      created.push(...docs.map(toPushable));
    }
    if (keyed.length) {
      // Idempotent: upsert on (recipient, dedupeKey); only rows that were actually inserted are reported (and pushed).
      const res = await Notification.bulkWrite(
        keyed.map(({ recipient, dedupeKey, ...rest }) => ({ updateOne: { filter: { recipient, dedupeKey }, update: { $setOnInsert: { ...rest, recipientType: rest.recipientType ?? "STUDENT" } }, upsert: true } })),
        { ordered: false },
      );
      for (const [idx, _id] of Object.entries(res.upsertedIds ?? {})) created.push(toPushable({ ...keyed[Number(idx)], _id }));
    }
    // The notification is saved. Browser push is a separate, best-effort step that is NOT awaited: it can't delay or fail the caller.
    dispatchPushSafely(created);
    // ...and the live feed for anyone with the portal open (Socket.IO). Also not awaited, also never throws.
    realtime.emitNotifications(created);
  } catch (err) {
    logger.error("Failed to create notification:", err instanceof Error ? err.message : err);
  }
}

const dto = (n: NotificationDocument) => ({
  id: String(n._id),
  kind: n.kind,
  title: n.title,
  body: n.body,
  complaintId: n.complaintId ? String(n.complaintId) : null,
  link: n.link ?? null,
  read: Boolean(n.readAt),
  createdAt: (n as unknown as { createdAt: Date }).createdAt,
});

export async function listNotifications(student: StudentDocument, q: { page: number; limit: number; unread?: boolean }) {
  const filter = { recipient: student._id, ...(q.unread ? { readAt: { $exists: false } } : {}) };
  const [rows, total, unreadCount] = await Promise.all([
    Notification.find(filter).sort({ createdAt: -1 }).skip((q.page - 1) * q.limit).limit(q.limit),
    Notification.countDocuments(filter),
    Notification.countDocuments({ recipient: student._id, readAt: { $exists: false } }),
  ]);
  return { items: rows.map(dto), unreadCount, ...pageMeta(q.page, q.limit, total) };
}

export async function markRead(student: StudentDocument, id: string) {
  // Recipient is part of the query: someone else's notification id is just "not found".
  const n = await Notification.findOneAndUpdate(
    { _id: id, recipient: student._id },
    { $set: { readAt: new Date() } },
    { new: true },
  );
  if (!n) throw new AppError(404, "Notification not found.");
  return dto(n);
}

export async function markAllRead(student: StudentDocument): Promise<number> {
  const res = await Notification.updateMany({ recipient: student._id, readAt: { $exists: false } }, { $set: { readAt: new Date() } });
  return res.modifiedCount;
}
