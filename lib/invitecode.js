// Short, human-typable invite codes.
//
// The original invite was a 64-character token in the URL. That is fine
// cryptography and terrible optics: a brand-new domain, a long random string,
// and a page asking for a password is the exact shape of a credential-phishing
// kit, and Microsoft Defender blocked it on sight. A code the recipient types
// into a site they navigated to themselves has no such signature.
//
// The alphabet drops 0/O/1/I/L so nobody has to guess which character they are
// looking at, and codes are normalised on the way in - case, spaces, and dashes
// are all forgiven, because someone reading this off a screen will type it any
// which way.

const crypto = require("crypto");

const ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ"; // 31 chars, no look-alikes
const LENGTH = 8;

// 31^8 is about 8.5e11. With redemption throttled per IP, guessing one is not a
// practical attack; the code still expires and dies on first use regardless.
function generateCode() {
  let out = "";
  // Rejection sampling keeps every character equally likely - a plain modulo
  // would quietly favour the front of the alphabet.
  const limit = Math.floor(256 / ALPHABET.length) * ALPHABET.length;
  while (out.length < LENGTH) {
    const b = crypto.randomBytes(1)[0];
    if (b >= limit) continue;
    out += ALPHABET[b % ALPHABET.length];
  }
  return out;
}

// What goes in the database and what every lookup compares against.
function normalizeCode(input) {
  return String(input == null ? "" : input).toUpperCase().replace(/[^0-9A-Z]/g, "");
}

// What a person sees: FOUR-FOUR, easier to read back over the phone.
function formatCode(code) {
  const c = normalizeCode(code);
  return c.length === LENGTH ? c.slice(0, 4) + "-" + c.slice(4) : c;
}

function isWellFormed(input) {
  const c = normalizeCode(input);
  if (c.length !== LENGTH) return false;
  for (const ch of c) if (!ALPHABET.includes(ch)) return false;
  return true;
}

module.exports = { generateCode, normalizeCode, formatCode, isWellFormed, ALPHABET, LENGTH };
