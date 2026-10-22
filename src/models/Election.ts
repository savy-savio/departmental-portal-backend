import { HydratedDocument, Schema, Types, model } from "mongoose";
import { ACADEMIC_SESSION_REGEX, ELECTION_STATUSES, ELECTORATE_MODES, ElectorateMode, LEVEL_REGEX } from "../utils/constants";

/** One election belonging to exactly one department. Other departments run their own. */
export interface IElection {
  department: Types.ObjectId;
  title: string;
  description?: string;
  academicSession: string;
  /** DEPARTMENT = everyone in the department; LEVELS = students at eligibleLevels; GROUP = only eligibleStudents. */
  electorateMode: ElectorateMode;
  /** Used when electorateMode is LEVELS. Empty with LEVELS is rejected by the service; legacy rows (mode DEPARTMENT, empty) still mean everyone. */
  eligibleLevels: string[];
  /** Used when electorateMode is GROUP: an explicit allow-list of students of this department. */
  eligibleStudents: Types.ObjectId[];
  votingOpensAt: Date;
  votingClosesAt: Date;
  status: "DRAFT" | "PUBLISHED" | "CANCELLED";
  /** Students see tallies only when this is true AND voting has closed. Set by the election administrator (later phase). */
  resultsPublished: boolean;
  createdByName: string;
  createdByRole: string;
}

const electionSchema = new Schema<IElection>(
  {
    department: { type: Schema.Types.ObjectId, ref: "Department", required: true, immutable: true, index: true },
    title: { type: String, required: true, trim: true, maxlength: 200 },
    description: { type: String, trim: true, maxlength: 3000 },
    academicSession: { type: String, required: true, match: ACADEMIC_SESSION_REGEX },
    electorateMode: { type: String, enum: ELECTORATE_MODES, default: "DEPARTMENT" },
    eligibleStudents: { type: [Schema.Types.ObjectId], ref: "Student", default: [] },
    eligibleLevels: { type: [String], default: [], validate: (v: string[]) => v.every((l) => LEVEL_REGEX.test(l)) },
    votingOpensAt: { type: Date, required: true },
    votingClosesAt: { type: Date, required: true },
    status: { type: String, enum: ELECTION_STATUSES, default: "DRAFT" },
    resultsPublished: { type: Boolean, default: false },
    createdByName: { type: String, required: true, trim: true },
    createdByRole: { type: String, required: true, trim: true },
  },
  { timestamps: true },
);
electionSchema.pre("validate", function (next) {
  if (this.votingOpensAt && this.votingClosesAt && this.votingClosesAt <= this.votingOpensAt) {
    this.invalidate("votingClosesAt", "votingClosesAt must be after votingOpensAt");
  }
  next();
});
electionSchema.index({ department: 1, academicSession: 1, title: 1 }, { unique: true });

export type ElectionDocument = HydratedDocument<IElection>;
export const Election = model<IElection>("Election", electionSchema);
