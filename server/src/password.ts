/**
 * Staff password hashing (R06).
 *
 * This is now scrypt, which is memory-hard. That matters more than the
 * iteration count: PBKDF2 is cheap to run massively in parallel on a GPU or an
 * ASIC, and scrypt is not, because every guess must also *hold* memory.
 *
 * The Cloudflare build could not do this. Workers' WebCrypto has no scrypt and
 * refuses a single PBKDF2 `deriveBits` above 100,000 iterations against current
 * guidance of 600,000, so it reached 600,000 by chaining six rounds — ordinary
 * iterated stretching, correct as far as it went, and still not memory-hard.
 * Node has scrypt built in with no cap. The workaround is gone; its *verifier*
 * is not, because passwords hashed under it must keep working.
 *
 * Parameters: N=2^16, r=8, p=2. That is one of OWASP's listed settings and does
 * the same total work as the more commonly quoted N=2^17, r=8, p=1 while
 * peaking at 64 MB rather than 128 MB — two sequential passes over half the
 * memory. Peak matters because logins can overlap, and a memory-hard KDF on an
 * unauthenticated endpoint is a memory-hard denial of service if it is not
 * bounded.
 *
 * The stored format records its own parameters, so the cost can be raised later
 * without invalidating a single existing password.
 */
import { randomBytes, scrypt, pbkdf2, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const pbkdf2Async = promisify(pbkdf2);

export const SCRYPT_N = 65_536;
export const SCRYPT_R = 8;
export const SCRYPT_P = 2;

const SCHEME = "scrypt";
const LEGACY_SCHEME = "pbkdf2-sha256";
/** The Workers-era cap. Only ever used to bound what a legacy row may claim. */
const LEGACY_MAX_ITERATIONS = 100_000;
const KEY_BYTES = 32;
const SALT_BYTES = 16;

/**
 * scrypt needs roughly 128 * N * r bytes. Node's default maxmem is 32 MB and
 * would reject these parameters outright, so the limit is raised to just over
 * what they require — not removed, so a malformed stored N cannot be used to
 * ask for an unbounded allocation.
 */
const MAX_MEM = 192 * 1024 * 1024;

async function scryptHash(
  password: string,
  salt: Buffer,
  n: number,
  r: number,
  p: number,
): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    scrypt(password, salt, KEY_BYTES, { N: n, r, p, maxmem: MAX_MEM }, (error, key) => {
      if (error) reject(error);
      else resolve(key);
    });
  });
}

/** Returns `scrypt$N$r$p$salt$hash`, all parameters recorded. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const hash = await scryptHash(password, salt, SCRYPT_N, SCRYPT_R, SCRYPT_P);
  return [
    SCHEME,
    String(SCRYPT_N),
    String(SCRYPT_R),
    String(SCRYPT_P),
    salt.toString("base64"),
    hash.toString("base64"),
  ].join("$");
}

function equal(a: Buffer, b: Buffer): boolean {
  // timingSafeEqual throws on a length mismatch, so the lengths are compared
  // first. That reveals only the digest length, which is a fixed constant here.
  return a.length === b.length && timingSafeEqual(a, b);
}

function decode(value: string | undefined): Buffer | null {
  if (value === undefined) return null;
  const bytes = Buffer.from(value, "base64");
  return bytes.length === 0 ? null : bytes;
}

/**
 * Verify a password hashed under the Cloudflare-era chained PBKDF2 scheme.
 *
 * Kept so that a staff member whose password predates this migration can still
 * sign in. Nothing writes this format any more.
 */
async function verifyLegacy(password: string, parts: string[]): Promise<boolean> {
  const [, roundsText, iterationsText, saltText, hashText] = parts;
  const rounds = Number(roundsText);
  const iterations = Number(iterationsText);
  if (!Number.isInteger(rounds) || rounds < 1 || rounds > 100) return false;
  if (!Number.isInteger(iterations) || iterations < 1 || iterations > LEGACY_MAX_ITERATIONS) {
    return false;
  }
  const salt = decode(saltText);
  const expected = decode(hashText);
  if (salt === null || expected === null || expected.length !== KEY_BYTES) return false;

  let material: Buffer = Buffer.from(password, "utf8");
  for (let round = 0; round < rounds; round += 1) {
    material = await pbkdf2Async(material, salt, iterations, KEY_BYTES, "sha256");
  }
  return equal(material, expected);
}

/**
 * Verifies against a stored value, using ITS recorded parameters rather than
 * today's constants — so the cost can be raised later, and so passwords written
 * by the previous scheme keep working.
 *
 * Fails closed on anything malformed: a row we cannot parse is not a login.
 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  const scheme = parts[0];

  if (scheme === LEGACY_SCHEME && parts.length === 5) return verifyLegacy(password, parts);
  if (scheme !== SCHEME || parts.length !== 6) return false;

  const [, nText, rText, pText, saltText, hashText] = parts;
  const n = Number(nText);
  const r = Number(rText);
  const p = Number(pText);
  // Bounded before use: these numbers size an allocation, and an absurd N from
  // a corrupted row must fail the login rather than exhaust the process.
  if (!Number.isInteger(n) || n < 1_024 || n > 1_048_576 || (n & (n - 1)) !== 0) return false;
  if (!Number.isInteger(r) || r < 1 || r > 32) return false;
  if (!Number.isInteger(p) || p < 1 || p > 16) return false;
  if (128 * n * r * p > MAX_MEM) return false;

  const salt = decode(saltText);
  const expected = decode(hashText);
  if (salt === null || expected === null || expected.length !== KEY_BYTES) return false;

  return equal(await scryptHash(password, salt, n, r, p), expected);
}
