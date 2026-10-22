import { HydratedDocument, Schema, Types, model } from "mongoose";

/** One hosted run of a quiz. The server owns `status`; every change is a conditional update (compare-and-set). */
export interface IQuizGame {
  quiz: Types.ObjectId;
  title: string;
  secondsPerQuestion: number;
  /** Snapshot taken when the game is hosted: later edits to the quiz don't affect a running game. */
  questions: { text: string; options: string[]; correctIndex: number }[];
  host: Types.ObjectId;
  hostName: string;
  department: Types.ObjectId;
  level: string;
  pin: string;
  status: "LOBBY" | "QUESTION" | "REVEAL" | "FINISHED" | "CANCELLED";
  /** true while the game is open (LOBBY / QUESTION / REVEAL): the PIN is unique among open games only. */
  open: boolean;
  questionIndex: number; // -1 in the lobby
  questionStartedAt?: Date;
  /** true while a question is being closed and scored: no more answers are taken. */
  closing: boolean;
  lastHostActionAt: Date;
  finishedAt?: Date;
}
const questionSchema = new Schema({ text: String, options: [String], correctIndex: Number }, { _id: false });
const schema = new Schema<IQuizGame>(
  {
    quiz: { type: Schema.Types.ObjectId, ref: "Quiz", required: true },
    title: { type: String, required: true },
    secondsPerQuestion: { type: Number, required: true },
    questions: { type: [questionSchema], required: true },
    host: { type: Schema.Types.ObjectId, ref: "Student", required: true, index: true },
    hostName: { type: String, required: true },
    department: { type: Schema.Types.ObjectId, ref: "Department", required: true },
    level: { type: String, required: true },
    pin: { type: String, required: true },
    status: { type: String, enum: ["LOBBY", "QUESTION", "REVEAL", "FINISHED", "CANCELLED"], default: "LOBBY" },
    open: { type: Boolean, default: true },
    questionIndex: { type: Number, default: -1 },
    questionStartedAt: Date,
    closing: { type: Boolean, default: false },
    lastHostActionAt: { type: Date, default: Date.now },
    finishedAt: Date,
  },
  { timestamps: true },
);
// A PIN identifies exactly one OPEN game; finished / cancelled games release it.
schema.index({ pin: 1 }, { unique: true, partialFilterExpression: { open: true } });
schema.index({ host: 1, open: 1 });
export type QuizGameDocument = HydratedDocument<IQuizGame>;
export const QuizGame = model<IQuizGame>("QuizGame", schema);
