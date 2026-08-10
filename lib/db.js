const { Pool } = require("pg");

// Railway exposes the Postgres connection string as DATABASE_URL.
// Internal (private-network) connections don't need SSL; set DATABASE_SSL=true
// only if you connect over the public proxy.
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === "true" ? { rejectUnauthorized: false } : false
});

// Create tables on first run.
async function init() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS subscribers (
      id          SERIAL PRIMARY KEY,
      email       TEXT UNIQUE NOT NULL,
      areas       JSONB NOT NULL DEFAULT '[]',
      token       TEXT UNIQUE NOT NULL,
      status      TEXT NOT NULL DEFAULT 'active',
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  // Per-subscriber personalization: { states: [...], topics: [...] }.
  // Empty arrays (or missing keys) mean "everything".
  await pool.query(`ALTER TABLE subscribers ADD COLUMN IF NOT EXISTS prefs JSONB NOT NULL DEFAULT '{}'`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS sends (
      id           SERIAL PRIMARY KEY,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
      trigger      TEXT NOT NULL DEFAULT 'manual',
      status       TEXT NOT NULL DEFAULT 'running',
      areas        JSONB NOT NULL DEFAULT '[]',
      item_counts  JSONB NOT NULL DEFAULT '{}',
      subscribers  INT NOT NULL DEFAULT 0,
      sent         INT NOT NULL DEFAULT 0,
      skipped      INT NOT NULL DEFAULT 0,
      failed       INT NOT NULL DEFAULT 0,
      error        TEXT
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS send_recipients (
      id         SERIAL PRIMARY KEY,
      send_id    INT NOT NULL REFERENCES sends(id) ON DELETE CASCADE,
      email      TEXT NOT NULL,
      status     TEXT NOT NULL,
      error      TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  // Per-subscriber memory of stories already emailed, so consecutive editions
  // (especially daily ones) never repeat an item. Rows expire via pruning.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS sent_items (
      id       SERIAL PRIMARY KEY,
      email    TEXT NOT NULL,
      url      TEXT NOT NULL,
      sent_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS sent_items_email_idx ON sent_items (email, sent_at)`);
}

// Insert a new subscriber or update an existing one's choices (re-activating if needed).
async function upsertSubscriber(email, areas, token, prefs) {
  const res = await pool.query(
    `INSERT INTO subscribers (email, areas, token, status, prefs)
     VALUES ($1, $2::jsonb, $3, 'active', $4::jsonb)
     ON CONFLICT (email) DO UPDATE
       SET areas = $2::jsonb, prefs = $4::jsonb, status = 'active', updated_at = now()
     RETURNING id, email, areas, prefs, token, status`,
    [email.toLowerCase().trim(), JSON.stringify(areas), token, JSON.stringify(prefs || {})]
  );
  return res.rows[0];
}

async function unsubscribeByToken(token) {
  const res = await pool.query(
    `UPDATE subscribers SET status = 'unsubscribed', updated_at = now()
     WHERE token = $1 RETURNING email`,
    [token]
  );
  return res.rows[0] || null;
}

async function getActiveSubscribers() {
  const res = await pool.query(
    `SELECT email, areas, prefs, token FROM subscribers WHERE status = 'active' ORDER BY created_at`
  );
  return res.rows;
}

// ── Admin: subscriber management ──
async function listSubscribers({ search = "", status = "" } = {}) {
  const clauses = [];
  const params = [];
  if (search) { params.push(`%${search.toLowerCase()}%`); clauses.push(`LOWER(email) LIKE $${params.length}`); }
  if (status) { params.push(status); clauses.push(`status = $${params.length}`); }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const res = await pool.query(
    `SELECT id, email, areas, prefs, status, created_at, updated_at FROM subscribers ${where} ORDER BY created_at DESC`,
    params
  );
  return res.rows;
}

async function subscriberStats() {
  const res = await pool.query(`
    SELECT
      COUNT(*)                                             AS total,
      COUNT(*) FILTER (WHERE status = 'active')            AS active,
      COUNT(*) FILTER (WHERE status = 'unsubscribed')      AS unsubscribed,
      COUNT(*) FILTER (WHERE status = 'active' AND areas ? 'policy')     AS policy,
      COUNT(*) FILTER (WHERE status = 'active' AND areas ? 'reputation') AS reputation,
      COUNT(*) FILTER (WHERE status = 'active' AND areas ? 'fraud')      AS fraud
    FROM subscribers
  `);
  return res.rows[0];
}

async function updateSubscriber(id, { areas, status, prefs }) {
  const sets = [];
  const params = [];
  if (Array.isArray(areas)) { params.push(JSON.stringify(areas)); sets.push(`areas = $${params.length}::jsonb`); }
  if (status)               { params.push(status);                sets.push(`status = $${params.length}`); }
  if (prefs && typeof prefs === "object") { params.push(JSON.stringify(prefs)); sets.push(`prefs = $${params.length}::jsonb`); }
  if (!sets.length) return null;
  params.push(id);
  const res = await pool.query(
    `UPDATE subscribers SET ${sets.join(", ")}, updated_at = now() WHERE id = $${params.length}
     RETURNING id, email, areas, prefs, status, created_at, updated_at`,
    params
  );
  return res.rows[0] || null;
}

async function deleteSubscriber(id) {
  const res = await pool.query(`DELETE FROM subscribers WHERE id = $1 RETURNING email`, [id]);
  return res.rows[0] || null;
}

// ── Send history ──
async function createSend(trigger) {
  const res = await pool.query(
    `INSERT INTO sends (trigger, status) VALUES ($1, 'running') RETURNING id`,
    [trigger === "cron" ? "cron" : "manual"]
  );
  return res.rows[0].id;
}

async function logRecipient(sendId, email, status, error) {
  await pool.query(
    `INSERT INTO send_recipients (send_id, email, status, error) VALUES ($1, $2, $3, $4)`,
    [sendId, email, status, error || null]
  );
}

async function finalizeSend(sendId, { areas, itemCounts, subscribers, sent, skipped, failed, status, error }) {
  await pool.query(
    `UPDATE sends SET areas = $2::jsonb, item_counts = $3::jsonb, subscribers = $4,
       sent = $5, skipped = $6, failed = $7, status = $8, error = $9 WHERE id = $1`,
    [sendId, JSON.stringify(areas || []), JSON.stringify(itemCounts || {}),
     subscribers || 0, sent || 0, skipped || 0, failed || 0, status || "done", error || null]
  );
}

async function listSends(limit = 50) {
  const res = await pool.query(
    `SELECT id, created_at, trigger, status, areas, item_counts, subscribers, sent, skipped, failed, error
     FROM sends ORDER BY created_at DESC LIMIT $1`,
    [limit]
  );
  return res.rows;
}

async function getSend(id) {
  const s = await pool.query(`SELECT * FROM sends WHERE id = $1`, [id]);
  if (!s.rows[0]) return null;
  const r = await pool.query(
    `SELECT email, status, error, created_at FROM send_recipients WHERE send_id = $1 ORDER BY id`,
    [id]
  );
  return { ...s.rows[0], recipients: r.rows };
}

// ── Sent-item memory (dedupe across editions) ──
async function getSentUrls(email, days = 30) {
  const res = await pool.query(
    `SELECT DISTINCT url FROM sent_items WHERE email = $1 AND sent_at > now() - ($2 || ' days')::interval`,
    [email.toLowerCase(), String(days)]
  );
  return res.rows.map(r => r.url);
}

async function logSentItems(email, urls) {
  if (!urls || !urls.length) return;
  const values = urls.map((_, i) => `($1, $${i + 2})`).join(", ");
  await pool.query(`INSERT INTO sent_items (email, url) VALUES ${values}`, [email.toLowerCase(), ...urls]);
  // Opportunistic prune so the table never grows unbounded.
  await pool.query(`DELETE FROM sent_items WHERE sent_at < now() - interval '60 days'`);
}

module.exports = {
  pool, init, upsertSubscriber, unsubscribeByToken, getActiveSubscribers,
  listSubscribers, subscriberStats, updateSubscriber, deleteSubscriber,
  createSend, logRecipient, finalizeSend, listSends, getSend,
  getSentUrls, logSentItems
};
