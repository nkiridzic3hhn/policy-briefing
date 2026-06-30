// Builds the branded HTML email for a subscriber from the generated digests.
// Email-client-safe: table layout + inline styles, Piece of Pi pink palette.

const PALETTE = {
  bg: "#ffffff",
  surface: "#fdf2f5",
  border: "#f1d6de",
  text: "#2a0f18",
  muted: "#8a4055",
  dim: "#b8788a",
  accent: "#c03060",
  red: "#b02040",
  amber: "#a06020",
  green: "#1f7d52"
};

function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function badge(text, color) {
  return `<span style="display:inline-block;font-size:11px;font-weight:600;color:${color};background:${PALETTE.surface};border:1px solid ${PALETTE.border};border-radius:4px;padding:2px 8px;margin:0 6px 4px 0;">${esc(text)}</span>`;
}

function accentFor(level) {
  const l = (level || "").toLowerCase();
  if (l === "high" || l === "negative") return PALETTE.red;
  if (l === "medium") return PALETTE.amber;
  if (l === "positive") return PALETTE.green;
  return PALETTE.accent;
}

function card(item, opts) {
  const left = accentFor(opts.level);
  const metaBadges = (opts.badges || []).filter(b => b && b.text).map(b => badge(b.text, b.color)).join("");
  const src = [item.source, item.date].filter(Boolean).join(" · ");
  const link = item.url && String(item.url).indexOf("http") === 0
    ? `<a href="${esc(item.url)}" style="color:${PALETTE.accent};text-decoration:none;font-size:12px;">Read source &rsaquo;</a>`
    : "";
  return `
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 12px 0;">
    <tr>
      <td style="background:${PALETTE.surface};border:1px solid ${PALETTE.border};border-left:3px solid ${left};border-radius:10px;padding:14px 16px;">
        <div style="margin-bottom:6px;">${metaBadges}${src ? `<span style="font-size:11px;color:${PALETTE.dim};font-family:monospace;">${esc(src)}</span>` : ""}</div>
        <div style="font-size:15px;font-weight:600;color:${PALETTE.text};line-height:1.4;margin-bottom:5px;">${esc(item.title)}</div>
        <div style="font-size:13px;color:${PALETTE.muted};line-height:1.6;margin-bottom:${link ? "8px" : "0"};">${esc(item.summary)}</div>
        ${link}
      </td>
    </tr>
  </table>`;
}

function sectionHeader(title) {
  return `<tr><td style="padding:18px 0 10px 0;"><div style="font-size:13px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:${PALETTE.accent};border-bottom:1px solid ${PALETTE.border};padding-bottom:6px;">${esc(title)}</div></td></tr>`;
}

function policySection(items) {
  if (!items || !items.length) return "";
  const cards = items.map(a => card(a, {
    level: a.urgency,
    badges: [{ text: a.state || "Federal/National", color: PALETTE.accent }, { text: a.topic || "Policy", color: PALETTE.muted }]
  })).join("");
  return sectionHeader("Policy Intelligence") + `<tr><td>${cards}</td></tr>`;
}

function fraudSection(items) {
  if (!items || !items.length) return "";
  const cards = items.map(f => card(f, {
    level: f.severity,
    badges: [
      { text: f.state || "Federal/National", color: PALETTE.accent },
      { text: f.category || "Other", color: PALETTE.muted },
      f.amount ? { text: f.amount, color: PALETTE.green } : null
    ]
  })).join("");
  return sectionHeader("Medicaid Fraud") + `<tr><td>${cards}</td></tr>`;
}

function reputationSection(items) {
  if (!items || !items.length) return "";
  const cards = items.map(m => card(m, {
    level: m.sentiment,
    badges: [
      { text: m.agency || "Honor Health Network", color: PALETTE.accent },
      { text: (m.sentiment || "neutral").replace(/^./, c => c.toUpperCase()), color: accentFor(m.sentiment) },
      { text: m.platform || "Web", color: PALETTE.muted }
    ]
  })).join("");
  return sectionHeader("Reputation Watch") + `<tr><td>${cards}</td></tr>`;
}

// subscriber: { email, areas:[], token }, digests: { policy, fraud, reputation }
function renderEmail(subscriber, digests, opts = {}) {
  const appUrl = (opts.appUrl || "https://www.pieceofpi.app").replace(/\/$/, "");
  const areas = subscriber.areas || [];
  const dateStr = opts.dateStr || "";

  let sections = "";
  if (areas.includes("policy"))     sections += policySection(digests.policy);
  if (areas.includes("fraud"))      sections += fraudSection(digests.fraud);
  if (areas.includes("reputation")) sections += reputationSection(digests.reputation);

  const hasContent = sections.length > 0;
  if (!hasContent) {
    sections = `<tr><td style="padding:24px 0;text-align:center;color:${PALETTE.muted};font-size:14px;">Nothing notable surfaced in your selected areas this edition. We'll keep watching.</td></tr>`;
  }

  const unsubUrl = `${appUrl}/unsubscribe?token=${encodeURIComponent(subscriber.token)}`;
  const subject = `Piece of Pi${dateStr ? " — " + dateStr : ""}: your policy briefing`;

  const html = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f4e9ed;font-family:'Helvetica Neue',Arial,sans-serif;color:${PALETTE.text};">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4e9ed;padding:24px 0;">
    <tr><td align="center">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:600px;max-width:600px;background:${PALETTE.bg};border-radius:14px;overflow:hidden;border:1px solid ${PALETTE.border};">
        <!-- Header -->
        <tr><td style="padding:24px 28px 16px 28px;border-bottom:1px solid ${PALETTE.border};">
          <table role="presentation" cellpadding="0" cellspacing="0" width="100%"><tr>
            <td><img src="${appUrl}/logo.png" alt="Piece of Pi" height="44" style="height:44px;display:block;"></td>
            <td align="right" style="font-size:11px;color:${PALETTE.dim};font-family:monospace;">${esc(dateStr)}</td>
          </tr></table>
          <div style="font-size:18px;font-weight:700;color:${PALETTE.text};margin-top:12px;">Your Policy Briefing</div>
          <div style="font-size:12px;color:${PALETTE.dim};margin-top:2px;">Medicaid &middot; Home care &middot; Community-based services</div>
        </td></tr>
        <!-- Body -->
        <tr><td style="padding:8px 28px 24px 28px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${sections}</table>
        </td></tr>
        <!-- Footer -->
        <tr><td style="padding:18px 28px 24px 28px;border-top:1px solid ${PALETTE.border};background:${PALETTE.surface};">
          <div style="font-size:11px;color:${PALETTE.dim};line-height:1.6;">
            You're receiving this because you signed up for the Piece of Pi briefing at Honor Health Network.<br>
            <a href="${esc(appUrl)}/subscribe" style="color:${PALETTE.muted};">Update your preferences</a> &nbsp;&middot;&nbsp;
            <a href="${esc(unsubUrl)}" style="color:${PALETTE.muted};">Unsubscribe</a>
          </div>
        </td></tr>
      </table>
      <div style="font-size:11px;color:#b89aa3;margin-top:14px;">Piece of Pi &middot; Policy &amp; Reputation Intelligence</div>
    </td></tr>
  </table>
</body>
</html>`;

  return { subject, html, hasContent };
}

module.exports = { renderEmail };
