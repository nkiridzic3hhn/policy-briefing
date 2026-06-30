// Newsletter send job. Run on a schedule (Railway cron: Mon & Thu) or manually
// via `npm run newsletter` or the protected /api/newsletter/run endpoint.
//
// Strategy: generate each area's digest ONCE for the union of areas any active
// subscriber wants, then assemble + send a personalized email per subscriber.

const db = require("../lib/db");
const { generateDigests } = require("../lib/briefings");
const { renderEmail } = require("../emails/render");
const { sendEmail } = require("../lib/email");

function todayLabel() {
  return new Date().toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" });
}

async function runNewsletter() {
  await db.init();
  const subscribers = await db.getActiveSubscribers();
  if (!subscribers.length) {
    console.log("[newsletter] No active subscribers. Nothing to send.");
    return { sent: 0, skipped: 0, failed: 0, subscribers: 0 };
  }

  // Union of areas across all subscribers — generate only what's needed.
  const neededAreas = new Set();
  subscribers.forEach(s => (s.areas || []).forEach(a => neededAreas.add(a)));
  console.log(`[newsletter] ${subscribers.length} subscriber(s); generating digests for: ${Array.from(neededAreas).join(", ") || "none"}`);

  const digests = await generateDigests(Array.from(neededAreas));
  const counts = Object.keys(digests).map(k => `${k}:${(digests[k] || []).length}`).join(" ");
  console.log(`[newsletter] digest items — ${counts}`);

  const appUrl = process.env.APP_URL || "https://www.pieceofpi.app";
  const dateStr = todayLabel();

  let sent = 0, skipped = 0, failed = 0;
  for (const sub of subscribers) {
    const { subject, html, hasContent } = renderEmail(sub, digests, { appUrl, dateStr });
    if (!hasContent) {
      skipped++;
      console.log(`[newsletter] skip ${sub.email} (no items in chosen areas)`);
      continue;
    }
    try {
      await sendEmail({ to: sub.email, subject, html });
      sent++;
      console.log(`[newsletter] sent ${sub.email}`);
    } catch (err) {
      failed++;
      console.error(`[newsletter] FAILED ${sub.email}: ${err.message}`);
    }
  }

  console.log(`[newsletter] done — sent:${sent} skipped:${skipped} failed:${failed}`);
  return { sent, skipped, failed, subscribers: subscribers.length };
}

module.exports = { runNewsletter };

// Allow running directly: `node jobs/newsletter.js`
if (require.main === module) {
  runNewsletter()
    .then(() => db.pool.end())
    .then(() => process.exit(0))
    .catch(err => {
      console.error("[newsletter] fatal:", err);
      process.exit(1);
    });
}
