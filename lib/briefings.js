// Server-side digest generation for the weekly newsletter.
// Engine: Firecrawl search (real web results, past 7 days) + Claude as a
// filter/summarizer over ONLY those results. Claude never invents items -
// every digest item carries a URL that came back from a real search.
const { WATCHLIST, EXCLUDE } = require("./watchlist");
const { searchBatch, scrape } = require("./firecrawl");
const { selfPostedReason, filterSelfPosted } = require("./owned");

const LOOKBACK_DAYS = parseInt(process.env.NEWSLETTER_LOOKBACK_DAYS || "7", 10);
const MODEL = process.env.NEWSLETTER_MODEL || "claude-sonnet-4-5";

// Search recency window and human label for a given lookback in days.
function tbsFor(days) { return days <= 1 ? "qdr:d" : days <= 7 ? "qdr:w" : "qdr:m"; }
function labelFor(days) { return days <= 1 ? "last 24 hours" : `last ${days} days`; }

// States where Honor Health Network operates (drives fraud + policy scoping).
const { STATES } = require("./states");

async function callClaude(prompt) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY not configured.");
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01"
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 8000,
      messages: [{ role: "user", content: prompt }]
    })
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
  try {
    return JSON.parse(match ? match[0] : clean);
  } catch (e) {
    return null;
  }
}

function formatResults(results) {
  return results
    .filter(r => r.url)
    .map(r => `- ${r.title}\n  URL: ${r.url}\n  ${r.date ? "Date: " + r.date + "\n  " : ""}${(r.snippet || "").slice(0, 400)}`)
    .join("\n");
}

const commonRules = (DATE_LABEL) =>
  `Rules:\n` +
  `- Use ONLY the search results provided. Never invent an item, URL, date, or detail not present in them.\n` +
  `- Every item's "url" MUST be one of the provided URLs, copied exactly.\n` +
  `- Merge duplicates (same story from multiple outlets) into one item; prefer the most authoritative source (DOJ/CMS/state gov > trade press > TV news > social).\n` +
  `- Only include items that appear to be from the ${DATE_LABEL}. When a result looks older, skip it.\n` +
  `- NEVER upgrade an allegation into an outcome. "Charged" stays charged, "accused" stays accused, "alleged" stays alleged. Do not write "convicted", "found guilty", "settled", or any resolution unless the snippet literally states it.\n` +
  `- When a snippet is cut off mid-sentence, summarize ONLY the visible part and do not guess how the sentence ends.\n` +
  `- Return ONLY raw JSON, no markdown fences, no commentary.`;

// ---------------------------------------------------------------- policy ----
async function generatePolicy(days = LOOKBACK_DAYS) {
  const TBS = tbsFor(days), DATE_LABEL = labelFor(days);
  const stateGroups = [
    STATES.slice(0, 5).join(" OR "),
    STATES.slice(5).join(" OR ")
  ];
  const jobs = [
    { key: "federal", query: "Medicaid home care policy HCBS rule OR rates OR waiver CMS", opts: { tbs: TBS, limit: 6 } },
    { key: "federal", query: "CMS home health rule OR Medicaid work requirements OR provider tax news", opts: { tbs: TBS, limit: 6 } },
    { key: "states1", query: `home care OR HCBS Medicaid rates OR waiver OR rule ${stateGroups[0]} news`, opts: { tbs: TBS, limit: 6 } },
    { key: "states2", query: `home care OR HCBS Medicaid rates OR waiver OR rule ${stateGroups[1]} news`, opts: { tbs: TBS, limit: 6 } },
    { key: "ny", query: "New York CDPAP OR home care Medicaid moratorium OR oversight news", opts: { tbs: TBS, limit: 6 } },
    // Wage & Hour lane (opt-in topic for HR/payroll subscribers).
    { key: "wage1", query: `minimum wage OR overtime rule OR paid sick leave law change ${stateGroups[0]} news`, opts: { tbs: TBS, limit: 5 } },
    { key: "wage2", query: `minimum wage OR overtime rule OR paid sick leave law change ${stateGroups[1]} news`, opts: { tbs: TBS, limit: 5 } },
    { key: "wage3", query: 'home care OR caregiver "wage theft" OR back pay OR overtime settlement OR DOL wage enforcement', opts: { tbs: TBS, limit: 5 } }
  ];
  const raw = await searchBatch(jobs);
  const all = Object.values(raw).flat();
  if (!all.length) return [];

  const prompt =
    `You are the policy editor for a weekly briefing read by executives of Honor Health Network, ` +
    `a home care company operating in: ${STATES.join(", ")}.\n\n` +
    `Below are raw web/news search results from the ${DATE_LABEL} about Medicaid, home care, and HCBS policy.\n\n` +
    `SEARCH RESULTS:\n${formatResults(all)}\n\n` +
    `Select up to 10 genuinely important policy items, most important first. Prioritize: items in the company's states, ` +
    `enforcement/oversight changes, rate and reimbursement changes, and federal rules affecting home care. ` +
    `Skip: generic explainers, opinion pieces with no news, and anything not policy-related.\n` +
    `Wage & Hour: employer pay-compliance news (minimum wage changes, overtime/FLSA rules, paid sick leave laws, ` +
    `wage theft enforcement and back-pay settlements) gets topic "Wage & Hour" - include up to 3 such items when present, ` +
    `favoring the company's states and the home care industry.\n` +
    commonRules(DATE_LABEL) + `\n` +
    `Return a JSON array where each item has exactly these keys:\n` +
    `{"title":"headline","summary":"1-2 sentences, ending with why it matters to a home care operator","state":"state name or Federal/National","topic":"Medicaid Policy|Home Care|HCBS/Waivers|EVV/Compliance|Workforce|Budget/Funding|Legislation|Wage & Hour","date":"as shown or empty","source":"outlet name","url":"exact provided url","urgency":"high|medium|low"}`;
  const parsed = parseJson(await callClaude(prompt));
  return Array.isArray(parsed) ? parsed : [];
}

// ----------------------------------------------------------------- fraud ----
async function generateFraud(days = LOOKBACK_DAYS) {
  const TBS = tbsFor(days), DATE_LABEL = labelFor(days);
  const stateGroups = [
    STATES.slice(0, 5).join(" OR "),
    STATES.slice(5).join(" OR ")
  ];
  const jobs = [
    { key: "national", query: 'home care OR "personal care" Medicaid fraud indictment OR settlement OR kickback', opts: { tbs: TBS, limit: 6 } },
    { key: "states1", query: `Medicaid fraud home care charged OR sentenced ${stateGroups[0]}`, opts: { tbs: TBS, limit: 6 } },
    { key: "states2", query: `Medicaid fraud home care charged OR sentenced ${stateGroups[1]}`, opts: { tbs: TBS, limit: 6 } },
    { key: "oig", query: "HHS-OIG OR MFCU home health OR personal care enforcement OR exclusion", opts: { tbs: TBS, limit: 5 } }
  ];
  const raw = await searchBatch(jobs);
  const all = Object.values(raw).flat();
  if (!all.length) return [];

  const prompt =
    `You are the fraud-watch editor for a weekly briefing read by executives of Honor Health Network, ` +
    `a home care company operating in: ${STATES.join(", ")}.\n\n` +
    `Below are raw web/news search results from the ${DATE_LABEL} about Medicaid fraud enforcement.\n\n` +
    `SEARCH RESULTS:\n${formatResults(all)}\n\n` +
    `Select up to 6 items, most important first. Prioritize: cases in the company's states, home care / personal care / ` +
    `HCBS schemes, strike force and enforcement-infrastructure news, and large settlements. ` +
    `One item per case even if many outlets covered it.\n` +
    commonRules(DATE_LABEL) + `\n` +
    `Return a JSON array where each item has exactly these keys:\n` +
    `{"title":"headline","summary":"1-2 sentences: who, the scheme, and any lesson for a compliant operator","state":"state name or Federal/National","category":"Indictment/Charges|Settlement|Audit/OIG|Exclusion|Whistleblower|Other","amount":"dollar amount like $4M or empty string","date":"as shown or empty","source":"outlet name","url":"exact provided url","severity":"high|medium|low"}`;
  const parsed = parseJson(await callClaude(prompt));
  return Array.isArray(parsed) ? parsed : [];
}

// ------------------------------------------------------------ reputation ----
function brandQuery(w) {
  // Build a targeted query from the watchlist entry's name + context keywords.
  const ctx = (w.context || "").toLowerCase();
  let hint = "";
  for (const s of STATES) if (ctx.includes(s.toLowerCase())) { hint = s; break; }
  if (!hint && ctx.includes("georgia")) hint = "Georgia";
  const extra = ctx.includes("adult day") ? "adult day care" : (ctx.includes("ceo") ? "" : "home care");
  return `"${w.name}" ${extra} ${hint}`.trim();
}

async function generateReputation(days = LOOKBACK_DAYS) {
  const TBS = tbsFor(days), DATE_LABEL = labelFor(days);
  const jobs = WATCHLIST.map((w, i) => ({
    key: `brand:${w.name}:${i}`,
    query: brandQuery(w),
    opts: { tbs: TBS, limit: 5 }
  }));
  // Extra passes: Reddit + review sites across the biggest brands.
  jobs.push({
    key: "reddit",
    query: 'site:reddit.com "Honor Health Network" OR CaringPays OR "Angels on Call" OR "Juniper Home Care" OR "Nightingale Services"',
    opts: { tbs: TBS, limit: 6, sources: [{ type: "web" }] }
  });
  jobs.push({
    key: "reviews",
    query: '"Honor Health Network" OR CaringPays OR "Angels On Call" reviews OR complaints',
    opts: { tbs: TBS, limit: 6, sources: [{ type: "web" }] }
  });

  const rawAll = await searchBatch(jobs);
  // Strip our own posts and job listings BEFORE the editor sees them, so it
  // cannot pick one and we do not pay tokens to read them. The brand-scoped
  // blocks carry their brand in the key; the reddit/reviews passes are mixed,
  // so those get checked against the whole watchlist.
  const raw = {};
  let selfDropped = 0;
  for (const [key, results] of Object.entries(rawAll)) {
    const brand = key.startsWith("brand:") ? key.split(":")[1] : "";
    raw[key] = results.filter(r => {
      const why = selfPostedReason(r.url, brand, r.title);
      if (why) { selfDropped++; console.log(`[briefings] skipped self-posted result (${why}): ${r.url}`); }
      return !why;
    });
  }
  if (selfDropped) console.log(`[briefings] ${selfDropped} self-posted search result(s) skipped.`);
  const blocks = Object.entries(raw)
    .filter(([, results]) => results.length)
    .map(([key, results]) => `### Search: ${key}\n${formatResults(results)}`)
    .join("\n\n");

  const watchStr = WATCHLIST.map(w => "- " + w.name + (w.context ? " - " + w.context : "")).join("\n");
  const allNames = WATCHLIST.map(w => w.name);
  if (!blocks) return { items: [], quiet: allNames };

  const prompt =
    `You are the reputation editor for a weekly brand-monitoring briefing for Honor Health Network, a home care company.\n\n` +
    `WATCHLIST (with disambiguation context - be strict; many names are generic or match unrelated companies):\n${watchStr}\n\n` +
    `Below are raw search results from the ${DATE_LABEL}, one block per brand search.\n\n` +
    `${blocks}\n\n` +
    `Select genuine THIRD-PARTY mentions of watchlist brands/people. Exclusions:\n` +
    `- Content published by the brands themselves (their own websites, own social accounts, own event promo posts). Owned properties: ${EXCLUDE.join(", ")}. Self-posted results are stripped before you see them, so anything left that still reads as the brand talking about itself should go too.\n` +
    `- Plain job listings (EXCEPT when they reveal something notable, like entry into a new market - then include as neutral with that framing).\n` +
    `- Results about similarly-named unrelated companies (e.g. HonorHealth the Arizona hospital system, First Horizon Bank, Visiting Angels - the national franchise, NOT Angels On Call - generic uses of phrases like "hand in hand"). Home care is crowded with lookalike names; if the company in the result is not clearly the watchlist brand itself, exclude it.\n` +
    `- ONE item per story/URL, even when it involves multiple watchlist brands (e.g. an acquisition). Output a single item and put all involved names in "agency", joined with " + " (e.g. "Honor Health Network + Agility Home Care"). Never repeat the same story under two brands.\n` +
    `- The "url" of each item must be the url of the EXACT search result the summary came from. Never pair a summary with a different result's link.\n` +
    `Order: negative/critical mentions first, then anything ambiguous that a human should review (sentiment "review"), then positive, news, neutral.\n` +
    commonRules(DATE_LABEL) + `\n` +
    `Return a JSON object with exactly these keys:\n` +
    `{"items":[{"agency":"watchlist name","title":"headline","summary":"1-2 sentences on what was actually said","sentiment":"negative|review|positive|news|neutral","platform":"News|Reddit|YouTube|Web|Reviews|Facebook|LinkedIn|Other","source":"site name","date":"as shown or empty","url":"exact provided url"}],` +
    `"quiet":["every watchlist brand with no genuine third-party mention"]}`;
  const parsed = parseJson(await callClaude(prompt));
  if (!parsed || !Array.isArray(parsed.items)) return { items: [], quiet: allNames };
  if (!Array.isArray(parsed.quiet)) {
    const mentioned = new Set(parsed.items.map(i => i.agency));
    parsed.quiet = allNames.filter(n => !mentioned.has(n));
  }
  parsed.items = dedupeByUrl(parsed.items);
  parsed.items = pairCheck(parsed.items, raw);
  // Second pass over the editor's picks: the pre-filter cannot catch an owned
  // URL the editor attributed to a different brand, and a prompt is never a
  // guarantee.
  parsed.items = filterSelfPosted(parsed.items).items;
  parsed.items = await verifyFlaggedItems(parsed.items);
  // A brand whose only mentions were its own posts is quiet this edition, not
  // covered - recompute rather than trusting the editor's list.
  const stillMentioned = new Set();
  for (const it of parsed.items) String(it.agency || "").split("+").forEach(n => stillMentioned.add(n.trim()));
  parsed.quiet = allNames.filter(n => !stillMentioned.has(n));
  return parsed;
}

// Guard against summary/link mispairing (an editor failure mode where a
// summary gets another result's URL attached): every item's URL must be a
// real search-result URL, and that result's own title/snippet should mention
// the brand the item is filed under. URLs that never appeared in the results
// are dropped outright; mismatched pairings are marked so the verify pass
// checks the actual source page regardless of sentiment.
function normU(u) { return String(u || "").trim().replace(/\/$/, "").toLowerCase(); }
function pairCheck(items, raw) {
  const srcByUrl = new Map();
  for (const results of Object.values(raw)) {
    for (const r of results) {
      if (r.url) srcByUrl.set(normU(r.url), `${r.title || ""} ${r.snippet || ""}`.toLowerCase());
    }
  }
  const out = [];
  for (const item of items) {
    const src = item.url ? srcByUrl.get(normU(item.url)) : undefined;
    if (item.url && src === undefined) {
      console.log(`[briefings] dropped item with non-result url: ${item.agency} - "${item.title}" - ${item.url}`);
      continue;
    }
    if (src !== undefined) {
      const names = String(item.agency || "").split("+").map(s => s.trim()).filter(Boolean);
      const mentioned = !names.length || names.some(n => src.includes(n.toLowerCase()) || src.includes(coreName(n).toLowerCase()));
      if (!mentioned) item._pairSuspect = true;
    }
    out.push(item);
  }
  return out;
}

// Hard safety net: the same source URL never appears twice. When one story
// involves several watchlist brands, the brand labels are merged instead.
function dedupeByUrl(items) {
  const seen = new Map();
  for (const item of items) {
    const key = String(item.url || item.title || "").trim().replace(/\/$/, "").toLowerCase();
    const prev = seen.get(key);
    if (prev) {
      if (item.agency && prev.agency && !prev.agency.includes(item.agency)) {
        prev.agency += " + " + item.agency;
      }
      // Keep the more cautious sentiment if they disagree.
      const rank = { negative: 0, review: 1, neutral: 2, news: 3, positive: 4 };
      if ((rank[(item.sentiment || "").toLowerCase()] ?? 2) < (rank[(prev.sentiment || "").toLowerCase()] ?? 2)) {
        prev.sentiment = item.sentiment;
      }
    } else {
      seen.set(key, { ...item });
    }
  }
  return Array.from(seen.values());
}

// A lookalike-brand tripwire: if none of the item's watchlist names (nor their
// core form, minus generic trailing words like "Home Care"/"Services") appear
// in the item's own title/summary, the editor likely mis-tagged a similarly
// named company (e.g. a Visiting Angels story filed under Angels On Call).
const GENERIC_TAIL = new Set(["home", "care", "homecare", "services", "service",
  "healthcare", "and", "of", "the", "adult", "day", "medical", "nursing"]);
function coreName(name) {
  const words = String(name).trim().split(/\s+/);
  while (words.length > 1 && GENERIC_TAIL.has(words[words.length - 1].toLowerCase())) words.pop();
  return words.join(" ");
}
function brandMentioned(item) {
  const text = `${item.title || ""} ${item.summary || ""}`.toLowerCase();
  const names = String(item.agency || "").split("+").map(s => s.trim()).filter(Boolean);
  if (!names.length) return true;
  return names.some(n => text.includes(n.toLowerCase()) || text.includes(coreName(n).toLowerCase()));
}

// Second pass for reputation items that are negative/needs-review, fail the
// lookalike tripwire above, or were flagged by pairCheck as a possible
// summary/link mismatch: fetch the actual source page and rewrite the item
// strictly from what the page says. Search snippets are often truncated
// mid-sentence, and a wrong claim about e.g. a criminal case is worse than no
// item at all. Policy: anything that cannot be verified against its source
// page is EXCLUDED from the email (and logged), never published with a
// warning label.
async function verifyFlaggedItems(items) {
  const out = [];
  let checked = 0;
  for (const item of items) {
    const suspect = item._pairSuspect === true;
    delete item._pairSuspect;
    const flagged = ["negative", "review"].includes((item.sentiment || "").toLowerCase())
      || !brandMentioned(item) || suspect;
    if (!flagged || !item.url || checked >= 8) { out.push(item); continue; }
    checked++;
    let page = "";
    try { page = await scrape(item.url); } catch (e) {
      console.error(`[briefings] verify scrape failed for ${item.url}: ${e.message}`);
    }
    if (!page || page.length < 120) {
      // Can't read the source (login walls, blocked bots). Unverifiable claims
      // don't go in the email at all - logged here for the record instead.
      console.log(`[briefings] EXCLUDED unverifiable item: ${item.agency} - "${item.title}" - ${item.url}`);
      continue;
    }
    const prompt =
      `You are fact-checking one item in a reputation digest before it is emailed to executives.\n\n` +
      `DRAFT ITEM (from a possibly-truncated search snippet):\n${JSON.stringify(item)}\n\n` +
      `FULL SOURCE PAGE CONTENT:\n${page.slice(0, 6000)}\n\n` +
      `Rules:\n` +
      `- If the page does NOT actually mention "${item.agency}", return {"drop": true}.\n` +
      `- Otherwise rewrite the item using ONLY facts stated on the page. Allegations stay allegations; never state charges as convictions or outcomes the page doesn't state.\n` +
      `- Keep sentiment "negative" only if the page genuinely reflects negatively on the brand itself; if it is ambiguous or tangential, use "neutral" (or {"drop": true} if it isn't really about the brand).\n` +
      `Return ONLY raw JSON: {"drop": false, "title": "...", "summary": "1-2 sentences", "sentiment": "negative|neutral|positive|news"}`;
    try {
      const check = parseJson(await callClaude(prompt));
      if (check && check.drop === true) {
        console.log(`[briefings] verify dropped item (brand not on page): ${item.url}`);
        continue;
      }
      if (check && check.title && check.summary) {
        item.title = check.title;
        item.summary = check.summary;
        if (check.sentiment) item.sentiment = check.sentiment;
      }
    } catch (e) {
      // Verification itself failed - same policy: unverified claims stay out.
      console.error(`[briefings] verify pass failed, item excluded: ${e.message}`);
      continue;
    }
    out.push(item);
  }
  return out;
}

// Law-change lane: enacted state + federal changes and their effective dates.
// This one is NOT a recency sweep - it reads the persistent compliance calendar
// (lib/lawtracker.js) and returns whatever is due to be flagged today, so a law
// signed months ago still gets an alert as its effective date approaches.
// opts.sweep runs a fresh search pass first (throttled to once a day by default).
async function collectLaws(opts = {}) {
  const lawtracker = require("./lawtracker");
  if (opts.sweep !== false) {
    try { await lawtracker.sweep({ backfill: opts.backfill === true, force: opts.forceSweep === true }); }
    catch (err) { console.error("[briefings] law sweep failed (using existing calendar):", err.message); }
  }
  return lawtracker.pending();
}

// Generate only the digests needed for a given set of areas.
// Shape: { policy: [], fraud: [], reputation: [], reputationQuiet: [], laws: [] }
// Law changes ride along with the "policy" area - a compliance deadline isn't an
// opt-in topic for anyone who has asked for policy coverage.
async function generateDigests(areas, days = LOOKBACK_DAYS, opts = {}) {
  const want = new Set(areas);
  const out = {};
  const tasks = [];
  if (want.has("policy") && opts.laws !== false) {
    tasks.push(collectLaws(opts).then(r => { out.laws = r; }).catch(err => { console.error("[briefings] laws failed:", err.message); out.laws = []; }));
  }
  if (want.has("policy")) tasks.push(generatePolicy(days).then(r => { out.policy = r; }).catch(err => { console.error("[briefings] policy failed:", err.message); out.policy = []; }));
  if (want.has("fraud")) tasks.push(generateFraud(days).then(r => { out.fraud = r; }).catch(err => { console.error("[briefings] fraud failed:", err.message); out.fraud = []; }));
  if (want.has("reputation")) tasks.push(generateReputation(days).then(r => { out.reputation = r.items; out.reputationQuiet = r.quiet; }).catch(err => { console.error("[briefings] reputation failed:", err.message); out.reputation = []; out.reputationQuiet = []; }));
  await Promise.all(tasks);
  return out;
}

module.exports = { generateDigests, generatePolicy, generateFraud, generateReputation, collectLaws, LOOKBACK_DAYS };
