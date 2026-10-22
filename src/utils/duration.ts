/** Seconds in a jsonwebtoken-style duration ("15m", "12h", "7d", "2 weeks", or a bare number of seconds). NaN if it can't be read. */
export function parseDurationSeconds(value: string): number {
  const m = /^\s*(\d+(?:\.\d+)?)\s*(s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days|w|week|weeks|y|yr|yrs|year|years)?\s*$/i.exec(value);
  if (!m) return Number.NaN;
  const n = Number(m[1]);
  const unit = (m[2] ?? "s").toLowerCase();
  const mult = unit.startsWith("s") ? 1 : unit.startsWith("mi") || unit === "m" ? 60 : unit.startsWith("h") ? 3600 : unit.startsWith("d") ? 86400 : unit.startsWith("w") ? 604800 : 31557600;
  return n * mult;
}

/** The sentence shown at startup when logins expire sooner than people expect, or null when the setting is fine. */
export function shortSessionWarning(jwtExpiresIn: string, minSeconds = 24 * 3600): string | null {
  const s = parseDurationSeconds(jwtExpiresIn);
  if (Number.isNaN(s)) return `JWT_EXPIRES_IN ("${jwtExpiresIn}") isn't a recognised duration.`;
  if (s >= minSeconds) return null;
  return `JWT_EXPIRES_IN is "${jwtExpiresIn}": anyone who is away from the portal for longer than that (a locked phone, a closed laptop) will be asked to sign in again. Use something like 7d unless that is what you want.`;
}
