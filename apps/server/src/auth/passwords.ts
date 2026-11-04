import { hash, verify } from '@node-rs/argon2';

/**
 * Argon2id (the library's default algorithm). OWASP's baseline is 19 MiB, 2 passes, 1 lane;
 * memory and passes are raised until one hash costs 50–200 ms on the target machine.
 * Old hashes keep verifying: the parameters are in them.
 */
const PARAMS = { memoryCost: 47_104, timeCost: 3, parallelism: 1 };

export const hashPassword = (password: string) => hash(password, PARAMS);
export const verifyPassword = (passwordHash: string, password: string) =>
  verify(passwordHash, password);

let dummy: Promise<string> | undefined;
/** For unknown emails: costs the same as a real check, so timing does not reveal accounts. */
export async function verifyNobody(password: string): Promise<false> {
  dummy ??= hashPassword('no account has this password');
  await verify(await dummy, password);
  return false;
}
