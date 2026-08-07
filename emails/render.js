// Builds the branded weekly-snapshot HTML email from the generated digests.
// Email-client-safe: table layout + inline styles (renders correctly in classic
// Outlook, which uses Word's engine — no flexbox, no CSS classes, borders on
// all sides). Piece of Pi pink palette.

const { WATCHLIST } = require("../lib/watchlist");

const KNOWN_STATES = ["New York", "New Jersey", "Pennsylvania", "Massachusetts", "Connecticut",
  "Georgia", "Michigan", "Indiana", "Colorado", "Maryland", "Washington DC"];

// Map each watchlist brand to the state(s) named in its context. Brands with no
// state (network-wide: Honor Health Network, CaringPays, the CEO) match everyone.
const AGENCY_STATES = {};
for (const w of WATCHLIST) {
  const ctx = (w.context || "").toLowerCase();
  for (const s of KNOWN_STATES) {
    if (ctx.includes(s.toLowerCase())) {
      (AGENCY_STATES[w.name] = AGENCY_STATES[w.name] || []).push(s);
    }
  }
}

function stateMatches(itemState, states) {
  if (!states || !states.length) return true;
  const s = String(itemState || "");
  if (!s || /federal|national/i.test(s)) return true;
  return states.some(st => s.toLowerCase().includes(st.toLowerCase()));
}

function reputationMatches(item, states) {
  if (!states || !states.length) return true;
  const agencies = String(item.agency || "").split("+").map(a => a.trim());
  for (const a of agencies) {
    const known = AGENCY_STATES[a];
    if (!known || !known.length) return true; // network-wide brand — everyone sees it
    if (known.some(st => states.includes(st))) return true;
  }
  return false;
}

// Reduce the shared digests to what this subscriber asked for.
function filterForSubscriber(digests, prefs) {
  const states = (prefs && Array.isArray(prefs.states)) ? prefs.states : [];
  const topics = (prefs && Array.isArray(prefs.topics)) ? prefs.topics : [];
  return {
    policy: (digests.policy || []).filter(i =>
      stateMatches(i.state, states) && (!topics.length || !i.topic || topics.includes(i.topic))),
    fraud: (digests.fraud || []).filter(i => stateMatches(i.state, states)),
    reputation: (digests.reputation || []).filter(i => reputationMatches(i, states)),
    reputationQuiet: digests.reputationQuiet || []
  };
}

const PALETTE = {
  page: "#f4e9ed",
  bg: "#ffffff",
  surface: "#fdf2f5",
  border: "#f1d6de",
  divider: "#f7e4ea",
  text: "#2a0f18",
  body: "#5c2a3a",
  muted: "#8a4055",
  dim: "#b8788a",
  accent: "#c03060",
  red: "#b02040",
  amber: "#a05a1c",
  amberBg: "#fbe3cf",
  green: "#1d7a54",
  greenBg: "#e3f4ec",
  blue: "#2a5ea8",
  blueBg: "#e9f0fa",
  gray: "#6b6353",
  grayBg: "#f4f1ea",
  purple: "#7b4fa8",
  purpleBg: "#f3ecf9",
  pinkBg: "#fce8ee"
};

function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function pill(text, fg, bg) {
  return `<span style="display:inline-block;font-size:11px;font-weight:700;color:${fg};background:${bg};border-radius:9px;padding:2px 8px;margin:0 5px 4px 0;">${esc(text)}</span>`;
}

function statePill(state) {
  const s = state || "Federal/National";
  const isFederal = /federal|national/i.test(s);
  return pill(s.toUpperCase(), isFederal ? PALETTE.purple : PALETTE.accent, isFederal ? PALETTE.purpleBg : PALETTE.pinkBg);
}

function sentimentPill(sentiment) {
  const s = (sentiment || "neutral").toLowerCase();
  if (s === "negative") return pill("NEGATIVE", "#ffffff", PALETTE.red);
  if (s === "review") return pill("⚠ NEEDS REVIEW", PALETTE.amber, PALETTE.amberBg);
  if (s === "positive") return pill("POSITIVE", PALETTE.green, PALETTE.greenBg);
  if (s === "news") return pill("NEWS", PALETTE.blue, PALETTE.blueBg);
  return pill("NEUTRAL", PALETTE.gray, PALETTE.grayBg);
}

function titleHtml(item) {
  const t = esc(item.title);
  if (item.url && String(item.url).indexOf("http") === 0) {
    return `<a href="${esc(item.url)}" style="color:${PALETTE.text};text-decoration:none;">${t} <span style="color:${PALETTE.accent};">&rsaquo;</span></a>`;
  }
  return t;
}

function sourceHtml(item) {
  const src = [item.source, item.date].filter(Boolean).join(" · ");
  if (!src) return "";
  const inner = esc(src);
  const linked = item.url && String(item.url).indexOf("http") === 0
    ? `<a href="${esc(item.url)}" style="color:${PALETTE.dim};text-decoration:underline;">${inner}</a>` : inner;
  return `<div style="font-size:12px;color:${PALETTE.dim};margin-top:6px;">${linked}</div>`;
}

function row(pills, item, isLast) {
  return `<tr><td style="padding:15px 20px;${isLast ? "" : `border-bottom:1px solid ${PALETTE.divider};`}">
    <div style="margin-bottom:5px;">${pills}</div>
    <div style="font-size:14px;font-weight:700;color:${PALETTE.text};line-height:1.4;">${titleHtml(item)}</div>
    <div style="font-size:13px;color:${PALETTE.body};line-height:1.55;margin-top:3px;">${esc(item.summary)}</div>
    ${sourceHtml(item)}
  </td></tr>`;
}

function sectionCard(emoji, title, count, rowsHtml) {
  return `
  <div style="font-size:15px;font-weight:700;color:${PALETTE.text};margin:22px 0 8px 0;">${emoji} ${esc(title)} <span style="font-size:12px;font-weight:400;color:${PALETTE.dim};">· ${esc(count)}</span></div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${PALETTE.bg};border:1px solid ${PALETTE.border};border-radius:14px;">
    ${rowsHtml}
  </table>`;
}

function policySection(items) {
  if (!items || !items.length) return "";
  const rows = items.map((a, i) => row(
    statePill(a.state) + ((a.urgency || "").toLowerCase() === "high" ? pill("High impact", "#d4537e", "#fdf0f4") : ""),
    a, i === items.length - 1
  )).join("");
  return sectionCard("📜", "Policy intelligence", `${items.length} item${items.length === 1 ? "" : "s"}`, rows);
}

function fraudSection(items) {
  if (!items || !items.length) return "";
  const rows = items.map((f, i) => row(
    statePill(f.state) + (f.amount ? pill(f.amount, "#ffffff", PALETTE.text) : ""),
    f, i === items.length - 1
  )).join("");
  return sectionCard("🚨", "Medicaid fraud watch", `${items.length} case${items.length === 1 ? "" : "s"}`, rows);
}

function reputationSection(items, quiet) {
  let html = "";
  if (items && items.length) {
    const rows = items.map((m, i) => row(
      sentimentPill(m.sentiment) + `<span style="font-size:12px;color:${PALETTE.muted};font-weight:600;">${esc(m.agency || "Honor Health Network")}${m.platform ? " · " + esc(m.platform) : ""}</span>`,
      m, i === items.length - 1
    )).join("");
    html += sectionCard("👀", "Reputation watch", `${items.length} mention${items.length === 1 ? "" : "s"}`, rows);
  }
  if (quiet && quiet.length) {
    html += `
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:12px;">
    <tr><td style="background:#faf3f6;border:1px dashed #e8c6d2;border-radius:14px;padding:13px 20px;">
      <div style="font-size:12px;color:${PALETTE.muted};line-height:1.6;"><strong style="color:${PALETTE.body};">Quiet this week (${quiet.length} brand${quiet.length === 1 ? "" : "s"}):</strong> ${esc(quiet.join(", "))} — no third-party mentions found.</div>
    </td></tr>
  </table>`;
  }
  return html;
}

// Pick the single most important item across all sections for the top box.
function pickTopStory(digests, areas) {
  const has = a => areas.includes(a);
  if (has("fraud")) {
    const f = (digests.fraud || []).find(i => (i.severity || "").toLowerCase() === "high") || (digests.fraud || [])[0];
    if (f) return { item: f, label: "fraud" };
  }
  if (has("policy")) {
    const p = (digests.policy || []).find(i => (i.urgency || "").toLowerCase() === "high") || (digests.policy || [])[0];
    if (p) return { item: p, label: "policy" };
  }
  if (has("reputation")) {
    const r = (digests.reputation || []).find(i => ["negative", "review"].includes((i.sentiment || "").toLowerCase()));
    if (r) return { item: r, label: "reputation" };
  }
  return null;
}

function topStoryBox(top) {
  if (!top) return "";
  const item = top.item;
  return `
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:16px;">
    <tr><td style="background:${PALETTE.bg};border:1px solid ${PALETTE.border};border-left:4px solid ${PALETTE.accent};border-radius:14px;padding:17px 21px;">
      <div style="font-size:11px;font-weight:700;color:${PALETTE.accent};text-transform:uppercase;letter-spacing:1px;margin-bottom:6px;">⚡ The one thing to know this week</div>
      <div style="font-size:17px;font-weight:700;color:${PALETTE.text};line-height:1.4;margin-bottom:6px;">${titleHtml(item)}</div>
      <div style="font-size:14px;color:${PALETTE.body};line-height:1.6;">${esc(item.summary)}</div>
      ${sourceHtml(item)}
    </td></tr>
  </table>`;
}

function statsStrip(digests, areas) {
  const cells = [];
  if (areas.includes("policy")) cells.push({ n: (digests.policy || []).length, label: "Policy items" });
  if (areas.includes("fraud")) cells.push({ n: (digests.fraud || []).length, label: "Fraud cases" });
  if (areas.includes("reputation")) cells.push({ n: (digests.reputation || []).length, label: "Brand mentions" });
  if (!cells.length) return "";
  const width = Math.floor(100 / cells.length);
  const tds = cells.map((c, i) => `
    <td width="${width}%" style="text-align:center;${i > 0 ? `border-left:1px solid ${PALETTE.border};` : ""}">
      <div style="font-size:22px;font-weight:700;color:${PALETTE.text};">${c.n}</div>
      <div style="font-size:11px;color:${PALETTE.muted};text-transform:uppercase;letter-spacing:0.5px;">${esc(c.label)}</div>
    </td>`).join("");
  return `
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${PALETTE.bg};border:1px solid ${PALETTE.border};border-radius:14px;">
    <tr><td style="padding:15px 10px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>${tds}</tr></table></td></tr>
  </table>`;
}

// subscriber: { email, areas:[], token, prefs:{states,topics} }
// digests: { policy:[], fraud:[], reputation:[], reputationQuiet:[] }
function renderEmail(subscriber, digests, opts = {}) {
  const appUrl = (opts.appUrl || "https://www.pieceofpi.app").replace(/\/$/, "");
  const areas = subscriber.areas || [];
  const dateStr = opts.dateStr || "";
  digests = filterForSubscriber(digests, subscriber.prefs);

  let sections = "";
  if (areas.includes("policy")) sections += policySection(digests.policy);
  if (areas.includes("fraud")) sections += fraudSection(digests.fraud);
  if (areas.includes("reputation")) sections += reputationSection(digests.reputation, digests.reputationQuiet);

  const itemCount =
    (areas.includes("policy") ? (digests.policy || []).length : 0) +
    (areas.includes("fraud") ? (digests.fraud || []).length : 0) +
    (areas.includes("reputation") ? (digests.reputation || []).length : 0);
  const hasContent = itemCount > 0;
  if (!hasContent) {
    sections = `<div style="padding:24px 0;text-align:center;color:${PALETTE.muted};font-size:14px;">Nothing notable surfaced in your selected areas this week. We'll keep watching.</div>`;
  }

  const top = hasContent ? pickTopStory(digests, areas) : null;
  const unsubUrl = `${appUrl}/unsubscribe?token=${encodeURIComponent(subscriber.token)}`;
  const subjectTop = top && top.item && top.item.title ? String(top.item.title).slice(0, 70) : "your weekly snapshot";
  const subject = `🥧 Piece of Pi weekly — ${subjectTop}`;

  const html = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:${PALETTE.page};font-family:'Helvetica Neue',Arial,sans-serif;color:${PALETTE.text};">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${PALETTE.page};">
    <tr><td align="center" style="padding:28px 12px;">
      <table role="presentation" width="620" cellpadding="0" cellspacing="0" style="width:620px;max-width:620px;">

        <!-- Header -->
        <tr><td align="center" style="padding-bottom:18px;">
          <img src="cid:logo" alt="🥧 Piece of Pi" height="176" style="height:176px;display:block;margin:0 auto 8px auto;">
          <div style="font-size:24px;font-weight:700;color:${PALETTE.accent};">Piece of Pi</div>
          <div style="font-size:13px;color:${PALETTE.muted};margin-top:4px;">Weekly snapshot${dateStr ? " · " + esc(dateStr) : ""}</div>
        </td></tr>

        <tr><td>
          ${statsStrip(digests, areas)}
          ${topStoryBox(top)}
          ${sections}
        </td></tr>

        <!-- Footer -->
        <tr><td align="center" style="padding:22px 20px 8px 20px;">
          <div style="font-size:12px;color:${PALETTE.dim};line-height:1.7;">
            You're subscribed to: ${esc(areas.map(a => ({ policy: "Policy Intelligence", fraud: "Medicaid Fraud", reputation: "Reputation Watch" }[a] || a)).join(", "))}<br>
            <a href="${esc(appUrl)}/subscribe" style="color:${PALETTE.muted};">Manage preferences</a> &nbsp;&middot;&nbsp;
            <a href="${esc(unsubUrl)}" style="color:${PALETTE.muted};">Unsubscribe</a>
          </div>
          <div style="font-size:11px;color:#d4a7b6;margin-top:10px;">Piece of Pi 🥧 &middot; pieceofpi.app</div>
        </td></tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`;

  return { subject, html, hasContent };
}

module.exports = { renderEmail };
