const EARTH_RADIUS_M = 6_371_008.8;
const toRad = (deg: number) => (deg * Math.PI) / 180;

export const isValidLatitude = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= -90 && v <= 90;
export const isValidLongitude = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= -180 && v <= 180;

/** Great-circle distance in metres (haversine). Computed on the server; the client never reports "I'm inside". */
export function distanceMeters(a: { latitude: number; longitude: number }, b: { latitude: number; longitude: number }): number {
  const dLat = toRad(b.latitude - a.latitude);
  const dLon = toRad(b.longitude - a.longitude);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.latitude)) * Math.cos(toRad(b.latitude)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

export interface ProximityInput {
  /** Server-computed distance between the student's reported position and the venue (metres). */
  distanceMeters: number;
  allowedRadiusInMeters: number;
  /** `coords.accuracy` of the student's reading, and of the lecturer's reading of the venue (metres). Unknown = 0. */
  studentAccuracyMeters?: number;
  venueAccuracyMeters?: number;
  /** Ceiling for the combined allowance. 0 turns the allowance off (the strict old rule). */
  maxAllowanceMeters: number;
}
export interface Proximity { within: boolean; allowanceMeters: number; effectiveRadiusMeters: number }

/**
 * GPS positions are estimates: two phones lying side by side routinely report places 20-80 m apart (more indoors), and every reading says how
 * uncertain it is (`accuracy`). Each reading's true position can differ from the reported one by up to about its accuracy, so a student whose
 * true position could be inside the allowed area is given the benefit of the doubt: the radius is widened by the combined uncertainty,
 * but never by more than `maxAllowanceMeters`, because accuracy is reported by the device and must not become a way to stretch the area.
 */
export function evaluateProximity(i: ProximityInput): Proximity {
  const clean = (v: number | undefined) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);
  const cap = Math.max(0, i.maxAllowanceMeters);
  const allowance = Math.min(cap, clean(i.studentAccuracyMeters) + clean(i.venueAccuracyMeters));
  const effective = i.allowedRadiusInMeters + allowance;
  return { within: i.distanceMeters <= effective, allowanceMeters: Math.round(allowance), effectiveRadiusMeters: Math.round(effective) };
}
