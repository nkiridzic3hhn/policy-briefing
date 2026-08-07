// Server-side digest generation for the weekly newsletter.
// Engine: Firecrawl search (real web results, past 7 days) + Claude as a
// filter/summarizer over ONLY those results. Claude never invents items —
// every digest item carries a URL that came back from a real search.
const { WATCHLIST, EXCLUDE } = require("./watchlist");
const { searchBatch, scrape } = require("./firecrawl");

const LOOKBACK_DAYS = parseInt(process.env.NEWSLETTER_LOOKBACK_DAYS || "7", 10);
const DATE_LABEL = `last ${LOOKBACK_DAYS} days`;
// tbs window: past week by default; past month if lookback is longer.
const TBS = LOOKBACK_DAYS <= 7 ? "qdr:w" : "qdr:m";
const MODEL = process.env.NEWSLETTER_MODEL || "claude-sonnet-4-5";

// States where Honor Health Network operates (drives fraud + policy scoping).
const STATES = ["New York", "New Jersey", "Pennsylvania", "Massachusetts", "Connecticut",
  "Georgia", "Michigan", "Indiana", "Colorado", "Maryland", "Washington DC"];

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

const COMMON_RULES =
  `Rules:\n` +
  `- Use ONLY the search results provided. Never invent an item, URL, date, or detail not present in them.\n` +
  `- Every item's "url" MUST be one of the provided URLs, copied exactly.\n` +
  `- Merge duplicates (same story from multiple outlets) into one item; prefer the most authoritative source (DOJ/CMS/state gov > trade press > TV news > social).\n` +
  `- Only include items that appear to be from the ${DATE_LABEL}. When a result looks older, skip it.\n` +
  `- NEVER upgrade an allegation into an outcome. "Charged" stays charged, "accused" stays accused, "alleged" stays alleged. Do not write "convicted", "found guilty", "settled", or any resolution unless the snippet literally states it.\n` +
  `- When a snippet is cut off mid-sentence, summarize ONLY the visible part and do not guess how the sentence ends.\n` +
  `- Return ONLY raw JSON, no markdown fences, no commentary.`;

// ---------------------------------------------------------------- policy ----
async function generatePolicy() {
  const stateGroups = [
    STATES.slice(0, 5).join(" OR "),
    STATES.slice(5).join(" OR ")
  ];
  const jobs = [
    { key: "federal", query: "Medicaid home care policy HCBS rule OR rates OR waiver CMS", opts: { tbs: TBS, limit: 6 } },
    { key: "federal", query: "CMS home health rule OR Medicaid work requirements OR provider tax news", opts: { tbs: TBS, limit: 6 } },
    { key: "states1", query: `home care OR HCBS Medicaid rates OR waiver OR rule ${stateGroups[0]} news`, opts: { tbs: TBS, limit: 6 } },
    { key: "states2", query: `home care OR HCBS Medicaid rates OR waiver OR rule ${stateGroups[1]} news`, opts: { tbs: TBS, limit: 6 } },
    { key: "ny", query: "New York CDPAP OR home care Medicaid moratorium OR oversight news", opts: { tbs: TBS, limit: 6 } }
  ];
  const raw = await searchBatch(jobs);
  const all = Object.values(raw).flat();
  if (!all.length) return [];

  const prompt =
    `You are the policy editor for a weekly briefing read by executives of Honor Health Network, ` +
    `a home care company operating in: ${STATES.join(", ")}.\n\n` +
    `Below are raw web/news search results from the ${DATE_LABEL} about Medicaid, home care, and HCBS policy.\n\n` +
    `SEARCH RESULTS:\n${formatResults(all)}\n\n` +
    `Select up to 7 genuinely important policy items, most important first. Prioritize: items in the company's states, ` +
    `enforcement/oversight changes, rate and reimbursement changes, and federal rules affecting home care. ` +
    `Skip: generic explainers, opinion pieces with no news, and anything not policy-related.\n` +
    COMMON_RULES + `\n` +
    `Return a JSON array where each item has exactly these keys:\n` +
    `{"title":"headline","summary":"1-2 sentences, ending with why it matters to a home care operator","state":"state name or Federal/National","topic":"Medicaid Policy|Home Care|HCBS/Waivers|EVV/Compliance|Workforce|Budget/Funding|Legislation","date":"as shown or empty","source":"outlet name","url":"exact provided url","urgency":"high|medium|low"}`;
  const parsed = parseJson(await callClaude(prompt));
  return Array.isArray(parsed) ? parsed : [];
}

// ----------------------------------------------------------------- fraud ----
async function generateFraud() {
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
    COMMON_RULES + `\n` +
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

async function generateReputation() {
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

  const raw = await searchBatch(jobs);
  const blocks = Object.entries(raw)
    .filter(([, results]) => results.length)
    .map(([key, results]) => `### Search: ${key}\n${formatResults(results)}`)
    .join("\n\n");

  const watchStr = WATCHLIST.map(w => "- " + w.name + (w.context ? " — " + w.context : "")).join("\n");
  const allNames = WATCHLIST.map(w => w.name);
  if (!blocks) return { items: [], quiet: allNames };

  const prompt =
    `You are the reputation editor for a weekly brand-monitoring briefing for Honor Health Network, a home care company.\n\n` +
    `WATCHLIST (with disambiguation context — be strict; many names are generic or match unrelated companies):\n${watchStr}\n\n` +
    `Below are raw search results from the ${DATE_LABEL}, one block per brand search.\n\n` +
    `${blocks}\n\n` +
    `Select genuine THIRD-PARTY mentions of watchlist brands/people. Exclusions:\n` +
    `- Content published by the brands themselves (their own websites, own social accounts, own event promo posts). Owned properties: ${EXCLUDE.join(", ")}.\n` +
    `- Plain job listings (EXCEPT when they reveal something notable, like entry into a new market — then include as neutral with that framing).\n` +
    `- Results about similarly-named unrelated companies (e.g. HonorHealth the Arizona hospital system, First Horizon Bank, generic uses of phrases like "hand in hand").\n` +
    `Order: negative/critical mentions first, then anything ambiguous that a human should review (sentiment "review"), then positive, news, neutral.\n` +
    COMMON_RULES + `\n` +
    `Return a JSON object with exactly these keys:\n` +
    `{"items":[{"agency":"watchlist name","title":"headline","summary":"1-2 sentences on what was actually said","sentiment":"negative|review|positive|news|neutral","platform":"News|Reddit|YouTube|Web|Reviews|Facebook|LinkedIn|Other","source":"site name","date":"as shown or empty","url":"exact provided url"}],` +
    `"quiet":["every watchlist brand with no genuine third-party mention"]}`;
  const parsed = parseJson(await callClaude(prompt));
  if (!parsed || !Array.isArray(parsed.items)) return { items: [], quiet: allNames };
  if (!Array.isArray(parsed.quiet)) {
    const mentioned = new Set(parsed.items.map(i => i.agency));
    parsed.quiet = allNames.filter(n => !mentioned.has(n));
  }
  parsed.items = await verifyFlaggedItems(parsed.items);
  return parsed;
}

// Second pass for negative/needs-review reputation items: fetch the actual
// source page and rewrite the item strictly from what the page says. Search
// snippets are often truncated mid-sentence, and a wrong claim about e.g. a
// criminal case is worse than no item at all. Policy: anything that cannot be
// verified against its source page is EXCLUDED from the email (and logged),
// never published with a warning label.
async function verifyFlaggedItems(items) {
  const out = [];
  let checked = 0;
  for (const item of items) {
    const flagged = ["negative", "review"].includes((item.sentiment || "").toLowerCase());
    if (!flagged || !item.url || checked >= 4) { out.push(item); continue; }
    checked++;
    let page = "";
    try { page = await scrape(item.url); } catch (e) {
      console.error(`[briefings] verify scrape failed for ${item.url}: ${e.message}`);
    }
    if (!page || page.length < 120) {
      // Can't read the source (login walls, blocked bots). Unverifiable claims
      // don't go in the email at all — logged here for the record instead.
      console.log(`[briefings] EXCLUDED unverifiable item: ${item.agency} — "${item.title}" — ${item.url}`);
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
      // Verification itself failed — same policy: unverified claims stay out.
      console.error(`[briefings] verify pass failed, item excluded: ${e.message}`);
      continue;
    }
    out.push(item);
  }
  return out;
}

// Generate only the digests needed for a given set of areas.
// Shape: { policy: [], fraud: [], reputation: [], reputationQuiet: [] }
async function generateDigests(areas) {
  const want = new Set(areas);
  const out = {};
  const tasks = [];
  if (want.has("policy")) tasks.push(generatePolicy().then(r => { out.policy = r; }).catch(err => { console.error("[briefings] policy failed:", err.message); out.policy = []; }));
  if (want.has("fraud")) tasks.push(generateFraud().then(r => { out.fraud = r; }).catch(err => { console.error("[briefings] fraud failed:", err.message); out.fraud = []; }));
  if (want.has("reputation")) tasks.push(generateReputation().then(r => { out.reputation = r.items; out.reputationQuiet = r.quiet; }).catch(err => { console.error("[briefings] reputation failed:", err.message); out.reputation = []; out.reputationQuiet = []; }));
  await Promise.all(tasks);
  return out;
}

module.exports = { generateDigests, generatePolicy, generateFraud, generateReputation, DATE_LABEL, LOOKBACK_DAYS };
