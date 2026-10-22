import { HydratedDocument, Schema, Types, model } from "mongoose";

/** One player's answer to one question. Points are worked out by the server (never sent by the phone) and applied to the player at the reveal. */
export interface IQuizAnswer {
  game: Types.ObjectId;
  player: Types.ObjectId;
  student: Types.ObjectId;
  questionIndex: number;
  choice: number;
  elapsedMs: number; // answerReceivedAt - questionStartedAt, measured by the server
  correct: boolean;
  points: number;
  streakBonus: number;
  streakAfter: number;
  seq: number; // order the server received it (tie-break for equal elapsedMs)
}
const schema = new Schema<IQuizAnswer>(
  {
    game: { type: Schema.Types.ObjectId, ref: "QuizGame", required: true },
    player: { type: Schema.Types.ObjectId, ref: "QuizPlayer", required: true },
    student: { type: Schema.Types.ObjectId, ref: "Student", required: true },
    questionIndex: { type: Number, required: true },
    choice: { type: Number, required: true },
    elapsedMs: { type: Number, required: true },
    correct: { type: Boolean, required: true },
    points: { type: Number, default: 0 },
    streakBonus: { type: Number, default: 0 },
    streakAfter: { type: Number, default: 0 },
    seq: { type: Number, required: true },
  },
  { timestamps: true },
);
schema.index({ game: 1, player: 1, questionIndex: 1 }, { unique: true }); // one answer per player per question: the first wins
schema.index({ game: 1, questionIndex: 1 });
export type QuizAnswerDocument = HydratedDocument<IQuizAnswer>;
export const QuizAnswer = model<IQuizAnswer>("QuizAnswer", schema);
