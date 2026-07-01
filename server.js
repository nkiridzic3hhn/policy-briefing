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

// --- Newsletter signup (open routes — no login required) ---
const VALID_AREAS = ["policy", "reputation", "fraud"];

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

  try {
    const token = crypto.randomBytes(24).toString("hex");
    const sub = await db.upsertSubscriber(email, areas, token);
    // Best-effort welcome email; never block signup on it.
    if (process.env.RESEND_API_KEY) {
      const appUrl = process.env.APP_URL || "https://www.pieceofpi.app";
      const unsubUrl = `${appUrl.replace(/\/$/, "")}/unsubscribe?token=${encodeURIComponent(sub.token)}`;
      sendEmail({
        to: email,
        subject: "You're subscribed to Piece of Pi",
        html: `<div style="font-family:Arial,sans-serif;max-width:520px;margin:auto;color:#2a0f18;">
          <img src="${appUrl}/logo.png" alt="Piece of Pi" height="44" style="height:44px;margin-bottom:12px;">
          <h2 style="color:#c03060;">You're subscribed 🥧</h2>
          <p>You'll get your Piece of Pi briefing every <strong>Monday &amp; Thursday</strong>, covering: <strong>${areas.join(", ")}</strong>.</p>
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
  const lines = ["email,areas,status,joined"];
  rows.forEach(r => lines.push([esc(r.email), esc((r.areas || []).join("|")), esc(r.status), esc(new Date(r.created_at).toISOString())].join(",")));
  res.set("Content-Type", "text/csv");
  res.set("Content-Disposition", 'attachment; filename="piece-of-pi-subscribers.csv"');
  res.send(lines.join("\n"));
}));

app.get("/api/admin/sends", ...adminApi(async (req, res) => {
  res.json({ sends: await db.listSends(50) });
}));

app.get("/api/admin/sends/:id", ...adminApi(async (req, res) => {
  const send = await db.getSend(parseInt(req.params.id, 10));
  if (!send) return res.status(404).json({ error: "Not found." });
  res.json({ send });
}));

app.post("/api/admin/send", ...adminApi(async (req, res) => {
  const { runNewsletter } = require("./jobs/newsletter");
  const result = await runNewsletter({ trigger: "manual" });
  res.json({ ok: true, result });
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
// without waiting for the Monday/Thursday cron. Runs async; check logs for results.
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
    console.log("DATABASE_URL not set — newsletter subscriptions disabled.");
  }
  app.listen(PORT, () => console.log(`Running on port ${PORT}`));
}
start();
