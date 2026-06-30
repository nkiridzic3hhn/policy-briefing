// Thin wrapper around the Resend HTTP API (no SDK dependency).
async function sendEmail({ to, subject, html }) {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.FROM_EMAIL || "Piece of Pi <briefings@pieceofpi.app>";
  if (!apiKey) throw new Error("RESEND_API_KEY not configured.");

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ from, to, subject, html })
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data && data.message ? data.message : JSON.stringify(data);
    throw new Error(`Resend ${res.status}: ${msg}`);
  }
  return data;
}

module.exports = { sendEmail };
