# Policy Intelligence Briefing

Medicaid, home care, and community-based services monitoring dashboard. Pulls live web results across selected states and federal scope using the Anthropic API.

The dashboard is protected by a login. Set the username/password via the `AUTH_USER` and `AUTH_PASS` environment variables (see `.env.example`). Without a valid session, the page and the API both return to the login screen.

---

## Deploy to Railway (recommended — ~5 minutes)

1. Create a free account at railway.app
2. Click "New Project" → "Deploy from GitHub repo"
3. Push this folder to a GitHub repo and connect it, or use "Deploy from local" with the Railway CLI
4. In Railway, go to your project → Variables → add:
   - `ANTHROPIC_API_KEY` = your key from console.anthropic.com
   - `AUTH_USER` = the login username
   - `AUTH_PASS` = the login password
   - `SESSION_SECRET` = a long random string (signs login cookies)
5. Railway auto-detects Node.js and runs `npm start`
6. Click the generated URL — done

---

## Deploy to Render (alternative)

1. Create a free account at render.com
2. New → Web Service → connect your GitHub repo
3. Build command: `npm install`
4. Start command: `node server.js`
5. Add environment variable: `ANTHROPIC_API_KEY`
6. Deploy — you get a permanent URL

---

## Run locally

```bash
npm install
cp .env.example .env
# edit .env and add your ANTHROPIC_API_KEY
node server.js
# open http://localhost:3000
```

---

## Cost

Each briefing run costs roughly $0.01–0.03 in Anthropic API usage depending on how many states are selected. A daily run for one user costs under $1/month.

---

## Getting an Anthropic API key

1. Go to console.anthropic.com
2. Sign up or log in
3. API Keys → Create Key
4. Copy and paste into your deployment's environment variables

---

## Newsletter

People sign up at **`/subscribe`** (a public page, no login) and pick which areas
they want — Policy Intelligence, Reputation Watch, Medicaid Fraud. Every **Monday
& Thursday** a job generates each chosen area's digest once and emails everyone a
branded HTML briefing. Every email has a one-click unsubscribe link.

**Moving parts**

- **Database** — Postgres (`DATABASE_URL`) stores subscribers + preferences. On
  Railway, add the Postgres plugin and reference its `DATABASE_URL`.
- **Email** — Resend (`RESEND_API_KEY`, `FROM_EMAIL`). The sending domain must be
  verified in Resend (add the DKIM/SPF DNS records it gives you).
- **Schedule** — a Railway cron service runs `node jobs/newsletter.js` on
  `0 13 * * 1,4` (Mon & Thu, 13:00 UTC ≈ 9am ET).

**Test a send without waiting for the schedule**

- While logged in: `POST /api/newsletter/run` (e.g. from the browser console:
  `fetch('/api/newsletter/run',{method:'POST'}).then(r=>r.json()).then(console.log)`)
- Or locally: `npm run newsletter`

Results (sent / skipped / failed) are printed to the logs. Subscribers whose
chosen areas turned up nothing that edition are skipped rather than emailed an
empty briefing.
