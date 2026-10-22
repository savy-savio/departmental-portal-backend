/** Socket.IO rooms and identities. Pure, so the rules that keep users apart are unit-tested. */
export type RealtimeUserType = "STUDENT" | "LECTURER" | "HOD";
export interface RealtimeIdentity { userId: string; userType: RealtimeUserType; departmentId: string }

/** The ONLY room a socket ever joins: one per account (and per account TYPE, so a student id can never collide with a lecturer id). */
export const userRoom = (u: { userType: RealtimeUserType; userId: string }) => `user:${u.userType}:${u.userId}`;

/** What the client says it is. It is only a hint for which token verifier to use: the token still has to verify for that audience. */
export const ROLE_HINTS: Record<string, RealtimeUserType> = { student: "STUDENT", lecturer: "LECTURER", hod: "HOD" };

export const MAX_SOCKETS_PER_USER = 5;
