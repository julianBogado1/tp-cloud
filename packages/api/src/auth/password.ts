import bcrypt from 'bcryptjs';

/** bcrypt via bcryptjs (pure JS: nothing to compile on the EC2 box). */

export const BCRYPT_COST = 10;

/**
 * Compared against when the email is unknown so a login attempt costs the
 * same time whether or not the account exists. The random salt guarantees
 * no real password can match it.
 */
export const DUMMY_HASH: string = bcrypt.hashSync(`dummy-${Math.random()}`, BCRYPT_COST);

export function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, BCRYPT_COST);
}

export function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}
