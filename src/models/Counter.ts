import { Schema, model } from "mongoose";

/** Atomic sequence generator (e.g. complaint reference numbers). */
const counterSchema = new Schema<{ _id: string; seq: number }>({ _id: { type: String, required: true }, seq: { type: Number, default: 0 } });
export const Counter = model<{ _id: string; seq: number }>("Counter", counterSchema);

export async function nextSequence(key: string): Promise<number> {
  const doc = await Counter.findOneAndUpdate({ _id: key }, { $inc: { seq: 1 } }, { upsert: true, new: true });
  return doc.seq;
}
