// Thin wrapper around the Firecrawl Search API (no SDK dependency).
// Returns a flat, normalized list of results across web + news sources.

const API_URL = "https://api.firecrawl.dev/v2/search";

async function search(query, opts = {}) {
  const apiKey = process.env.FIRECRAWL_API_KEY;
  if (!apiKey) throw new Error("FIRECRAWL_API_KEY not configured.");

  const body = {
    query,
    limit: opts.limit || 5,
    sources: opts.sources || [{ type: "web" }, { type: "news" }]
  };
  if (opts.tbs) body.tbs = opts.tbs; // e.g. "qdr:w" = past week

  const res = await fetch(API_URL, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data && data.error ? data.error : JSON.stringify(data);
    throw new Error(`Firecrawl ${res.status}: ${msg}`);
  }

  const out = [];
  const d = data.data || {};
  (d.web || []).forEach(r => out.push({
    title: r.title || "", url: r.url || "", snippet: r.description || "", date: "", sourceType: "web"
  }));
  (d.news || []).forEach(r => out.push({
    title: r.title || "", url: r.url || "", snippet: r.snippet || "", date: r.date || "", sourceType: "news"
  }));
  return out;
}

// Run many searches with limited concurrency. Each job: { key, query, opts }.
// Returns { key: results[] }; a failed search yields [] rather than aborting the run.
async function searchBatch(jobs, concurrency = 4) {
  const results = {};
  let i = 0;
  async function worker() {
    while (i < jobs.length) {
      const job = jobs[i++];
      try {
        const r = await search(job.query, job.opts || {});
        results[job.key] = (results[job.key] || []).concat(r);
      } catch (err) {
        console.error(`[firecrawl] "${job.query}" failed: ${err.message}`);
        results[job.key] = results[job.key] || [];
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, jobs.length) }, worker));
  return results;
}

// Fetch a single page's main content as markdown (used to verify flagged
// reputation items against the actual source before publishing a claim).
async function scrape(url) {
  const apiKey = process.env.FIRECRAWL_API_KEY;
  if (!apiKey) throw new Error("FIRECRAWL_API_KEY not configured.");
  const res = await fetch("https://api.firecrawl.dev/v2/scrape", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ url, formats: ["markdown"], onlyMainContent: true, timeout: 30000 })
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data && data.error ? data.error : `HTTP ${res.status}`;
    throw new Error(`Firecrawl scrape ${msg}`);
  }
  return (data.data && data.data.markdown) || "";
}

module.exports = { search, searchBatch, scrape };
