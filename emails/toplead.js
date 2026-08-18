// Which single item leads the email (the "one thing to know" box) and supplies
// the subject line.
//
// Lives in its own file because the ordering is a judgement call that changes
// more often than the rest of the renderer: a dated legal obligation outranks
// news, and an edition made only of law changes must still lead with something
// rather than falling back to a generic "your snapshot" subject.
function pickTopStory(digests, areas) {
  const has = a => areas.includes(a);
  const due = has("policy") ? (digests.laws || []) : [];
  // The imminent-deadline check runs over the WHOLE calendar, not just what is
  // new. A deadline nine days out still leads the email even if the reader was
  // told about it last week - urgency beats novelty when someone can miss a date.
  const all = has("policy") ? (digests.lawsCalendar || []) : [];
  const laws = all.length ? all : due;

  const soon = laws.find(i => i.days_until !== null && i.days_until !== undefined && i.days_until <= 30);
  if (soon) return { item: soon, label: "law" };

  if (has("fraud")) {
    const f = (digests.fraud || []).find(i => (i.severity || "").toLowerCase() === "high") || (digests.fraud || [])[0];
    if (f) return { item: f, label: "fraud" };
  }
  if (has("policy")) {
    const p = (digests.policy || []).find(i => (i.urgency || "").toLowerCase() === "high") || (digests.policy || [])[0];
    if (p) return { item: p, label: "policy" };
  }
  if (has("reputation")) {
    const r = (digests.reputation || []).find(i => ["negative", "review"].includes((i.sentiment || "").toLowerCase()));
    if (r) return { item: r, label: "reputation" };
  }

  // Nothing but law changes, none of them imminent (a compliance-only reader
  // such as HR). Prefer something new to lead with; otherwise the nearest
  // deadline on the calendar still beats an empty lead.
  if (due.length) return { item: due[0], label: "law" };
  if (laws.length) return { item: laws[0], label: "law" };
  return null;
}

module.exports = { pickTopStory };
