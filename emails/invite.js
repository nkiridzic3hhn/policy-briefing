// The "you've been given access" email.
//
// Same table-and-inline-styles construction as the weekly briefing (classic
// Outlook renders Word HTML - no flexbox, no CSS classes) and the same pink
// palette, so an invite and a briefing look like they came from the same place.
//
// Carries a single-use invite LINK, never a password. The link is the
// credential: random, expiring, and dead the moment it is used, so a forwarded
// or long-forgotten copy of this email is worth nothing. The recipient picks
// their own password at the other end.

const { PALETTE } = require("./render");

function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// A pill-shaped call to action. Built as a table so Outlook gives it a real
// background instead of a bare underlined link.
function button(href, label, filled) {
  const bg = filled ? PALETTE.accent : PALETTE.bg;
  const fg = filled ? "#ffffff" : PALETTE.accent;
  const border = filled ? PALETTE.accent : PALETTE.border;
  return `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 auto;">
    <tr><td style="background:${bg};border:1px solid ${border};border-radius:999px;">
      <a href="${esc(href)}" style="display:inline-block;padding:12px 30px;font-size:14px;font-weight:700;color:${fg};text-decoration:none;">${esc(label)}</a>
    </td></tr>
  </table>`;
}

function tabRow(emoji, title, blurb, isLast) {
  return `<tr><td style="padding:14px 20px;${isLast ? "" : `border-bottom:1px solid ${PALETTE.divider};`}">
    <div style="font-size:14px;font-weight:700;color:${PALETTE.text};margin-bottom:3px;">${emoji} ${esc(title)}</div>
    <div style="font-size:13px;color:${PALETTE.body};line-height:1.55;">${esc(blurb)}</div>
  </td></tr>`;
}

// opts: { name, appUrl, inviteUrl, senderName, expiresDays }
function renderInvite(opts = {}) {
  const appUrl = (opts.appUrl || "https://www.pieceofpi.app").replace(/\/$/, "");
  const name = opts.name ? String(opts.name).trim() : "";
  const sender = opts.senderName || "Nick";
  const inviteUrl = opts.inviteUrl || (appUrl + "/subscribe");
  const days = opts.expiresDays || 14;
  const hello = name ? `Hi ${esc(name)},` : "Hi there,";
  const subject = `${name ? name + ", y" : "Y"}ou're in 🥧 Piece of Pi access + how to use it`;

  const tabs =
    tabRow("⚖️", "Law Deadlines", "Start here. Every enacted law and rule that has not taken effect yet, counting down to the day it does, each with a plain-English “what to do” line. Loads instantly, and filters by state or by how soon it lands.") +
    tabRow("📜", "Policy Intelligence", "Medicaid, home care, and HCBS news. Tick your states and topics on the left, then Run briefing. Takes about a minute because it searches live. The bookmark icon keeps anything worth revisiting.") +
    tabRow("👀", "Reputation Watch", "What outside voices are saying about our agencies. Our own posts and job ads are filtered out, so what is left is genuinely other people.") +
    tabRow("🚨", "Medicaid Fraud", "Indictments, settlements, and audits across the states we operate in, so we can see what regulators are actually pursuing.", true);

  const html = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:${PALETTE.page};font-family:'Helvetica Neue',Arial,sans-serif;color:${PALETTE.text};">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${PALETTE.page};">
    <tr><td align="center" style="padding:28px 12px;">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:600px;max-width:600px;">

        <!-- Header -->
        <tr><td align="center" style="padding-bottom:20px;">
          <img src="cid:logo" alt="Piece of Pi" height="176" style="height:176px;display:block;margin:0 auto 8px auto;">
          <div style="font-size:26px;font-weight:700;color:${PALETTE.accent};">Piece of Pi</div>
          <div style="font-size:13px;color:${PALETTE.muted};margin-top:4px;">Policy &amp; Reputation Monitor</div>
        </td></tr>

        <!-- Welcome -->
        <tr><td style="background:${PALETTE.bg};border:1px solid ${PALETTE.border};border-radius:14px;padding:28px 26px;">
          <div style="font-size:11px;font-weight:700;color:${PALETTE.accent};text-transform:uppercase;letter-spacing:1px;margin-bottom:8px;">You're invited</div>
          <div style="font-size:20px;font-weight:700;color:${PALETTE.text};line-height:1.35;margin-bottom:12px;">${hello} you've got a seat at the table 🥧</div>
          <div style="font-size:14px;color:${PALETTE.body};line-height:1.7;">
            Piece of Pi keeps track of the Medicaid rules, labor laws, and compliance deadlines moving across every state we operate in &mdash; so nobody finds out about a deadline the week it lands.
          </div>
          <div style="font-size:14px;color:${PALETTE.body};line-height:1.7;margin-top:12px;">
            It's yours to poke around in whenever you like.
          </div>
          <div style="padding:22px 0 6px 0;">${button(inviteUrl, "Create my login", true)}</div>
          <div style="font-size:12px;color:${PALETTE.dim};text-align:center;line-height:1.6;">
            Pick your own password &mdash; takes about ten seconds.<br>This link is just for you and expires in ${days} days.
          </div>
        </td></tr>

        <!-- Guide -->
        <tr><td style="padding-top:26px;">
          <div style="font-size:15px;font-weight:700;color:${PALETTE.text};margin-bottom:8px;">The 60-second guide</div>
          <div style="font-size:13px;color:${PALETTE.muted};margin-bottom:10px;">Four tabs across the top. That's the whole tool.</div>
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${PALETTE.bg};border:1px solid ${PALETTE.border};border-radius:14px;">
            ${tabs}
          </table>
        </td></tr>

        <!-- Newsletter -->
        <tr><td style="padding-top:26px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
            <tr><td style="background:${PALETTE.surface};border:1px dashed ${PALETTE.border};border-radius:14px;padding:24px 26px;text-align:center;">
              <div style="font-size:15px;font-weight:700;color:${PALETTE.text};margin-bottom:6px;">Want it to come to you instead? 📬</div>
              <div style="font-size:13px;color:${PALETTE.body};line-height:1.65;margin-bottom:18px;">
                Get a snapshot in your inbox &mdash; the deadlines coming up, plus what moved that week. Pick the areas you care about and how often you want it. Most people take Policy Intelligence, weekly. Unsubscribe in one click, any time.
              </div>
              ${button(appUrl + "/subscribe", "Sign me up", false)}
            </td></tr>
          </table>
        </td></tr>

        <!-- Sign-off -->
        <tr><td style="padding:26px 6px 0 6px;">
          <div style="font-size:14px;color:${PALETTE.body};line-height:1.7;">
            Have a look and tell me what's missing &mdash; it's early days and easy to change.
          </div>
          <div style="font-size:14px;color:${PALETTE.body};line-height:1.7;margin-top:14px;">&mdash; ${esc(sender)}</div>
        </td></tr>

        <!-- Footer -->
        <tr><td align="center" style="padding:26px 20px 8px 20px;">
          <div style="font-size:11px;color:#d4a7b6;">Piece of Pi 🥧 &middot; pieceofpi.app</div>
        </td></tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`;

  return { subject, html };
}

module.exports = { renderInvite };
