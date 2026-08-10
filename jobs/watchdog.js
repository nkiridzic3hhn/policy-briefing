// Morning watchdog: after the scheduled newsletter window, verify today's cron
// run happened and went cleanly, then email a green/red status report. Runs
// from the web service (see server.js) so it stays independent of the
// newsletter cron it is checking on.
const db = require("../lib/db");
const { sendEmail } = require("../lib/email");

const REPORT_TO = process.env.WATCHDOG_EMAIL || "nick@staffhero.co";

async function runWatchdog() {
  const today = new Date().toISOString().slice(0, 10);
  const res = await db.pool.query(
    `SELECT * FROM sends WHERE trigger = 'cron' AND created_at >= $1::date ORDER BY id DESC LIMIT 1`,
    [today]
  );
  const run = res.rows[0] || null;
  let recips = [];
  if (run) {
    const r = await db.pool.query(
      `SELECT email, status, error FROM send_recipients WHERE send_id = $1 ORDER BY id`,
      [run.id]
    );
    recips = r.rows;
  }

  const problems = [];
  if (!run) {
    problems.push("No scheduled run found today. The newsletter cron may not have fired.");
  } else {
    if (run.status !== "done") problems.push(`Run status is \"${run.status}\"${run.error ? " — " + run.error : ""}.`);
    if (run.failed > 0) problems.push(`${run.failed} email(s) failed to send.`);
  }
  const ok = !problems.length;

  const G = "#1d7a54", R = "#b02040", MUTED = "#8a4055";
  const counts = run ? Object.entries(run.item_counts || {}).map(([k, v]) => `${k}: ${v}`).join(" · ") : "";
  const rows = recips.map(x =>
    `<tr><td style="padding:6px 10px;border-bottom:1px solid #f1d6de;">${x.email}</td>` +
    `<td style="padding:6px 10px;border-bottom:1px solid #f1d6de;color:${x.status === "sent" ? G : x.status === "failed" ? R : MUTED};font-weight:600;">${x.status}</td>` +
    `<td style="padding:6px 10px;border-bottom:1px solid #f1d6de;color:${MUTED};font-size:12px;">${x.error || ""}</td></tr>`
  ).join("");

  const subject = ok
    ? `✅ Piece of Pi ran clean — sent ${run.sent}, skipped ${run.skipped}`
    : `🚨 Piece of Pi needs a look — ${problems[0]}`;

  const html = `<div style="font-family:Arial,sans-serif;max-width:560px;margin:auto;color:#2a0f18;">
    <h2 style="color:${ok ? G : R};">${ok ? "✅ All good this morning" : "🚨 Something needs a look"}</h2>
    ${problems.length ? `<ul style="color:${R};">${problems.map(p => `<li>${p}</li>`).join("")}</ul>` : ""}
    ${run ? `<p style="color:${MUTED};font-size:13px;">Run #${run.id} at ${new Date(run.created_at).toLocaleString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })} ET · ${run.subscribers} due · sent ${run.sent} · skipped ${run.skipped} · failed ${run.failed}${counts ? "<br>Scan items — " + counts : ""}</p>` : ""}
    ${rows ? `<table style="border-collapse:collapse;width:100%;font-size:13px;">${rows}</table>` : ""}
    <p style="font-size:11px;color:#b8788a;margin-top:14px;">Piece of Pi watchdog · checks every weekday morning after the send window</p>
  </div>`;

  await sendEmail({ to: REPORT_TO, subject, html });
  console.log(`[watchdog] report sent to ${REPORT_TO} (${ok ? "ok" : "PROBLEMS: " + problems.join(" | ")})`);
  return { ok, problems, runId: run ? run.id : null };
}

module.exports = { runWatchdog };
