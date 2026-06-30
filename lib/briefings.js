// Server-side briefing generation for the newsletter job.
// Mirrors the prompts used in public/index.html, but runs on the server with
// sensible national defaults so each area's digest is generated once per send.
const { WATCHLIST, EXCLUDE } = require("./watchlist");

const LOOKBACK_DAYS = parseInt(process.env.NEWSLETTER_LOOKBACK_DAYS || "7", 10);
const DATE_LABEL = `last ${LOOKBACK_DAYS} days`;
const MODEL = process.env.NEWSLETTER_MODEL || "claude-sonnet-4-5";

async function callAnthropic(prompt, opts = {}) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY not configured.");
  const body = {
    model: MODEL,
    max_tokens: 8000,
    messages: [{ role: "user", content: prompt }]
  };
  if (!opts.noTools) body.tools = [{ type: "web_search_20250305", name: "web_search" }];

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "anthropic-beta": "web-search-2025-03-05"
    },
    body: JSON.stringify(body)
  });
  const data = await res.json();
  if (!res.ok) {
    const msg = data && data.error && data.error.message ? data.error.message : JSON.stringify(data);
    throw new Error(`Anthropic API ${res.status}: ${msg}`);
  }
  return (data.content || []).filter(b => b.type === "text").map(b => b.text).join("");
}

function parseJsonArray(text) {
  const clean = (text || "").replace(/```json|```/g, "").trim();
  const match = clean.match(/\[[\s\S]*\]/);
  try {
    const data = JSON.parse(match ? match[0] : clean);
    return Array.isArray(data) ? data : [];
  } catch (e) {
    return [];
  }
}

async function generatePolicy() {
  const prompt =
    `Search the web for news and policy changes from the ${DATE_LABEL} related to home care, Medicaid, and community-based programs at the Federal/National level and across U.S. states.\n` +
    `Topics: Medicaid Policy, Home Care, HCBS / Waivers, EVV / Compliance, Workforce, Budget / Funding, Legislation.\n` +
    `Only include items from the ${DATE_LABEL}. Return ONLY a raw JSON array, no markdown, no fences. Up to 8 items, most important first, each with these exact keys:\n` +
    `{"title":"headline","summary":"2-3 sentences","state":"state or Federal/National","topic":"Medicaid Policy|Home Care|HCBS/Waivers|EVV/Compliance|Workforce|Budget/Funding|Legislation","date":"month year","source":"name","url":"url or empty string","urgency":"high|medium|low"}`;
  return parseJsonArray(await callAnthropic(prompt));
}

async function generateFraud() {
  const prompt =
    `Search the web for Medicaid fraud cases, enforcement actions, and related news from the ${DATE_LABEL} at the Federal/National level and across U.S. states.\n` +
    `Include criminal indictments and charges, civil False Claims Act settlements and recoveries, HHS-OIG audits and reports, DOJ and state Medicaid Fraud Control Unit (MFCU) actions, provider exclusions and license revocations, and whistleblower / qui tam cases. Give extra weight to fraud involving home care, home health, HCBS, personal care, and adult day care.\n` +
    `Only include items from the ${DATE_LABEL}. Return ONLY a raw JSON array, no markdown, no fences. Up to 8 items, most important first, each with these exact keys:\n` +
    `{"title":"headline","summary":"2-3 sentences on who, what, and the alleged scheme","state":"state or Federal/National","category":"Indictment/Charges|Settlement|Audit/OIG|Exclusion|Whistleblower|Other","amount":"dollar amount or empty string","date":"month year","source":"name","url":"url or empty string","severity":"high|medium|low"}`;
  return parseJsonArray(await callAnthropic(prompt));
}

async function generateReputation() {
  // One focused batch over the full watchlist; negatives prioritized.
  const watchStr = WATCHLIST.map(w => "- " + w.name + (w.context ? " — " + w.context : "")).join("\n");
  const exclStr = EXCLUDE.join(", ");
  const prompt =
    `You are a brand-reputation monitor for Honor Health Network, a home care company.\n\n` +
    `Search the web for third-party mentions from the ${DATE_LABEL} of the following Honor-owned agencies, brands, or people. Each item includes context so you return the CORRECT organization and not a similarly-named unrelated one:\n\n` +
    watchStr + `\n\n` +
    `STRICT EXCLUSIONS: Do NOT include content published by Honor itself. Ignore anything from these owned properties and their own social accounts: ${exclStr}. We want what OTHER people, customers, employees, reviewers, and outlets are saying.\n\n` +
    `Prioritize negative or critical mentions: complaints, bad reviews, lawsuits, regulatory actions, layoffs, or negative press. Then notable positive and neutral mentions. If you find nothing for a name, skip it.\n\n` +
    `Return ONLY a raw JSON array, no markdown, no fences. If you find nothing at all, return []. Up to 8 items, negatives first, each with these exact keys:\n` +
    `{"agency":"which watchlist name this is about","title":"headline or post title","summary":"2-3 sentence summary of what was actually said","sentiment":"positive|negative|neutral","platform":"News|Reddit|YouTube|Web|Reviews|Other","source":"site or outlet name","date":"Month Year or empty string","url":"direct url or empty string"}`;
  return parseJsonArray(await callAnthropic(prompt));
}

// Generate only the digests needed for a given set of areas.
async function generateDigests(areas) {
  const want = new Set(areas);
  const out = {};
  const tasks = [];
  if (want.has("policy"))     tasks.push(generatePolicy().then(r => { out.policy = r; }).catch(() => { out.policy = []; }));
  if (want.has("fraud"))      tasks.push(generateFraud().then(r => { out.fraud = r; }).catch(() => { out.fraud = []; }));
  if (want.has("reputation")) tasks.push(generateReputation().then(r => { out.reputation = r; }).catch(() => { out.reputation = []; }));
  await Promise.all(tasks);
  return out;
}

module.exports = { generateDigests, generatePolicy, generateFraud, generateReputation, DATE_LABEL, LOOKBACK_DAYS };
