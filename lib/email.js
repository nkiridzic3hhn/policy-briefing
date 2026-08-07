// Thin wrapper around the Resend HTTP API (no SDK dependency).
const fs = require("fs");
const path = require("path");

// Logo embedded as an inline attachment (cid:logo) so it renders in corporate
// Outlook, which blocks remote images by default. Prefer the fixed embedded
// version (transparent holes in the lettering filled white); fall back to the
// original file on disk.
let LOGO_B64 = null;
try {
  LOGO_B64 = require("./logo-data");
} catch (e) {
  try {
    LOGO_B64 = fs.readFileSync(path.join(__dirname, "..", "public", "logo.png")).toString("base64");
  } catch (e2) {
    console.error("[email] no logo available — emails reference cid:logo without it:", e2.message);
  }
}

async function sendEmail({ to, subject, html }) {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.FROM_EMAIL || "Piece of Pi <briefings@pieceofpi.app>";
  if (!apiKey) throw new Error("RESEND_API_KEY not configured.");

  const body = { from, to, subject, html };
  if (LOGO_B64 && html && html.includes("cid:logo")) {
    body.attachments = [{ filename: "logo.png", content: LOGO_B64, content_id: "logo" }];
  }

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data && data.message ? data.message : JSON.stringify(data);
    throw new Error(`Resend ${res.status}: ${msg}`);
  }
  return data;
}

module.exports = { sendEmail };
