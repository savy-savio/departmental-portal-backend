import { HydratedDocument, Schema, Types, model } from "mongoose";

export interface IQuizPlayer {
  game: Types.ObjectId;
  student: Types.ObjectId;
  nickname: string;
  nicknameKey: string; // lower-cased: nicknames are unique per game, case-insensitively
  score: number;
  streak: number;
  correctCount: number;
  totalCorrectMs: number; // tie-break: the lower the faster
  rank?: number; // updated at each reveal
  finalRank?: number; // fixed when the game finishes
  joinedAt: Date;
  seq: number; // join order, the last tie-break
  lastQuestion: number; // the last question that was paid out (-1 = none yet) and what its cash drop did to this player
  lastDrop: number; // + stole from the leader, - was robbed
}
const schema = new Schema<IQuizPlayer>(
  {
    game: { type: Schema.Types.ObjectId, ref: "QuizGame", required: true },
    student: { type: Schema.Types.ObjectId, ref: "Student", required: true },
    nickname: { type: String, required: true, trim: true, maxlength: 120 }, // up to 20 visible characters; emoji take several code units each
    nicknameKey: { type: String, required: true },
    score: { type: Number, default: 0 },
    streak: { type: Number, default: 0 },
    correctCount: { type: Number, default: 0 },
    totalCorrectMs: { type: Number, default: 0 },
    rank: Number,
    finalRank: Number,
    joinedAt: { type: Date, default: Date.now },
    seq: { type: Number, default: 0 },
    lastQuestion: { type: Number, default: -1 },
    lastDrop: { type: Number, default: 0 },
  },
  { timestamps: true },
);
schema.index({ game: 1, student: 1 }, { unique: true }); // one player per student per game
schema.index({ game: 1, nicknameKey: 1 }, { unique: true }); // unique nickname per game
schema.index({ student: 1 });
export type QuizPlayerDocument = HydratedDocument<IQuizPlayer>;
export const QuizPlayer = model<IQuizPlayer>("QuizPlayer", schema);
