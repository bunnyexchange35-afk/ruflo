/**
 * Password hashing + token primitives.
 *
 * Runtime: Cloudflare Workers (WebCrypto only). bcrypt/argon2 are unavailable in
 * the Workers sandbox, so we use PBKDF2-HMAC-SHA256, which is the strongest
 * KDF available in `crypto.subtle` and is an accepted standard (OWASP/NIST
 * SP 800-132) at a high iteration count.
 *
 * Hash format (self-describing so it can be migrated later):
 *   PBKDF2-SHA256$<iterations>$<saltB64url>$<hashB64url>
 */

const ALGO = 'PBKDF2-SHA256';
const ITERATIONS = 210_000; // OWASP recommendation for PBKDF2-HMAC-SHA256
const KEY_LEN_BYTES = 32;
const SALT_LEN_BYTES = 16;

function bytesToB64url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlToBytes(value: string): Uint8Array {
  const pad = value.length % 4 === 0 ? '' : '='.repeat(4 - (value.length % 4));
  const b64 = value.replace(/-/g, '+').replace(/_/g, '/') + pad;
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

function toHex(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += b.toString(16).padStart(2, '0');
  return s;
}

function randomBytes(length: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(length));
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_LEN_BYTES);
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, [
    'deriveBits',
  ]);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: ITERATIONS, hash: 'SHA-256' },
    key,
    KEY_LEN_BYTES * 8,
  );
  return `${ALGO}$${ITERATIONS}$${bytesToB64url(salt)}$${bytesToB64url(new Uint8Array(bits))}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 4) return false;
  const [algo, iterRaw, saltRaw, hashRaw] = parts;
  if (algo !== ALGO) return false;
  const iterations = Number(iterRaw);
  if (!Number.isFinite(iterations) || iterations <= 0) return false;

  const salt = b64urlToBytes(saltRaw);
  const expected = b64urlToBytes(hashRaw);
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, [
    'deriveBits',
  ]);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    key,
    expected.length * 8,
  );
  return timingSafeEqual(new Uint8Array(bits), expected);
}

/** Constant-time comparison. Never early-exits on length mismatch of secret data. */
export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a[i] ^ b[i];
  return diff === 0;
}

/** Cryptographically random URL-safe token (session token, reset token, etc.). */
export function randomToken(bytes = 32): string {
  return bytesToB64url(randomBytes(bytes));
}

/** Short human-entered code (recovery challenge) — unambiguous alphabet. */
export function randomCode(length = 10): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no I/O/0/1
  const bytes = randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i += 1) out += alphabet[bytes[i] % alphabet.length];
  return out;
}

/** SHA-256 of a token. Session/reset tokens are stored only in this form. */
export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return toHex(new Uint8Array(digest));
}

export function newId(prefix?: string): string {
  const uuid = crypto.randomUUID();
  return prefix ? `${prefix}_${uuid}` : uuid;
}

export { bytesToB64url, b64urlToBytes };
