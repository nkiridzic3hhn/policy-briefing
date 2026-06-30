const { Pool } = require("pg");

// Railway exposes the Postgres connection string as DATABASE_URL.
// Internal (private-network) connections don't need SSL; set DATABASE_SSL=true
// only if you connect over the public proxy.
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === "true" ? { rejectUnauthorized: false } : false
});

// Create the subscribers table on first run.
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
}

// Insert a new subscriber or update an existing one's areas (re-activating if needed).
async function upsertSubscriber(email, areas, token) {
  const res = await pool.query(
    `INSERT INTO subscribers (email, areas, token, status)
     VALUES ($1, $2::jsonb, $3, 'active')
     ON CONFLICT (email) DO UPDATE
       SET areas = $2::jsonb, status = 'active', updated_at = now()
     RETURNING id, email, areas, token, status`,
    [email.toLowerCase().trim(), JSON.stringify(areas), token]
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
    `SELECT email, areas, token FROM subscribers WHERE status = 'active' ORDER BY created_at`
  );
  return res.rows;
}

module.exports = { pool, init, upsertSubscriber, unsubscribeByToken, getActiveSubscribers };
