// Law & rule tracker: the part of Piece of Pi that watches for ENACTED law
// changes (state + federal) and their effective dates, instead of just news.
//
// Why this is separate from lib/briefings.js: the digest engine is a recency
// sweep - it only sees what was published in the last 1/7/30 days. A law signed
// in July that takes effect in October falls out of that window a week after it
// is signed, so nobody gets reminded before the deadline. This module keeps a
// persistent compliance calendar instead:
//
//   1. sweep()   - searches for enacted laws/rules in the states we operate in
//                  plus federal labor law, extracts effective dates, and upserts
//                  them into the law_changes table.
//   2. pending() - returns the items due to be surfaced in an edition, based on
//                  milestones (newly found -> 60 days out -> 30 -> 7 -> in
//                  effect) rather than "was it in the news this week".
//
// Hard rule throughout: PROPOSALS DO NOT COUNT. Bills, proposed rules, and
// "lawmakers are considering" stories are dropped. Only signed/enacted/adopted/
// final items with a real effective date make it in.

const db = require("./db");
const { searchBatch, scrape } = require("./firecrawl");
const { STATES } = require("./states");

const MODEL = process.env.NEWSLETTER_MODEL || "claude-sonnet-4-5";
// How often the (fairly expensive) sweep is allowed to run. The newsletter cron
// fires every weekday; the sweep piggybacks on it at most once per this window.
const SWEEP_HOURS = parseInt(process.env.LAW_SWEEP_HOURS || "24", 10);
// Effective dates further out than this aren't worth tracking yet.
const HORIZON_DAYS = parseInt(process.env.LAW_HORIZON_DAYS || "540", 10);
// How long a just-took-effect item stays interesting.
const GRACE_DAYS = parseInt(process.env.LAW_GRACE_DAYS || "120", 10);
const VERIFY_CAP = parseInt(process.env.LAW_VERIFY_CAP || "8", 10);

function today() { return new Date(); }
function iso(d) { return d.toISOString().slice(0, 10); }

async function callClaude(prompt, maxTokens = 8000) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY not configured.");
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model: MODEL, max_tokens: maxTokens, messages: [{ role: "user", content: prompt }] })
  });
  const data = await res.json();
  if (!res.ok) {
    const msg = data && data.error && data.error.message ? data.error.message : JSON.stringify(data);
    throw new Error(`Anthropic API ${res.status}: ${msg}`);
  }
  return (data.content || []).filter(b => b.type === "text").map(b => b.text).join("");
}

function parseJson(text) {
  const clean = (text || "").replace(/```json|```/g, "").trim();
  const match = clean.match(/[\[{][\s\S]*[\]}]/);
  try { return JSON.parse(match ? match[0] : clean); } catch (e) { return null; }
}

function formatResults(results) {
  return results
    .filter(r => r.url)
    .map(r => `- ${r.title}\n  URL: ${r.url}\n  ${r.date ? "Date: " + r.date + "\n  " : ""}${(r.snippet || "").slice(0, 400)}`)
    .join("\n");
}

function normUrl(u) { return String(u || "").trim().replace(/\/$/, "").toLowerCase(); }

// ------------------------------------------------------------------ search --
// One employment/labor pass and one home-care/Medicaid pass per operating
// state, plus a federal labor lane. Federal items always count; state items are
// scoped to where Honor Health Network actually operates.
function buildJobs(tbs) {
  const year = today().getUTCFullYear();
  const jobs = [];
  for (const state of STATES) {
    jobs.push({
      key: `state:${state}:labor`,
      query: `"${state}" employment OR labor law changes ${year} effective date employers new requirements`,
      opts: { tbs, limit: 5 }
    });
    jobs.push({
      key: `state:${state}:care`,
      query: `"${state}" home care OR Medicaid OR caregiver new law OR regulation signed effective ${year}`,
      opts: { tbs, limit: 5 }
    });
  }
  const fed = [
    `Department of Labor final rule effective date employer compliance deadline ${year}`,
    `new federal employment law OR final rule takes effect employers ${year} what changes`,
    `FLSA overtime OR minimum wage OR independent contractor OR companionship exemption final rule effective date`,
    `OSHA OR EEOC OR NLRB OR I-9 final rule effective date employer requirements ${year}`,
    `CMS home health OR HCBS final rule compliance deadline effective date ${year}`
  ];
  fed.forEach((q, i) => jobs.push({ key: `federal:${i}`, query: q, opts: { tbs, limit: 6 } }));
  return jobs;
}

const EXTRACT_RULES =
  `HARD RULES - these decide whether an item is included at all:\n` +
  `- ONLY laws, regulations, and rules that are ALREADY ENACTED, SIGNED, ADOPTED, or FINALIZED.\n` +
  `- EXCLUDE anything proposed, introduced, pending, "under consideration", "advancing", "passed one chamber", ` +
  `"expected to", "could", "would", or otherwise not yet law. A bill that has not been signed is NOT a law change. ` +
  `When in doubt, EXCLUDE it.\n` +
  `- EXCLUDE rules that have been struck down, vacated, enjoined, stayed, repealed, or withdrawn.\n` +
  `- Every item MUST have a concrete effective date or a clearly stated effective timeframe. No date, no item.\n` +
  `- Use ONLY the search results provided. Never invent a law, date, citation, or URL. Each "url" must be copied ` +
  `exactly from a result.\n` +
  `- Merge duplicates: one item per law/rule even if several outlets covered it. Prefer the most authoritative source ` +
  `(state legislature/agency, Federal Register, DOL/CMS/EEOC > law-firm client alert > trade press > general news).\n` +
  `- Return ONLY raw JSON. No markdown fences, no commentary.`;

function extractPrompt(results, existing) {
  const now = iso(today());
  const existingStr = existing.length
    ? existing.map(e => `- id=${e.id} | ${e.jurisdiction} | ${e.title} | effective ${e.effective_date ? iso(new Date(e.effective_date)) : (e.effective_text || "unknown")}`).join("\n")
    : "(none yet)";
  return (
    `Today is ${now}. You are the compliance editor for Honor Health Network, a home care company that employs ` +
    `caregivers and office staff in: ${STATES.join(", ")}.\n\n` +
    `Your job is to maintain a compliance calendar of LAW AND RULE CHANGES THAT ARE ALREADY LAW - what changed, ` +
    `where, when it takes effect, and what an employer / home care operator has to do about it.\n\n` +
    `ALREADY TRACKED (do not create duplicates - if a result is about one of these, put its id in "match_id"):\n${existingStr}\n\n` +
    `SEARCH RESULTS:\n${formatResults(results)}\n\n` +
    `Include an item only if it is relevant to one of: employing caregivers/office staff (wages, overtime, paid leave, ` +
    `sick time, scheduling, hiring, background checks, workplace safety, benefits, payroll, worker classification), or ` +
    `operating a home care / Medicaid agency (licensure, EVV, rates, training and certification, reporting, HCBS rules).\n` +
    `Only include state items for the states listed above. Federal items always count.\n` +
    `A future effective date is ideal; items that took effect within the last ${GRACE_DAYS} days may also be included. ` +
    `Skip anything whose effective date passed more than ${GRACE_DAYS} days ago, and anything more than ${HORIZON_DAYS} days out.\n\n` +
    EXTRACT_RULES + `\n\n` +
    `Return a JSON array (up to 25 items) where each item has exactly these keys:\n` +
    `{"jurisdiction":"one of the state names above, or Federal",` +
    `"title":"short plain-English name of the change, e.g. 'NJ paid sick leave accrual cap raised'",` +
    `"summary":"1-2 sentences: what actually changed",` +
    `"action":"one sentence: what the company has to do to comply, or empty string if nothing operational",` +
    `"category":"Wage & Hour|Paid Leave|Hiring/Background|Workplace Safety|Benefits|Worker Classification|Home Care Licensing|Medicaid/HCBS|EVV/Compliance|Other",` +
    `"effective_date":"YYYY-MM-DD if a specific date is stated, else empty string",` +
    `"effective_text":"the effective timing exactly as stated, e.g. 'January 1, 2027' or 'first payroll after July 1'",` +
    `"citation":"bill or rule number if stated, e.g. 'A-4222' or 'RIN 1235-AA43', else empty string",` +
    `"source":"outlet or agency name","url":"exact provided url",` +
    `"impact":"high|medium|low - high means payroll, staffing, or licensure has to change",` +
    `"match_id":"id of the already-tracked item this duplicates, or empty string"}`
  );
}

// Second pass: read the actual source page for newly discovered items and
// confirm the change is real, enacted, and dated. A wrong compliance deadline in
// an executive's inbox is worse than no deadline at all, so anything that can't
// be confirmed against its own source is dropped (and logged).
async function verifyItem(item) {
  let page = "";
  try { page = await scrape(item.url); }
  catch (e) { console.error(`[laws] verify scrape failed for ${item.url}: ${e.message}`); }
  if (!page || page.length < 200) {
    console.log(`[laws] EXCLUDED unverifiable item: ${item.jurisdiction} - "${item.title}" - ${item.url}`);
    return null;
  }
  const prompt =
    `Today is ${iso(today())}. Fact-check one entry before it goes into a compliance calendar emailed to executives.\n\n` +
    `DRAFT ENTRY:\n${JSON.stringify(item)}\n\n` +
    `SOURCE PAGE CONTENT:\n${page.slice(0, 7000)}\n\n` +
    `Rules:\n` +
    `- If the page does not clearly show this is ALREADY law (signed / enacted / adopted / final rule published), ` +
    `return {"drop":true,"reason":"not enacted"}.\n` +
    `- If the page shows it was blocked, stayed, vacated, delayed indefinitely, or repealed, return ` +
    `{"drop":true,"reason":"not taking effect"}.\n` +
    `- If the page states no effective date or timeframe, return {"drop":true,"reason":"no effective date"}.\n` +
    `- Otherwise correct the entry using ONLY what the page states.\n` +
    `Return ONLY raw JSON: {"drop":false,"title":"...","summary":"...","action":"...","effective_date":"YYYY-MM-DD or empty","effective_text":"...","citation":"...","impact":"high|medium|low"}`;
  let check = null;
  try { check = parseJson(await callClaude(prompt, 1500)); }
  catch (e) { console.error(`[laws] verify call failed: ${e.message}`); return null; }
  if (!check || check.drop === true) {
    console.log(`[laws] verify dropped: ${item.jurisdiction} - "${item.title}" (${(check && check.reason) || "unreadable"})`);
    return null;
  }
  return {
    ...item,
    title: check.title || item.title,
    summary: check.summary || item.summary,
    action: check.action !== undefined ? check.action : item.action,
    effective_date: check.effective_date || item.effective_date,
    effective_text: check.effective_text || item.effective_text,
    citation: check.citation || item.citation,
    impact: check.impact || item.impact,
    verified: true
  };
}

// Belt-and-braces filter for proposal language the editor may have let through.
// Cheap, and it only ever removes items - never adds one.
const PROPOSAL_RE = /\b(proposed|proposal|introduced|pending|would (?:require|raise|ban|mandate|allow)|under consideration|awaiting (?:signature|approval)|if (?:passed|signed|enacted)|advance[sd]? to|bill (?:seeks|aims)|considering)\b/i;
const DEAD_RE = /\b(struck down|vacated|enjoined|blocked by|stayed|repealed|withdrawn|rescinded|overturned)\b/i;
function looksLikeProposal(item) {
  const text = `${item.title || ""} ${item.summary || ""}`;
  return PROPOSAL_RE.test(text) || DEAD_RE.test(text);
}

function withinWindow(item) {
  if (!item.effective_date) return true; // dated only in words - keep, staged as "new"
  const d = new Date(item.effective_date + "T00:00:00Z");
  if (isNaN(d)) return true;
  const days = Math.round((d - today()) / 86400000);
  return days <= HORIZON_DAYS && days >= -GRACE_DAYS;
}

const VALID_JURIS = new Set([...STATES, "Federal"]);

// ------------------------------------------------------------------- sweep --
// opts.backfill: widen the search window to a year so changes enacted months ago
//   (with effective dates still ahead of us) get picked up on the first run.
// opts.force: ignore the once-per-SWEEP_HOURS throttle.
async function sweep(opts = {}) {
  const last = await db.getJobState("law_sweep_at");
  if (!opts.force && last) {
    const hours = (today() - new Date(last)) / 3600000;
    if (hours < SWEEP_HOURS) {
      console.log(`[laws] sweep skipped (last ran ${hours.toFixed(1)}h ago, window ${SWEEP_HOURS}h).`);
      return { skipped: true, found: 0, added: 0, updated: 0 };
    }
  }
  const tbs = opts.backfill ? "qdr:y" : (opts.tbs || "qdr:m");
  const jobs = buildJobs(tbs);
  console.log(`[laws] sweep starting - ${jobs.length} searches (${tbs}${opts.backfill ? ", backfill" : ""}).`);
  const raw = await searchBatch(jobs);
  const all = Object.values(raw).flat();
  await db.setJobState("law_sweep_at", new Date().toISOString());
  if (!all.length) {
    console.log("[laws] sweep found no search results.");
    return { skipped: false, found: 0, added: 0, updated: 0 };
  }

  const existing = await db.listLawChanges({ openOnly: true });
  let items = parseJson(await callClaude(extractPrompt(all, existing)));
  if (!Array.isArray(items)) {
    console.error("[laws] extractor returned no parsable JSON.");
    return { skipped: false, found: 0, added: 0, updated: 0 };
  }

  const urls = new Set(all.filter(r => r.url).map(r => normUrl(r.url)));
  items = items.filter(i => {
    if (!i || !i.title || !i.url) return false;
    if (!urls.has(normUrl(i.url))) { console.log(`[laws] dropped item with non-result url: "${i.title}"`); return false; }
    if (!VALID_JURIS.has(i.jurisdiction)) { console.log(`[laws] dropped out-of-scope jurisdiction "${i.jurisdiction}": ${i.title}`); return false; }
    if (looksLikeProposal(i)) { console.log(`[laws] dropped proposal-sounding item: "${i.title}"`); return false; }
    if (!i.effective_date && !i.effective_text) { console.log(`[laws] dropped undated item: "${i.title}"`); return false; }
    if (!withinWindow(i)) { console.log(`[laws] dropped out-of-window item: "${i.title}" (${i.effective_date})`); return false; }
    return true;
  });

  let added = 0, updated = 0, verifies = 0;
  for (const item of items) {
    const matchId = parseInt(item.match_id, 10);
    const known = Number.isInteger(matchId) ? existing.find(e => e.id === matchId) : null;
    const dupe = known || await db.findLawChange(item.jurisdiction, item.title);
    let record = item;
    // Only brand-new entries pay for a source check; already-tracked items keep
    // the verification they earned when they were first found.
    if (!dupe) {
      if (verifies >= VERIFY_CAP) {
        console.log(`[laws] verify cap reached, deferring: "${item.title}"`);
        continue;
      }
      verifies++;
      record = await verifyItem(item);
      if (!record) continue;
      if (looksLikeProposal(record) || !withinWindow(record)) {
        console.log(`[laws] post-verify drop: "${record.title}"`);
        continue;
      }
    }
    try {
      const res = await db.upsertLawChange(record, dupe ? dupe.id : null);
      if (res.created) added++; else updated++;
    } catch (err) {
      // One bad row must not abandon the rest of the sweep.
      console.error(`[laws] upsert failed for "${record.title}": ${err.message}`);
    }
  }
  console.log(`[laws] sweep done - ${items.length} candidates, ${added} new, ${updated} refreshed.`);
  return { skipped: false, found: items.length, added, updated };
}

// -------------------------------------------------------------- milestones --
// Which alert milestone an item is at right now, given its effective date.
// Ranked so an item is only re-surfaced when it crosses into a nearer stage.
const STAGE_RANK = { new: 0, "60d": 1, "30d": 2, "7d": 3, effective: 4 };

function daysUntil(effectiveDate) {
  if (!effectiveDate) return null;
  const d = new Date(effectiveDate);
  if (isNaN(d)) return null;
  const a = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  const n = today();
  const b = Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate());
  return Math.round((a - b) / 86400000);
}

function currentStage(row) {
  const d = daysUntil(row.effective_date);
  if (d === null) return "new";
  if (d <= 0) return "effective";
  if (d <= 7) return "7d";
  if (d <= 30) return "30d";
  if (d <= 60) return "60d";
  return "new";
}

// Shape a DB row into the item the email renderer consumes.
function toItem(row) {
  return {
    id: row.id,
    jurisdiction: row.jurisdiction,
    state: row.jurisdiction,
    title: row.title,
    summary: row.summary,
    action: row.action,
    category: row.category,
    citation: row.citation,
    effective_date: row.effective_date ? iso(new Date(row.effective_date)) : "",
    effective_text: row.effective_text,
    days_until: daysUntil(row.effective_date),
    impact: row.impact,
    source: row.source,
    url: row.url,
    verified: row.verified,
    stage: currentStage(row),
    first_seen: !row.last_alert_stage
  };
}

function sortItems(items) {
  return items.sort((a, b) => {
    const ad = a.days_until === null ? 9999 : a.days_until;
    const bd = b.days_until === null ? 9999 : b.days_until;
    if (ad !== bd) return ad - bd;
    const rank = { high: 0, medium: 1, low: 2 };
    return (rank[a.impact] ?? 1) - (rank[b.impact] ?? 1);
  });
}

// Items to include in this edition: anything never alerted, or that has since
// crossed into a nearer milestone. Soonest effective date first.
async function pending() {
  const rows = await db.listLawChanges({ openOnly: true });
  const due = rows
    .filter(row => {
      const prev = row.last_alert_stage;
      return !prev || STAGE_RANK[currentStage(row)] > STAGE_RANK[prev];
    })
    .map(toItem);
  return sortItems(due);
}

// The full open calendar (for the admin view), regardless of alert state.
async function calendar() {
  const rows = await db.listLawChanges({ openOnly: true });
  return sortItems(rows.map(toItem));
}

// Record that these items went out at their current milestone. Only scheduled
// (or explicitly deduped) sends call this - a test send must not burn a
// milestone the real edition hasn't delivered yet.
async function markAlerted(items) {
  for (const item of items || []) {
    if (!item.id || !item.stage) continue;
    try { await db.markLawAlerted(item.id, item.stage); }
    catch (err) { console.error(`[laws] markAlerted failed for ${item.id}: ${err.message}`); }
  }
}

module.exports = { sweep, pending, calendar, markAlerted, currentStage, daysUntil, looksLikeProposal, STAGE_RANK };
