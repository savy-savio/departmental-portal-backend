import { compare, hash } from "bcryptjs";
import { env } from "../config/env";

export const hashPassword = (plain: string): Promise<string> => hash(plain, env.BCRYPT_ROUNDS);
export const verifyPassword = (plain: string, passwordHash: string): Promise<boolean> =>
  compare(plain, passwordHash);

let dummyHash: Promise<string> | undefined;
/**
 * Burn the same CPU time as a real comparison when the account does not exist,
 * so response timing does not reveal which emails are registered.
 */
export async function fakePasswordCheck(plain: string): Promise<void> {
  dummyHash ??= hash("timing-equaliser", env.BCRYPT_ROUNDS);
  await compare(plain, await dummyHash);
}
