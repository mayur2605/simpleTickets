/**
 * Staff password hashing (R06).
 *
 * Workers' WebCrypto refuses a single PBKDF2 `deriveBits` above 100,000
 * iterations - measured, not assumed: the request fails with "iteration counts
 * above 100000 are not supported". Current guidance for PBKDF2-HMAC-SHA256 is
 * 600,000, which is why this requirement sat blocked.
 *
 * The cap is on one call, not on total work. Chaining rounds - feeding each
 * derived key back in as the next round's input, under the same salt - costs an
 * attacker the same number of PBKDF2 iterations to test one candidate password.
 * Six rounds of 100,000 is 600,000 iterations of work.
 *
 * This is not a clever trick to be suspicious of: it is ordinary iterated key
 * stretching. What it is NOT is memory-hard. Argon2id or scrypt resist GPU and
 * ASIC attack in a way no amount of PBKDF2 does, and if a memory-hard KDF
 * becomes available on this runtime it should replace this. The stored format
 * records its parameters precisely so that migration can happen without
 * invalidating anyone's password.
 */

const encoder = new TextEncoder();

/** The platform's hard ceiling for a single deriveBits call. */
export const ITERATIONS_PER_ROUND = 100_000;
/** Six rounds reach the 600,000 figure current guidance asks for. */
export const ROUNDS = 6;
export const TOTAL_ITERATIONS = ITERATIONS_PER_ROUND * ROUNDS;

const SCHEME = "pbkdf2-sha256";
const KEY_BYTES = 32;
const SALT_BYTES = 16;

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(value: string): Uint8Array | null {
  try {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

async function derive(
  input: Uint8Array,
  salt: Uint8Array,
  rounds: number,
  iterations: number,
): Promise<Uint8Array> {
  let material = input;
  for (let round = 0; round < rounds; round += 1) {
    const key = await crypto.subtle.importKey("raw", material, "PBKDF2", false, ["deriveBits"]);
    const bits = await crypto.subtle.deriveBits(
      { name: "PBKDF2", salt, iterations, hash: "SHA-256" },
      key,
      KEY_BYTES * 8,
    );
    material = new Uint8Array(bits);
  }
  return material;
}

/** Returns `scheme$rounds$iterations$salt$hash`, all parameters recorded. */
export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const hash = await derive(encoder.encode(password), salt, ROUNDS, ITERATIONS_PER_ROUND);
  return [
    SCHEME,
    String(ROUNDS),
    String(ITERATIONS_PER_ROUND),
    toBase64(salt),
    toBase64(hash),
  ].join("$");
}

/**
 * Constant-time comparison. A length check returns early, which reveals only
 * the digest length - a fixed constant here, so it leaks nothing.
 */
function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}

/**
 * Verifies against a stored value, using ITS recorded parameters rather than
 * today's constants - so the cost can be raised later without locking anyone
 * out of an account hashed under the old settings.
 *
 * Fails closed on anything malformed: a row we cannot parse is not a login.
 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 5) return false;
  const [scheme, roundsText, iterationsText, saltText, hashText] = parts;
  if (scheme !== SCHEME) return false;

  const rounds = Number(roundsText);
  const iterations = Number(iterationsText);
  if (!Number.isInteger(rounds) || rounds < 1 || rounds > 100) return false;
  if (!Number.isInteger(iterations) || iterations < 1 || iterations > ITERATIONS_PER_ROUND) {
    return false;
  }

  const salt = saltText === undefined ? null : fromBase64(saltText);
  const expected = hashText === undefined ? null : fromBase64(hashText);
  if (salt === null || expected === null || expected.length !== KEY_BYTES) return false;

  const actual = await derive(encoder.encode(password), salt, rounds, iterations);
  return equalBytes(actual, expected);
}
