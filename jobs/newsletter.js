// Newsletter send job. Run on a schedule (Railway cron: weekday mornings) or
// manually via `npm run newsletter` or the key-protected /api/newsletter/run-key.
//
// Frequency-aware: each subscriber has prefs.frequency of "daily" (weekday
// mornings, 1-day lookback), "weekly" (Mondays, 7-day lookback — the default),
// or "monthly" (first Monday of the month, 30-day lookback). On each run, only
// subscribers whose cadence is due get an email; digests are generated once per
// lookback needed and then filtered per subscriber.

const db = require("../lib/db");
const { generateDigests } = require("../lib/briefings");
const { renderEmail } = require("../emails/render");
const { sendEmail } = require("../lib/email");

const FREQ_DAYS = { daily: 1, weekly: 7, monthly: 30 };
const FREQ_LABEL = { daily: "Daily", weekly: "Weekly", monthly: "Monthly" };

function todayLabel() {
  return new Date().toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" });
}

function subscriberFrequency(sub) {
  const f = sub.prefs && sub.prefs.frequency;
  return FREQ_DAYS[f] ? f : "weekly";
}

// Drop items a subscriber has already been sent in a prior edition. Matching
// is by normalized URL — the same story from the same source never repeats.
function normUrl(u) { return String(u || "").trim().replace(/\/$/, "").toLowerCase(); }
function dropSeen(digests, seenSet) {
  if (!seenSet || !seenSet.size) return digests;
  const filter = list => (list || []).filter(i => !i.url || !seenSet.has(normUrl(i.url)));
  return {
    ...digests,
    policy: filter(digests.policy),
    fraud: filter(digests.fraud),
    reputation: filter(digests.reputation)
  };
}

// Which frequencies get an edition today (based on UTC date, cron runs 13:00 UTC).
function dueFrequencies(now = new Date()) {
  const dow = now.getUTCDay(); // 0=Sun ... 6=Sat
  const due = [];
  if (dow >= 1 && dow <= 5) due.push("daily");
  if (dow === 1) {
    due.push("weekly");
    if (now.getUTCDate() <= 7) due.push("monthly"); // first Monday of the month
  }
  return due;
}

async function runNewsletter(opts = {}) {
  const trigger = opts.trigger === "cron" ? "cron" : "manual";
  // Dedupe (never repeat a story) always applies to cron; manual runs can opt
  // in with opts.dedupe to behave exactly like a scheduled send.
  const dedupe = trigger === "cron" || opts.dedupe === true;
  await db.init();
  const sendId = await db.createSend(trigger);

  try {
    const all = await db.getActiveSubscribers();
    // Cron respects each subscriber's cadence; manual runs send everyone their
    // own edition regardless of day (useful for testing and ad-hoc sends).
    const due = trigger === "cron" ? dueFrequencies() : ["daily", "weekly", "monthly"];
    let subscribers = all.filter(s => due.includes(subscriberFrequency(s)));
    // opts.only: restrict a run to a single subscriber (targeted test sends).
    if (opts.only) {
      const target = String(opts.only).toLowerCase().trim();
      subscribers = subscribers.filter(s => s.email === target);
    }

    if (!subscribers.length) {
      console.log(`[newsletter] No subscribers due today (due cadences: ${due.join(", ") || "none"}).`);
      await db.finalizeSend(sendId, { areas: [], itemCounts: {}, subscribers: 0, sent: 0, skipped: 0, failed: 0, status: "done" });
      return { sendId, sent: 0, skipped: 0, failed: 0, subscribers: 0 };
    }

    // Union of areas and set of lookbacks actually needed.
    const neededAreas = new Set();
    const neededDays = new Set();
    subscribers.forEach(s => {
      (s.areas || []).forEach(a => neededAreas.add(a));
      neededDays.add(FREQ_DAYS[subscriberFrequency(s)]);
    });
    console.log(`[newsletter] ${subscribers.length} subscriber(s) due; areas: ${Array.from(neededAreas).join(", ")}; lookbacks: ${Array.from(neededDays).join(",")}d`);

    // Generate digests once per lookback.
    const digestsByDays = {};
    for (const days of neededDays) {
      digestsByDays[days] = await generateDigests(Array.from(neededAreas), days);
    }

    const itemCounts = {};
    Object.entries(digestsByDays).forEach(([days, d]) => {
      Object.keys(d).forEach(k => {
        if (Array.isArray(d[k])) itemCounts[`${k}@${days}d`] = d[k].length;
      });
    });
    console.log(`[newsletter] digest items — ${Object.entries(itemCounts).map(([k, v]) => `${k}:${v}`).join(" ")}`);

    const appUrl = process.env.APP_URL || "https://www.pieceofpi.app";
    const dateStr = todayLabel();

    let sent = 0, skipped = 0, failed = 0;
    for (const sub of subscribers) {
      const freq = subscriberFrequency(sub);
      let digests = digestsByDays[FREQ_DAYS[freq]];

      // Dedupe runs never repeat a story someone already got: drop anything
      // sent to this subscriber in the last 30 days. Plain manual runs skip
      // the filter so test sends always show full content.
      if (dedupe) {
        try {
          const seen = new Set((await db.getSentUrls(sub.email, 30)).map(normUrl));
          digests = dropSeen(digests, seen);
        } catch (err) {
          console.error(`[newsletter] dedupe lookup failed for ${sub.email} (sending unfiltered): ${err.message}`);
        }
      }

      const { subject, html, hasContent, urls } = renderEmail(sub, digests, { appUrl, dateStr, edition: FREQ_LABEL[freq] });
      if (!hasContent) {
        skipped++;
        await db.logRecipient(sendId, sub.email, "skipped", "nothing new for their choices this edition");
        console.log(`[newsletter] skip ${sub.email} (${freq}; nothing new matched their choices)`);
        continue;
      }
      try {
        await sendEmail({ to: sub.email, subject, html });
        sent++;
        await db.logRecipient(sendId, sub.email, "sent", null);
        if (dedupe && urls && urls.length) {
          try { await db.logSentItems(sub.email, urls.map(normUrl)); }
          catch (err) { console.error(`[newsletter] logSentItems failed: ${err.message}`); }
        }
        console.log(`[newsletter] sent ${sub.email} (${freq}; ${urls ? urls.length : 0} items)`);
      } catch (err) {
        failed++;
        await db.logRecipient(sendId, sub.email, "failed", err.message);
        console.error(`[newsletter] FAILED ${sub.email}: ${err.message}`);
      }
    }

    await db.finalizeSend(sendId, {
      areas: Array.from(neededAreas), itemCounts, subscribers: subscribers.length,
      sent, skipped, failed, status: "done"
    });
    console.log(`[newsletter] done — sent:${sent} skipped:${skipped} failed:${failed}`);
    return { sendId, sent, skipped, failed, subscribers: subscribers.length };
  } catch (err) {
    console.error("[newsletter] run failed:", err.message);
    await db.finalizeSend(sendId, { status: "error", error: err.message }).catch(() => {});
    throw err;
  }
}

module.exports = { runNewsletter };

// Allow running directly: `node jobs/newsletter.js`
if (require.main === module) {
  runNewsletter({ trigger: "cron" })
    .then(() => db.pool.end())
    .then(() => process.exit(0))
    .catch(err => {
      console.error("[newsletter] fatal:", err);
      process.exit(1);
    });
}
