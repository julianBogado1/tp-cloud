#!/usr/bin/env npx tsx
/**
 * Prints a bcrypt hash (cost 10) for infra/sql/seed.sql or for creating users
 * by hand. Usage: npx tsx scripts/hash-password.ts <password>
 */
import bcrypt from 'bcryptjs';

const password = process.argv[2];
if (!password) {
  console.error('usage: npx tsx scripts/hash-password.ts <password>');
  process.exit(1);
}
console.log(bcrypt.hashSync(password, 10));
