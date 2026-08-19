const express = require("express");
const session = require("express-session");
const crypto = require("crypto");
const path = require("path");
const db = require("./lib/db");
const { renderEmail } = require("./emails/render");
const { sendEmail } = require("./lib/email");

const app = express();
app.use(express.json());

const DB_ENABLED = !!process.env.DATABASE_URL;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// --- Auth config: set AUTH_USER / AUTH_PASS in your environment / Railway variables.
// No credentials are stored in this (public) repo. If they are unset, logins are refused. ---
const AUTH_USER = process.env.AUTH_USER || "";
const AUTH_PASS = process.env.AUTH_PASS || "";

// Separate credential for the newsletter admin portal (/admin). Distinct from the
// dashboard login so newsletter management can be gated on its own.
const ADMIN_USER = process.env.ADMIN_USER || "";
const ADMIN_PASS = process.env.ADMIN_PASS || "";

app.set("trust proxy", 1); // needed for secure cookies behind Railway/Render
app.use(
  session({
    secret: process.env.SESSION_SECRET || crypto.randomBytes(32).toString("hex"),
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      maxAge: 1000 * 60 * 60 * 24 * 7 // 7 days
    }
  })
);

// Constant-time string comparison to avoid timing attacks
function safeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

// --- Login / logout (open routes) ---
app.get("/login", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "login.html"));
});

app.post("/api/login", (req, res) => {
  if (!AUTH_USER || !AUTH_PASS) {
    return res.status(503).json({ error: "Login is not configured. Set AUTH_USER and AUTH_PASS." });
  }
  const { username, password } = req.body || {};
  if (safeEqual(username, AUTH_USER) && safeEqual(password, AUTH_PASS)) {
    req.session.authed = true;
    return res.json({ ok: true });
  }
  res.status(401).json({ error: "Invalid username or password." });
});

app.post("/api/logout", (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

// --- Key-protected manual newsletter trigger (open route, gated by RUN_KEY) ---
// POST /api/newsletter/run-key with header X-Run-Key: $RUN_KEY. Lets automation
// or an operator fire a send without a browser session or waiting for the cron.
app.post("/api/newsletter/run-key", async (req, res) => {
  const key = process.env.RUN_KEY || "";
  if (!key || !safeEqual(req.get("x-run-key") || "", key)) {
    return res.status(401).json({ error: "Bad or missing key." });
  }
  if (!DB_ENABLED) return res.status(503).json({ error: "Database not configured." });
  try {
    const { runNewsletter } = require("./jobs/newsletter");
    // Optional body: { only: "someone@x.com" } targets one subscriber;
    // { dedupe: true } makes the run behave exactly like a scheduled send
    // (drops already-sent stories and remembers the new ones).
    const body = req.body || {};
    // { laws: true } runs only the law-change sweep (no email). Add
    // { backfill: true } to widen the search window to a year - that is how the
    // calendar gets seeded with changes enacted months ago whose effective dates
    // are still ahead of us.
    if (body.laws === true) {
      const lawtracker = require("./lib/lawtracker");
      await db.init();
      const result = await lawtracker.sweep({ force: true, backfill: body.backfill === true });
      const pending = await lawtracker.pending();
      return res.json({ ok: true, sweep: result, pendingAlerts: pending.length });
    }
    // { watchdog: true } runs the health check + status email instead of a send.
    if (body.watchdog === true) {
      const { runWatchdog } = require("./jobs/watchdog");
      const result = await runWatchdog();
      return res.json({ ok: true, watchdog: result });
    }
    const result = await runNewsletter({ trigger: "manual", only: body.only, dedupe: body.dedupe === true, forceSweep: body.sweep === true });
    res.json({ ok: true, result });
  } catch (err) {
    console.error("run-key newsletter run failed:", err);
    res.status(500).json({ error: err.message });
  }
});

// --- Newsletter signup (open routes - no login required) ---
const VALID_AREAS = ["policy", "reputation", "fraud"];
const { STATES: VALID_STATES } = require("./lib/states");
const VALID_TOPICS = ["Medicaid Policy", "Home Care", "HCBS/Waivers", "EVV/Compliance",
  "Workforce", "Budget/Funding", "Legislation", "Wage & Hour"];
const { WATCHLIST } = require("./lib/watchlist");
const VALID_BRANDS = [...new Set(WATCHLIST.map(w => w.name))];

app.get("/subscribe", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "subscribe.html"));
});

app.post("/api/subscribe", async (req, res) => {
  if (!DB_ENABLED) return res.status(503).json({ error: "Subscriptions aren't set up yet. Try again soon." });
  const body = req.body || {};
  const email = String(body.email || "").toLowerCase().trim();
  const areas = Array.isArray(body.areas) ? body.areas.filter(a => VALID_AREAS.includes(a)) : [];
  if (!EMAIL_RE.test(email)) return res.status(400).json({ error: "Please enter a valid email address." });
  if (!areas.length) return res.status(400).json({ error: "Pick at least one area to follow." });

  // Optional personalization; empty arrays mean "everything".
  const states = Array.isArray(body.states) ? body.states.filter(s => VALID_STATES.includes(s)) : [];
  const topics = Array.isArray(body.topics) ? body.topics.filter(t => VALID_TOPICS.includes(t)) : [];
  const brands = Array.isArray(body.brands) ? body.brands.filter(b => VALID_BRANDS.includes(b)) : [];
  const frequency = ["daily", "weekly", "monthly"].includes(body.frequency) ? body.frequency : "weekly";
  const prefs = {};
  if (states.length && states.length < VALID_STATES.length) prefs.states = states;
  // "Wage & Hour" is opt-in, so any selection that includes it must be stored
  // explicitly (never collapsed into the "everything" default).
  if (topics.length && (topics.length < VALID_TOPICS.length || topics.includes("Wage & Hour"))) prefs.topics = topics;
  if (brands.length && brands.length < VALID_BRANDS.length) prefs.brands = brands;
  if (frequency !== "weekly") prefs.frequency = frequency;

  try {
    const token = crypto.randomBytes(24).toString("hex");
    const sub = await db.upsertSubscriber(email, areas, token, prefs);
    // Best-effort welcome email; never block signup on it.
    if (process.env.RESEND_API_KEY) {
      const appUrl = process.env.APP_URL || "https://www.pieceofpi.app";
      const unsubUrl = `${appUrl.replace(/\/$/, "")}/unsubscribe?token=${encodeURIComponent(sub.token)}`;
      const cadence = frequency === "daily" ? "every weekday morning"
        : frequency === "monthly" ? "on the first Monday of each month" : "every Monday morning";
      const AREA_LABELS = { policy: "Policy Intelligence", fraud: "Medicaid Fraud", reputation: "Reputation Watch" };
      const areaNames = areas.map(a => AREA_LABELS[a] || a).join(", ");
      sendEmail({
        to: email,
        subject: "You're subscribed to Piece of Pi",
        // cid:logo makes sendEmail attach the embedded logo, so it renders even
        // in corporate Outlook (which blocks remote images).
        html: `<div style="font-family:Arial,sans-serif;max-width:520px;margin:auto;color:#2a0f18;text-align:center;padding:24px 0;">
          <img src="cid:logo" alt="Piece of Pi" height="88" style="height:88px;margin-bottom:12px;">
          <h2 style="color:#c03060;">You're subscribed 🥧</h2>
          <p>You'll get your Piece of Pi snapshot <strong>${cadence}</strong>, covering: <strong>${areaNames}</strong>.</p>
          <p style="font-size:12px;color:#b8788a;">Changed your mind? <a href="${unsubUrl}" style="color:#8a4055;">Unsubscribe anytime</a>.</p>
        </div>`
      }).catch(err => console.error("welcome email failed:", err.message));
    }
    res.json({ ok: true });
  } catch (err) {
    console.error("subscribe error:", err);
    res.status(500).json({ error: "Could not save your subscription. Please try again." });
  }
});

app.get("/unsubscribe", async (req, res) => {
  const token = String(req.query.token || "");
  let email = null;
  if (DB_ENABLED && token) {
    try { const row = await db.unsubscribeByToken(token); email = row && row.email; }
    catch (err) { console.error("unsubscribe error:", err); }
  }
  res.set("Content-Type", "text/html").send(`<!DOCTYPE html><html><head><meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1"><title>Unsubscribed · Piece of Pi</title>
    <style>body{font-family:'Helvetica Neue',Arial,sans-serif;background:#f4e9ed;color:#2a0f18;display:flex;
    min-height:100vh;align-items:center;justify-content:center;margin:0;padding:24px;}
    .c{background:#fff;border:1px solid #f1d6de;border-radius:14px;padding:36px 32px;max-width:420px;text-align:center;}
    h1{font-size:20px;color:#c03060;margin:0 0 8px;}p{font-size:14px;color:#8a4055;line-height:1.6;margin:0;}
    a{color:#c03060;}</style></head><body><div class="c">
    <h1>${email ? "You're unsubscribed" : "Link not recognized"}</h1>
    <p>${email
      ? `<strong>${email}</strong> won't receive any more Piece of Pi briefings. Changed your mind? <a href="/subscribe">Re-subscribe here</a>.`
      : `We couldn't find that unsubscribe link. It may have already been used. <a href="/subscribe">Manage your subscription</a>.`}</p>
    </div></body></html>`);
});

// --- Newsletter admin portal (separate credential, its own gate) ---
function requireAdmin(req, res, next) {
  if (req.session && req.session.admin) return next();
  if (req.path.startsWith("/api/")) return res.status(401).json({ error: "Not authenticated" });
  return res.redirect("/admin/login");
}

// Sample content used by the email design preview (no API calls, instant).
const SAMPLE_DIGESTS = {
  laws: [
    { id: 901, jurisdiction: "New Jersey", state: "New Jersey", title: "NJ raises the temporary-disability and family-leave wage base", summary: "The enacted change lifts the taxable wage base used for TDI and FLI contributions for the coming plan year.", action: "Update payroll withholding tables before the first January payroll.", category: "Wage & Hour", citation: "P.L. 2026 c.42", effective_date: "2027-01-01", effective_text: "January 1, 2027", days_until: 45, impact: "high", source: "NJ Dept. of Labor", url: "https://www.nj.gov/labor/", verified: true, stage: "60d", first_seen: true },
    { id: 902, jurisdiction: "Federal", state: "Federal", title: "DOL final rule updates recordkeeping for home care workers", summary: "The final rule published in the Federal Register revises how employers must retain hours-worked records for domestic service employees.", action: "Confirm the timekeeping system retains records for the new period.", category: "Wage & Hour", citation: "RIN 1235-AA43", effective_date: "2026-09-15", effective_text: "September 15, 2026", days_until: 5, impact: "medium", source: "Federal Register", url: "https://www.federalregister.gov", verified: true, stage: "7d", first_seen: false }
  ],
  policy: [
    { title: "CMS finalizes Access Rule 80/20 pass-through for HCBS", summary: "The final rule requires 80% of Medicaid payments for homemaker, home health aide, and personal care services to go to direct-care worker compensation. States have a multi-year phase-in.", state: "Federal/National", topic: "HCBS/Waivers", date: "March 2026", source: "CMS.gov", url: "https://www.cms.gov", urgency: "high" },
    { title: "State budget adds $120M for home care rate increase", summary: "The enacted budget raises personal care reimbursement rates by an average of 6% and funds a wage floor for aides.", state: "New York", topic: "Budget/Funding", date: "April 2026", source: "State Health Dept", url: "", urgency: "medium" }
  ],
  fraud: [
    { title: "Home care agency owner charged in $9M personal-care billing scheme", summary: "DOJ alleges the owner billed Medicaid for services not rendered and paid kickbacks for beneficiary referrals over four years.", state: "New Jersey", category: "Indictment/Charges", amount: "$9M", date: "April 2026", source: "DOJ", url: "https://www.justice.gov", severity: "high" },
    { title: "HHS-OIG report flags EVV gaps in personal care programs", summary: "Audit found several states could not verify a portion of billed personal-care visits against electronic visit verification records.", state: "Federal/National", category: "Audit/OIG", amount: "", date: "March 2026", source: "HHS-OIG", url: "", severity: "medium" }
  ],
  reputation: [
    { agency: "Quality Healthcare", title: "Mixed reviews on caregiver scheduling", summary: "Recent reviews praise individual aides but raise concerns about last-minute schedule changes and call-center wait times.", sentiment: "negative", platform: "Reviews", source: "Google Reviews", date: "April 2026", url: "" },
    { agency: "CaringPays", title: "Local news features paid-family-caregiver program", summary: "A regional outlet profiled a family using the program, describing it positively as a way to compensate relatives who provide care.", sentiment: "positive", platform: "News", source: "Local News", date: "March 2026", url: "" }
  ]
};

app.get("/admin/login", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "admin-login.html"));
});

app.post("/api/admin/login", (req, res) => {
  if (!ADMIN_USER || !ADMIN_PASS) return res.status(503).json({ error: "Admin login is not configured. Set ADMIN_USER and ADMIN_PASS." });
  const { username, password } = req.body || {};
  if (safeEqual(username, ADMIN_USER) && safeEqual(password, ADMIN_PASS)) {
    req.session.admin = true;
    return res.json({ ok: true });
  }
  res.status(401).json({ error: "Invalid username or password." });
});

app.post("/api/admin/logout", (req, res) => {
  if (req.session) req.session.admin = false;
  res.json({ ok: true });
});

app.get("/admin", requireAdmin, (req, res) => {
  res.sendFile(path.join(__dirname, "public", "admin.html"));
});

// Helper: admin + DB-guard wrapper for JSON APIs.
function adminApi(handler) {
  return [requireAdmin, (req, res) => {
    if (!DB_ENABLED) return res.status(503).json({ error: "Database not configured." });
    Promise.resolve(handler(req, res)).catch(err => { console.error("admin api error:", err); res.status(500).json({ error: err.message }); });
  }];
}

app.get("/api/admin/stats", ...adminApi(async (req, res) => {
  res.json(await db.subscriberStats());
}));

app.get("/api/admin/subscribers", ...adminApi(async (req, res) => {
  const rows = await db.listSubscribers({ search: req.query.search || "", status: req.query.status || "" });
  res.json({ subscribers: rows });
}));

app.patch("/api/admin/subscribers/:id", ...adminApi(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const body = req.body || {};
  const patch = {};
  if (Array.isArray(body.areas)) patch.areas = body.areas.filter(a => ["policy", "reputation", "fraud"].includes(a));
  if (body.status === "active" || body.status === "unsubscribed") patch.status = body.status;
  if (body.prefs && typeof body.prefs === "object") {
    const p = {};
    if (Array.isArray(body.prefs.states)) p.states = body.prefs.states.filter(s => VALID_STATES.includes(s));
    if (Array.isArray(body.prefs.topics)) p.topics = body.prefs.topics.filter(t => VALID_TOPICS.includes(t));
    if (Array.isArray(body.prefs.brands)) p.brands = body.prefs.brands.filter(b => VALID_BRANDS.includes(b));
    if (["daily", "weekly", "monthly"].includes(body.prefs.frequency)) p.frequency = body.prefs.frequency;
    patch.prefs = p;
  }
  const row = await db.updateSubscriber(id, patch);
  if (!row) return res.status(404).json({ error: "Not found or nothing to update." });
  res.json({ subscriber: row });
}));

app.delete("/api/admin/subscribers/:id", ...adminApi(async (req, res) => {
  const row = await db.deleteSubscriber(parseInt(req.params.id, 10));
  if (!row) return res.status(404).json({ error: "Not found." });
  res.json({ ok: true, email: row.email });
}));

app.get("/api/admin/subscribers.csv", ...adminApi(async (req, res) => {
  const rows = await db.listSubscribers({});
  const esc = v => '"' + String(v == null ? "" : v).replace(/"/g, '""') + '"';
  const lines = ["email,areas,frequency,states,topics,brands,status,joined"];
  rows.forEach(r => {
    const prefs = r.prefs || {};
    lines.push([esc(r.email), esc((r.areas || []).join("|")),
      esc(prefs.frequency || "weekly"),
      esc((prefs.states || []).join("|") || "all"), esc((prefs.topics || []).join("|") || "all"),
      esc((prefs.brands || []).join("|") || "all"),
      esc(r.status), esc(new Date(r.created_at).toISOString())].join(","));
  });
  res.set("Content-Type", "text/csv");
  res.set("Content-Disposition", 'attachment; filename="piece-of-pi-subscribers.csv"');
  res.send(lines.join("\n"));
}));

// -- Law-change tracker (compliance calendar) --
app.get("/api/admin/laws", ...adminApi(async (req, res) => {
  const lawtracker = require("./lib/lawtracker");
  res.json({ laws: await lawtracker.calendar() });
}));

app.post("/api/admin/laws/sweep", ...adminApi(async (req, res) => {
  const lawtracker = require("./lib/lawtracker");
  const result = await lawtracker.sweep({ force: true, backfill: !!(req.body && req.body.backfill) });
  res.json({ ok: true, sweep: result });
}));

app.delete("/api/admin/laws/:id", ...adminApi(async (req, res) => {
  const row = await db.deleteLawChange(parseInt(req.params.id, 10));
  if (!row) return res.status(404).json({ error: "Not found." });
  res.json({ ok: true, title: row.title });
}));

// Human-readable compliance calendar: every enacted change being tracked, not
// just the ones due for an alert. Server-rendered so it needs no build step.
app.get("/admin/laws", requireAdmin, async (req, res) => {
  if (!DB_ENABLED) return res.status(503).send("Database not configured.");
  const lawtracker = require("./lib/lawtracker");
  let laws = [];
  try { laws = await lawtracker.calendar(); }
  catch (err) { return res.status(500).send("Could not load the calendar: " + err.message); }
  const e = v => String(v == null ? "" : v).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const badge = l => {
    const d = l.days_until;
    if (d === null || d === undefined) return '<span class="b gray">' + e(l.effective_text || "date TBD") + '</span>';
    if (d <= 0) return '<span class="b red">in effect</span>';
    if (d <= 30) return '<span class="b red">' + d + ' days</span>';
    if (d <= 60) return '<span class="b amber">' + d + ' days</span>';
    return '<span class="b blue">' + d + ' days</span>';
  };
  const rows = laws.map(l =>
    '<tr><td>' + badge(l) + '<div class="dim">' + e(l.effective_date || l.effective_text) + '</div></td>' +
    '<td><strong>' + e(l.jurisdiction) + '</strong><div class="dim">' + e(l.category) + '</div></td>' +
    '<td><a href="' + e(l.url) + '" target="_blank" rel="noopener">' + e(l.title) + '</a>' +
    '<div class="dim">' + e(l.summary) + '</div>' +
    (l.action ? '<div class="act">What to do: ' + e(l.action) + '</div>' : '') + '</td>' +
    '<td class="dim">' + e(l.citation || "") + '<div>' + e(l.source || "") + '</div>' +
    '<div>' + (l.verified ? "source-checked" : "unverified") + '</div>' +
    '<div' + (l.needs_better_source ? ' style="color:#a05a1c;"' : '') + '>' + e(l.source_tier_label || "") + '</div>' +
    '<div>alerted: ' + (l.first_seen ? "not yet" : e(l.stage)) + '</div></td></tr>').join("");
  const body = rows || '<tr><td colspan="4" class="dim">Nothing tracked yet. Run a backfill to seed the calendar.</td></tr>';
  res.set("Content-Type", "text/html").send(
    '<!DOCTYPE html><html><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1"><title>Labor law changes - Piece of Pi</title>' +
    '<style>body{font-family:Helvetica Neue,Arial,sans-serif;background:#f4e9ed;color:#2a0f18;margin:0;padding:28px 16px;}' +
    '.w{max-width:1080px;margin:auto;}h1{color:#c03060;font-size:22px;margin:0 0 4px;}' +
    'p.sub{color:#8a4055;font-size:13px;margin:0 0 18px;}' +
    'table{width:100%;border-collapse:collapse;background:#fff;border:1px solid #f1d6de;border-radius:14px;overflow:hidden;}' +
    'th,td{text-align:left;padding:12px 14px;border-bottom:1px solid #f7e4ea;font-size:13px;vertical-align:top;}' +
    'th{background:#fdf2f5;color:#8a4055;font-size:11px;text-transform:uppercase;letter-spacing:.5px;}' +
    'a{color:#c03060;}.dim{color:#b8788a;font-size:12px;margin-top:3px;}' +
    '.act{color:#c03060;font-size:12px;margin-top:4px;}' +
    '.b{display:inline-block;font-size:11px;font-weight:700;border-radius:9px;padding:2px 8px;}' +
    '.red{color:#fff;background:#b02040;}.amber{color:#a05a1c;background:#fbe3cf;}' +
    '.blue{color:#2a5ea8;background:#e9f0fa;}.gray{color:#6b6353;background:#f4f1ea;}' +
    '.bar{margin-bottom:14px;}button{background:#c03060;color:#fff;border:0;border-radius:9px;padding:8px 14px;font-size:13px;cursor:pointer;margin-right:6px;}' +
    'button.alt{background:#8a4055;}</style></head><body><div class="w">' +
    '<h1>Labor law changes and deadlines</h1>' +
    '<p class="sub">Enacted laws and final rules only, in the states we operate in plus federal. ' + laws.length +
    ' tracked. <a href="/admin">Back to admin</a></p>' +
    '<div class="bar"><button onclick="sweep(false)">Run sweep now</button>' +
    '<button class="alt" onclick="sweep(true)">Backfill (past year)</button>' +
    '<span id="msg" class="dim"></span></div>' +
    '<table><thead><tr><th>Effective</th><th>Where</th><th>Change</th><th>Source</th></tr></thead><tbody>' +
    body + '</tbody></table></div><script>' +
    'async function sweep(backfill){document.getElementById("msg").textContent="Running (a couple of minutes)...";' +
    'try{var r=await fetch("/api/admin/laws/sweep",{method:"POST",headers:{"Content-Type":"application/json"},' +
    'body:JSON.stringify({backfill:backfill})});var d=await r.json();' +
    'document.getElementById("msg").textContent=d.error?("Error: "+d.error):("Done - "+d.sweep.added+" new, "+d.sweep.updated+" refreshed.");' +
    'if(!d.error)setTimeout(function(){location.reload();},1200);}' +
    'catch(err){document.getElementById("msg").textContent="Error: "+err.message;}}' +
    '</script></body></html>');
});

app.get("/api/admin/sends", ...adminApi(async (req, res) => {
  res.json({ sends: await db.listSends(50) });
}));

app.get("/api/admin/sends/:id", ...adminApi(async (req, res) => {
  const send = await db.getSend(parseInt(req.params.id, 10));
  if (!send) return res.status(404).json({ error: "Not found." });
  res.json({ send });
}));

// Send an edition on demand. Body { only: "someone@x.com" } sends to just that
// subscriber - the way to see a real edition without mailing the whole network.
// Manual sends never burn a law-change milestone, so a test does not stop the
// scheduled edition from alerting on the same deadlines.
app.post("/api/admin/send", ...adminApi(async (req, res) => {
  const { runNewsletter } = require("./jobs/newsletter");
  const only = String((req.body && req.body.only) || "").toLowerCase().trim();
  if (only && !EMAIL_RE.test(only)) return res.status(400).json({ error: "\"only\" must be a valid email address." });
  const result = await runNewsletter({ trigger: "manual", only: only || undefined });
  res.json({ ok: true, only: only || "all subscribers", result });
}));

app.get("/api/admin/preview", requireAdmin, (req, res) => {
  const areas = String(req.query.areas || "policy,reputation,fraud").split(",").map(s => s.trim()).filter(Boolean);
  const { html } = renderEmail(
    { email: "preview@pieceofpi.app", areas, token: "preview" },
    SAMPLE_DIGESTS,
    { appUrl: process.env.APP_URL || "https://www.pieceofpi.app", dateStr: "Preview edition" }
  );
  res.set("Content-Type", "text/html").send(html);
});

// --- Auth gate: everything below requires a logged-in session ---
const PUBLIC_PATHS = new Set([
  "/login",
  "/favicon.ico",
  "/favicon.png",
  "/logo.png"
]);

app.use((req, res, next) => {
  if (PUBLIC_PATHS.has(req.path)) return next();
  if (req.session && req.session.authed) return next();
  if (req.path.startsWith("/api/")) {
    return res.status(401).json({ error: "Not authenticated" });
  }
  return res.redirect("/login");
});

// --- Protected app ---
app.use(express.static(path.join(__dirname, "public")));

// Compliance calendar for the dashboard. Reads the SAME stored calendar the
// newsletter sends from - no searching, no API spend, instant. It sits below
// the site auth gate rather than behind ADMIN_PASS on purpose: the people who
// have to meet these deadlines should not need the admin credential to look
// them up between Monday emails.
app.get("/api/laws", async (req, res) => {
  if (!DB_ENABLED) return res.status(503).json({ error: "Database not configured." });
  try {
    const lawtracker = require("./lib/lawtracker");
    res.json({ laws: await lawtracker.calendar() });
  } catch (err) {
    console.error("laws api error:", err);
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/briefing", async (req, res) => {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: "API key not configured on server." });
  }
  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "anthropic-beta": "web-search-2025-03-05"
      },
      body: JSON.stringify(req.body)
    });
    const data = await response.json();
    res.status(response.status).json(data);
  } catch (err) {
    console.error("Proxy error:", err);
    res.status(500).json({ error: err.message });
  }
});

// Manually trigger a newsletter send (logged-in admins only). Useful for testing
// without waiting for the cron. Runs async; check logs for results.
app.post("/api/newsletter/run", async (req, res) => {
  if (!DB_ENABLED) return res.status(503).json({ error: "Database not configured." });
  try {
    const { runNewsletter } = require("./jobs/newsletter");
    const result = await runNewsletter();
    res.json({ ok: true, result });
  } catch (err) {
    console.error("Manual newsletter run failed:", err);
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;

async function start() {
  if (DB_ENABLED) {
    try { await db.init(); console.log("DB ready."); }
    catch (err) { console.error("DB init failed (subscriptions disabled until fixed):", err.message); }
  } else {
    console.log("DATABASE_URL not set - newsletter subscriptions disabled.");
  }

  // Morning watchdog: every weekday at 12:15 UTC (~30 min after the 11:45 UTC
  // newsletter cron) verify today's run happened and email a status report.
  // Lives here on the always-on web service so it stays independent of the
  // cron it watches.
  if (DB_ENABLED && process.env.RESEND_API_KEY) {
    let lastWatchdogDay = "";
    setInterval(() => {
      const now = new Date();
      const day = now.toISOString().slice(0, 10);
      const dow = now.getUTCDay();
      if (dow >= 1 && dow <= 5 && now.getUTCHours() === 12 && now.getUTCMinutes() >= 15 && lastWatchdogDay !== day) {
        lastWatchdogDay = day;
        require("./jobs/watchdog").runWatchdog().catch(err => console.error("[watchdog] failed:", err.message));
      }
    }, 60 * 1000);
    console.log("Watchdog armed (weekdays 12:15 UTC).");
  }

  app.listen(PORT, () => console.log(`Running on port ${PORT}`));
}
start();
