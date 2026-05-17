import { hash, verify, Algorithm } from '@node-rs/argon2';

const ARGON2_OPTS = {
  algorithm: Algorithm.Argon2id,
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
};

export async function hashPassword(plain: string): Promise<string> {
  return hash(plain, ARGON2_OPTS);
}

export async function verifyPassword(plain: string, stored: string): Promise<boolean> {
  try {
    return await verify(stored, plain);
  } catch {
    return false;
  }
}

const COMMON_PASSWORDS = new Set([
  'password', '123456', '12345678', 'qwerty', 'abc123', 'monkey', 'master',
  'dragon', 'login', 'princess', 'password1', 'password123', 'admin',
  'welcome', 'letmein', 'football', 'shadow', 'sunshine', 'trustno1',
  'iloveyou', '1234567', '123456789', '12345', '1234567890', 'password1234',
]);

export function validatePasswordPolicy(
  password: string,
  username: string,
  email: string | null,
): { valid: boolean; reason?: string } {
  if (password.length < 12) {
    return { valid: false, reason: 'Password must be at least 12 characters.' };
  }
  if (password.length > 256) {
    return { valid: false, reason: 'Password must be at most 256 characters.' };
  }
  if (password.toLowerCase() === username.toLowerCase()) {
    return { valid: false, reason: 'Password cannot be the same as your username.' };
  }
  if (email && password.toLowerCase() === email.toLowerCase()) {
    return { valid: false, reason: 'Password cannot be the same as your email.' };
  }
  if (COMMON_PASSWORDS.has(password.toLowerCase())) {
    return { valid: false, reason: 'This is a commonly used password. Please choose a more unique one.' };
  }
  return { valid: true };
}
