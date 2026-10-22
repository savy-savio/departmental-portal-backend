import type { SecurityLogRec } from "./types";

export const SUSPICION = {
  burstWindowMs: 10 * 60_000,
  burstFailures: 5,
  outOfRangeCount: 3,
  deviceWindowMs: 24 * 3_600_000,
} as const;

/**
 * Pure detector: decides which flags a just-recorded failed attempt deserves, given recent logs.
 * Flags never block by themselves (a flag is for an administrator to investigate); the hard blocks
 * are the device / enrollment / location / token rules in the engine.
 *
 * Deliberately NOT here: any "one IP = one student" rule. Many students share a Wi-Fi network.
 */
export function detectSuspicion(current: SecurityLogRec, recent: SecurityLogRec[], now: Date): string[] {
  const flags = new Set<string>();
  const nowMs = now.getTime();
  const all = [...recent, current];

  if (current.reason === "DEVICE_BOUND_TO_OTHER_STUDENT") flags.add("DEVICE_SHARING_ATTEMPT");

  if (current.deviceFingerprint) {
    const students = new Set(
      all.filter((l) => l.deviceFingerprint === current.deviceFingerprint && nowMs - l.at.getTime() <= SUSPICION.deviceWindowMs).map((l) => l.studentId),
    );
    if (students.size >= 2) flags.add("DEVICE_USED_BY_MULTIPLE_ACCOUNTS");
  }

  const recentOwn = all.filter((l) => l.studentId === current.studentId && nowMs - l.at.getTime() <= SUSPICION.burstWindowMs);
  if (recentOwn.filter((l) => l.outcome === "REJECTED").length >= SUSPICION.burstFailures) flags.add("REPEATED_FAILURES");
  if (recentOwn.filter((l) => l.reason === "LOCATION_OUTSIDE_RADIUS").length >= SUSPICION.outOfRangeCount) flags.add("REPEATED_OUT_OF_RANGE");

  return [...flags];
}
