// Password hashing for dashboard accounts.
//
// scrypt from Node's own crypto, deliberately: it is memory-hard, it is in the
// standard library, and it needs no native build step on Railway. bcrypt would
// mean a new dependency and a compile for the sake of the same outcome.
//
// Stored format: scrypt$N$r$p$salt$hash, all base64. Keeping the parameters in
// the string means raising the cost later does not invalidate old hashes - a
// verify reads whatever settings that hash was made with.

const crypto = require("crypto");

const N = 16384, R = 8, P = 1, KEYLEN = 64;

// The work factor makes this take ~100ms. Logins are rare enough that blocking
// for that is fine, and doing it synchronously keeps the call sites honest.
function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(String(password), salt, KEYLEN, { N, r: R, p: P });
  return ["scrypt", N, R, P, salt.toString("base64"), key.toString("base64")].join("$");
}

function verifyPassword(password, stored) {
  if (!stored || typeof stored !== "string") return false;
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const n = parseInt(parts[1], 10), r = parseInt(parts[2], 10), p = parseInt(parts[3], 10);
  if (!n || !r || !p) return false;
  let salt, expected;
  try {
    salt = Buffer.from(parts[4], "base64");
    expected = Buffer.from(parts[5], "base64");
  } catch (e) { return false; }
  let actual;
  try {
    actual = crypto.scryptSync(String(password), salt, expected.length, { N: n, r, p });
  } catch (e) { return false; }
  // Lengths are equal by construction here, but timingSafeEqual throws if they
  // ever are not, and a thrown login is a broken login.
  if (actual.length !== expected.length) return false;
  return crypto.timingSafeEqual(actual, expected);
}

// Rules kept deliberately short: length is what actually matters, and a wall of
// character-class requirements pushes people toward Password1! and a sticky note.
const MIN_LENGTH = 10;
function passwordProblem(password) {
  const pw = String(password == null ? "" : password);
  if (pw.length < MIN_LENGTH) return `Password must be at least ${MIN_LENGTH} characters.`;
  if (pw.length > 200) return "Password must be under 200 characters.";
  if (!pw.trim()) return "Password cannot be only spaces.";
  return "";
}

module.exports = { hashPassword, verifyPassword, passwordProblem, MIN_LENGTH };
