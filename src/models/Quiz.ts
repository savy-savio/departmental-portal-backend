import { HydratedDocument, Schema, Types, model } from "mongoose";

/** A quiz written by a class rep for their level. Editing it never changes a game that already started (games keep a snapshot). */
export interface IQuiz {
  owner: Types.ObjectId; // the rep's student account
  department: Types.ObjectId;
  level: string;
  title: string;
  secondsPerQuestion: number;
  questions: { text: string; options: string[]; correctIndex: number }[];
  timesHosted: number;
}
const questionSchema = new Schema({ text: { type: String, required: true, maxlength: 300 }, options: { type: [String], required: true }, correctIndex: { type: Number, required: true } }, { _id: false });
const schema = new Schema<IQuiz>(
  {
    owner: { type: Schema.Types.ObjectId, ref: "Student", required: true, index: true },
    department: { type: Schema.Types.ObjectId, ref: "Department", required: true },
    level: { type: String, required: true },
    title: { type: String, required: true, trim: true, maxlength: 100 },
    secondsPerQuestion: { type: Number, default: 10, min: 5, max: 60 },
    questions: { type: [questionSchema], default: [] },
    timesHosted: { type: Number, default: 0 },
  },
  { timestamps: true },
);
export type QuizDocument = HydratedDocument<IQuiz>;
export const Quiz = model<IQuiz>("Quiz", schema);
