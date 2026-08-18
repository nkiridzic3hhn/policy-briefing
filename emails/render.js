// Builds the branded weekly-snapshot HTML email from the generated digests.
// Email-client-safe: table layout + inline styles (renders correctly in classic
// Outlook, which uses Word's engine - no flexbox, no CSS classes, borders on
// all sides). Piece of Pi pink palette.

const { WATCHLIST } = require("../lib/watchlist");
const { STATES: KNOWN_STATES } = require("../lib/states");
// Which item leads the email and supplies the subject line.
const { pickTopStory } = require("./toplead");

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

function reputationMatches(item, states, brands) {
  const agencies = String(item.agency || "").split("+").map(a => a.trim());
  // An explicit brand pick is the most specific filter: use it alone.
  if (brands && brands.length) {
    return agencies.some(a => brands.includes(a));
  }
  if (!states || !states.length) return true;
  for (const a of agencies) {
    const known = AGENCY_STATES[a];
    if (!known || !known.length) return true; // network-wide brand - everyone sees it
    if (known.some(st => states.includes(st))) return true;
  }
  return false;
}

// Reduce the shared digests to what this subscriber asked for.
// "Wage & Hour" is an OPT-IN topic: it only appears for subscribers whose
// topics explicitly include it - never as part of the "everything" default.
function filterForSubscriber(digests, prefs) {
  const states = (prefs && Array.isArray(prefs.states)) ? prefs.states : [];
  const topics = (prefs && Array.isArray(prefs.topics)) ? prefs.topics : [];
  const brands = (prefs && Array.isArray(prefs.brands)) ? prefs.brands : [];
  const topicOk = i => (i.topic === "Wage & Hour")
    ? topics.includes("Wage & Hour")
    : (!topics.length || !i.topic || topics.includes(i.topic));
  return {
    policy: (digests.policy || []).filter(i => stateMatches(i.state, states) && topicOk(i)),
    fraud: (digests.fraud || []).filter(i => stateMatches(i.state, states)),
    reputation: (digests.reputation || []).filter(i => reputationMatches(i, states, brands)),
    reputationQuiet: digests.reputationQuiet || [],
    // Law changes filter on state only, never on topic. A subscriber who picked
    // "Wage & Hour" still needs to know their state's licensure rule changed -
    // an enacted deadline isn't optional reading the way a news topic is.
    laws: (digests.laws || []).filter(i => stateMatches(i.jurisdiction || i.state, states)),
    lawsCalendar: (digests.lawsCalendar || []).filter(i => stateMatches(i.jurisdiction || i.state, states))
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

// -- Law changes --
// These aren't news items, they're deadlines: what already became law, where,
// and how long until it bites. Hence the countdown pill and the "what to do"
// line instead of the usual source-first treatment.
function prettyDate(ymd) {
  if (!ymd) return "";
  const d = new Date(ymd + "T00:00:00Z");
  if (isNaN(d)) return ymd;
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
}

function countdownPill(item) {
  const d = item.days_until;
  if (d === null || d === undefined) {
    return pill(`EFFECTIVE ${String(item.effective_text || "TBD").toUpperCase()}`, PALETTE.gray, PALETTE.grayBg);
  }
  if (d <= 0) return pill("IN EFFECT NOW", "#ffffff", PALETTE.red);
  if (d <= 7) return pill(`${d} DAY${d === 1 ? "" : "S"} TO COMPLY`, "#ffffff", PALETTE.red);
  if (d <= 30) return pill(`TAKES EFFECT IN ${d} DAYS`, PALETTE.amber, PALETTE.amberBg);
  return pill(`EFFECTIVE ${prettyDate(item.effective_date).toUpperCase()}`, PALETTE.blue, PALETTE.blueBg);
}

function lawRow(item, isLast) {
  const pills = countdownPill(item)
    + statePill(item.jurisdiction || item.state)
    + (item.category ? pill(item.category, PALETTE.muted, PALETTE.surface) : "")
    + (item.first_seen ? pill("NEW", PALETTE.green, PALETTE.greenBg) : "");
  // The source's authority rides along with the citation: the verify pass proves
  // a page says this, not that the page is the agency that made the rule.
  const meta = [item.citation, item.source, item.effective_date ? "effective " + prettyDate(item.effective_date) : item.effective_text, item.source_tier_label]
    .filter(Boolean).join(" · ");
  const metaHtml = meta
    ? `<div style="font-size:12px;color:${PALETTE.dim};margin-top:6px;">${
        item.url && String(item.url).indexOf("http") === 0
          ? `<a href="${esc(item.url)}" style="color:${PALETTE.dim};text-decoration:underline;">${esc(meta)}</a>`
          : esc(meta)}</div>`
    : "";
  return `<tr><td style="padding:15px 20px;${isLast ? "" : `border-bottom:1px solid ${PALETTE.divider};`}">
    <div style="margin-bottom:5px;">${pills}</div>
    <div style="font-size:14px;font-weight:700;color:${PALETTE.text};line-height:1.4;">${titleHtml(item)}</div>
    <div style="font-size:13px;color:${PALETTE.body};line-height:1.55;margin-top:3px;">${esc(item.summary)}</div>
    ${item.action ? `<div style="font-size:13px;color:${PALETTE.accent};line-height:1.55;margin-top:5px;"><strong>What to do:</strong> ${esc(item.action)}</div>` : ""}
    ${metaHtml}
  </td></tr>`;
}

// One compact line per deadline the reader has already been told about: enough
// to see it coming, not enough to make them re-read it every edition.
function calendarRow(item, isLast) {
  const when = item.effective_date ? prettyDate(item.effective_date) : (item.effective_text || "date TBD");
  const days = item.days_until === null || item.days_until === undefined
    ? "" : (item.days_until <= 0 ? "in effect" : `${item.days_until}d`);
  return `<tr><td style="padding:9px 20px;${isLast ? "" : `border-bottom:1px solid ${PALETTE.divider};`}">
    <span style="font-family:'IBM Plex Mono',monospace;font-size:11px;font-weight:700;color:${PALETTE.accent};display:inline-block;min-width:44px;">${esc(days)}</span>
    <span style="font-size:12px;color:${PALETTE.muted};">${esc(item.jurisdiction || item.state)}</span>
    <span style="font-size:13px;color:${PALETTE.text};"> &middot; ${titleHtml(item)}</span>
    <span style="font-size:12px;color:${PALETTE.dim};"> &middot; ${esc(when)}</span>
  </td></tr>`;
}

// `due` crossed a milestone this edition and gets the full write-up. `all` is
// every open deadline; whatever is not already above it is listed compactly, so
// the reader can always see the whole calendar without re-reading it.
function lawSection(due, all) {
  due = due || [];
  const shownIds = new Set(due.map(l => l.id).filter(v => v !== undefined && v !== null));
  const rest = (all || []).filter(l => !shownIds.has(l.id));
  if (!due.length && !rest.length) return "";

  let html = "";
  if (due.length) {
    const rows = due.map((l, i) => lawRow(l, i === due.length - 1)).join("");
    html += sectionCard("⚖️", "Labor law changes and deadlines",
      `${due.length} new or updated`, rows);
  }
  if (rest.length) {
    const rows = rest.map((l, i) => calendarRow(l, i === rest.length - 1)).join("");
    const title = due.length ? "Also on your compliance calendar" : "Labor law changes and deadlines";
    html += sectionCard(due.length ? "🗓️" : "⚖️", title,
      `${rest.length} tracked`, rows);
  }
  return html;
}

function policySection(items) {
  if (!items || !items.length) return "";
  const rows = items.map((a, i) => row(
    statePill(a.state) + (a.topic === "Wage & Hour" ? pill("WAGE & HOUR", PALETTE.blue, PALETTE.blueBg) : "") + ((a.urgency || "").toLowerCase() === "high" ? pill("High impact", "#d4537e", "#fdf0f4") : ""),
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
      <div style="font-size:12px;color:${PALETTE.muted};line-height:1.6;"><strong style="color:${PALETTE.body};">Quiet this week (${quiet.length} brand${quiet.length === 1 ? "" : "s"}):</strong> ${esc(quiet.join(", "))} - no third-party mentions found.</div>
    </td></tr>
  </table>`;
  }
  return html;
}

function topStoryBox(top) {
  if (!top) return "";
  const item = top.item;
  return `
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:16px;">
    <tr><td style="background:${PALETTE.bg};border:1px solid ${PALETTE.border};border-left:4px solid ${PALETTE.accent};border-radius:14px;padding:17px 21px;">
      <div style="font-size:11px;font-weight:700;color:${PALETTE.accent};text-transform:uppercase;letter-spacing:1px;margin-bottom:6px;">⚡ The one thing to know</div>
      ${top.label === "law" ? `<div style="margin-bottom:6px;">${countdownPill(item)}${statePill(item.jurisdiction || item.state)}</div>` : ""}
      <div style="font-size:17px;font-weight:700;color:${PALETTE.text};line-height:1.4;margin-bottom:6px;">${titleHtml(item)}</div>
      <div style="font-size:14px;color:${PALETTE.body};line-height:1.6;">${esc(item.summary)}</div>
      ${top.label === "law" && item.action ? `<div style="font-size:14px;color:${PALETTE.accent};line-height:1.6;margin-top:6px;"><strong>What to do:</strong> ${esc(item.action)}</div>` : ""}
      ${sourceHtml(item)}
    </td></tr>
  </table>`;
}

function statsStrip(digests, areas) {
  const cells = [];
  const lawCount = Math.max((digests.laws || []).length, (digests.lawsCalendar || []).length);
  if (areas.includes("policy") && lawCount) cells.push({ n: lawCount, label: "Law changes" });
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

// subscriber: { email, areas:[], token, prefs:{states,topics,brands,frequency} }
// digests: { policy:[], fraud:[], reputation:[], reputationQuiet:[], laws:[] }
// opts.edition: "Daily" | "Weekly" | "Monthly" (display label; default Weekly)
function renderEmail(subscriber, digests, opts = {}) {
  const appUrl = (opts.appUrl || "https://www.pieceofpi.app").replace(/\/$/, "");
  const areas = subscriber.areas || [];
  const dateStr = opts.dateStr || "";
  const edition = opts.edition || "Weekly";
  digests = filterForSubscriber(digests, subscriber.prefs);

  let sections = "";
  // Law changes lead: they're the only section with a deadline attached.
  if (areas.includes("policy")) sections += lawSection(digests.laws, digests.lawsCalendar);
  if (areas.includes("policy")) sections += policySection(digests.policy);
  if (areas.includes("fraud")) sections += fraudSection(digests.fraud);
  if (areas.includes("reputation")) sections += reputationSection(digests.reputation, digests.reputationQuiet);

  const itemCount =
    (areas.includes("policy") ? Math.max((digests.laws || []).length, (digests.lawsCalendar || []).length) : 0) +
    (areas.includes("policy") ? (digests.policy || []).length : 0) +
    (areas.includes("fraud") ? (digests.fraud || []).length : 0) +
    (areas.includes("reputation") ? (digests.reputation || []).length : 0);
  const hasContent = itemCount > 0;
  if (!hasContent) {
    sections = `<div style="padding:24px 0;text-align:center;color:${PALETTE.muted};font-size:14px;">Nothing notable surfaced in your selected areas this edition. We'll keep watching.</div>`;
  }

  const top = hasContent ? pickTopStory(digests, areas) : null;
  const unsubUrl = `${appUrl}/unsubscribe?token=${encodeURIComponent(subscriber.token)}`;
  const subjectTop = top && top.item && top.item.title ? String(top.item.title).slice(0, 70) : "your snapshot";
  const subject = `🥧 Piece of Pi ${edition.toLowerCase()} — ${subjectTop}`;

  const html = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:${PALETTE.page};font-family:'Helvetica Neue',Arial,sans-serif;color:${PALETTE.text};">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${PALETTE.page};">
    <tr><td align="center" style="padding:28px 12px;">
      <table role="presentation" width="620" cellpadding="0" cellspacing="0" style="width:620px;max-width:620px;">

        <!-- Header -->
        <tr><td align="center" style="padding-bottom:18px;">
          <img src="cid:logo" alt="Piece of Pi" height="176" style="height:176px;display:block;margin:0 auto 8px auto;">
          <div style="font-size:24px;font-weight:700;color:${PALETTE.accent};">Piece of Pi</div>
          <div style="font-size:13px;color:${PALETTE.muted};margin-top:4px;">${edition} snapshot${dateStr ? " · " + esc(dateStr) : ""}</div>
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

  // URLs of every item actually included in this email (after pref filtering),
  // so the caller can remember them and avoid repeats in later editions.
  // Law changes are deliberately NOT in this list: they are meant to recur as
  // their effective date approaches, and the tracker's milestone stages - not
  // the sent-items memory - decide when that happens.
  const urls = [];
  const lawAlerts = [];
  if (hasContent) {
    if (areas.includes("policy")) (digests.policy || []).forEach(i => { if (i.url) urls.push(i.url); });
    if (areas.includes("fraud")) (digests.fraud || []).forEach(i => { if (i.url) urls.push(i.url); });
    if (areas.includes("reputation")) (digests.reputation || []).forEach(i => { if (i.url) urls.push(i.url); });
    if (areas.includes("policy")) (digests.laws || []).forEach(i => { if (i.id) lawAlerts.push({ id: i.id, stage: i.stage }); });
  }

  return { subject, html, hasContent, urls, lawAlerts };
}

module.exports = { renderEmail };
