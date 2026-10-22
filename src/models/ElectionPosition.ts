import { HydratedDocument, Schema, Types, model } from "mongoose";

export interface IElectionPosition {
  election: Types.ObjectId;
  department: Types.ObjectId;
  title: string;
  description?: string;
  order: number;
}

const positionSchema = new Schema<IElectionPosition>(
  {
    election: { type: Schema.Types.ObjectId, ref: "Election", required: true, immutable: true },
    department: { type: Schema.Types.ObjectId, ref: "Department", required: true, immutable: true },
    title: { type: String, required: true, trim: true, maxlength: 120 },
    description: { type: String, trim: true, maxlength: 1000 },
    order: { type: Number, default: 0 },
  },
  { timestamps: true },
);
positionSchema.index({ election: 1, title: 1 }, { unique: true });

export type ElectionPositionDocument = HydratedDocument<IElectionPosition>;
export const ElectionPosition = model<IElectionPosition>("ElectionPosition", positionSchema);
