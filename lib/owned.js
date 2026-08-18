// Tells our own content apart from someone else's mention of us.
//
// Reputation Watch is supposed to show what THIRD PARTIES said. Our own posts
// were already read by us the day we published them, so they are noise here.
// The editor prompt has always asked Claude to drop them, but a prompt is a
// request, not a rule - self-posted results kept slipping into the email. This
// module is the rule: it runs before and after the editor and never asks.
//
// Two ways an owned property is recognised, most confident first:
//   1. the hand-maintained EXCLUDE list in lib/watchlist.js
//   2. a slug match between the URL and the brand the item is filed under -
//      this is what catches the agency sites and social accounts nobody has
//      gotten around to adding to that list (most of the 25 brands)
//
// Job boards are handled separately: a third-party domain carrying a posting
// we wrote ourselves. Press releases and directory/review profiles are NOT
// filtered - a paid wire story still reads as coverage, and a Yelp or BBB page
// is where real reviews live.

const { WATCHLIST, EXCLUDE } = require("./watchlist");

// Corporate filler that a domain may carry but a brand name may not, or the
// other way round: "Agility Home Care" vs agilityhomecare.com vs agility.com.
const FILLER = ["homecare", "healthcare", "homehealth", "adultdaycare", "daycare",
  "care", "health", "home", "services", "service", "nursing", "medical",
  "agency", "group", "inc", "llc", "co", "official", "us", "usa", "online"];

const SOCIAL = ["facebook.com", "fb.com", "instagram.com", "linkedin.com", "tiktok.com",
  "youtube.com", "x.com", "twitter.com", "threads.net", "pinterest.com"];

// Boards where the "mention" is a posting we placed ourselves.
const JOB_BOARDS = ["indeed.com", "ziprecruiter.com", "glassdoor.com", "snagajob.com",
  "simplyhired.com", "monster.com", "careerbuilder.com", "talent.com", "jooble.org",
  "jobcase.com", "myworkdayjobs.com", "lever.co", "greenhouse.io", "workable.com",
  "smartrecruiters.com", "applicantpro.com", "paycomonline.com", "adp.com",
  "jobs.net", "joblist.com", "recruiter.com", "getwork.com", "salary.com"];

function slug(s) { return String(s || "").toLowerCase().replace(/[^a-z0-9]/g, ""); }

function hostOf(url) {
  try { return new URL(String(url)).hostname.toLowerCase().replace(/^www\./, ""); }
  catch { return ""; }
}

function pathOf(url) {
  try { return new URL(String(url)).pathname.toLowerCase(); }
  catch { return ""; }
}

// The registrable label: "agilityhomecare" out of "www.agilityhomecare.com".
// Handles two-part suffixes (.co.uk) well enough for our purposes.
function domainLabel(host) {
  const parts = host.split(".").filter(Boolean);
  if (parts.length < 2) return parts[0] || "";
  const last2 = parts.slice(-2).join(".");
  return /^(co|com|org|net|gov|ac)\.[a-z]{2}$/.test(last2) ? (parts[parts.length - 3] || "") : parts[parts.length - 2];
}

function stripFiller(s) {
  let out = s, changed = true;
  while (changed) {
    changed = false;
    for (const f of FILLER) {
      if (out.length > f.length && out.endsWith(f)) { out = out.slice(0, -f.length); changed = true; }
    }
  }
  return out;
}

// Is this URL fragment the same identity as this brand name? Exact first, then
// allowing either side to carry extra corporate filler the other one drops.
// The 6-character floor keeps short generic stems ("all", "care") from matching
// half the web.
function sameIdentity(fragment, brandName) {
  const a = slug(fragment), b = slug(brandName);
  if (!a || !b) return false;
  if (a === b) return true;
  if (a.length >= 6 && b.startsWith(a) && stripFiller(b) === stripFiller(a)) return true;
  if (b.length >= 6 && a.startsWith(b) && stripFiller(a) === stripFiller(b)) return true;
  return false;
}

// The account handle out of a social URL, whatever shape that platform uses.
function socialHandle(host, path) {
  const segs = path.split("/").filter(Boolean).map(s => s.replace(/^@/, ""));
  if (!segs.length) return "";
  if (host.includes("linkedin.com")) {
    const i = segs.findIndex(s => ["company", "in", "school", "showcase"].includes(s));
    return i >= 0 ? (segs[i + 1] || "") : "";
  }
  if (host.includes("youtube.com")) {
    if (["c", "user", "channel"].includes(segs[0])) return segs[1] || "";
    return segs[0];
  }
  if (["pages", "profile.php", "people", "p"].includes(segs[0])) return segs[1] || "";
  return segs[0];
}

// Owned property = on the explicit list, or a domain/social handle that IS the
// brand. brandName narrows rule 2; without it, every watchlist name is tried.
function isOwnedProperty(url, brandName) {
  const host = hostOf(url);
  if (!host) return false;
  const full = (host + pathOf(url)).replace(/\/$/, "");
  for (const ex of EXCLUDE) {
    const e = String(ex).toLowerCase().replace(/^www\./, "");
    if (full === e || full.startsWith(e + "/") || host === e || host.endsWith("." + e)) return true;
  }

  // An item filed under "A + B" involves several brands; any of them owning the
  // URL makes it ours.
  const names = brandName
    ? String(brandName).split("+").map(s => s.trim()).filter(Boolean)
    : WATCHLIST.map(w => w.name);

  const isSocial = SOCIAL.some(s => host === s || host.endsWith("." + s));
  const fragment = isSocial ? socialHandle(host, pathOf(url)) : domainLabel(host);
  if (!fragment) return false;
  // On a social platform an empty/greedy path must not match the whole network.
  if (isSocial && ["watch", "posts", "share", "reel", "video", "shorts", "results", "search", "hashtag", "feed", "jobs"].includes(fragment)) return false;
  return names.some(n => sameIdentity(fragment, n));
}

function isJobPosting(url, title) {
  const host = hostOf(url);
  if (!host) return false;
  if (JOB_BOARDS.some(b => host === b || host.endsWith("." + b))) return true;
  const path = pathOf(url);
  if (host.includes("linkedin.com") && path.startsWith("/jobs")) return true;
  // A careers subdomain or a hiring page on any site is still our own posting.
  if (/^(careers?|jobs|apply|hiring)\./.test(host)) return true;
  if (/\b(hiring|now hiring|apply now|job opening|caregiver wanted)\b/i.test(String(title || ""))) return true;
  return false;
}

// Reason this URL should not appear in Reputation Watch, or "" to keep it.
function selfPostedReason(url, brandName, title) {
  if (isOwnedProperty(url, brandName)) return "own property";
  if (isJobPosting(url, title)) return "job posting";
  return "";
}

// Drop our own content from a set of digest items, logging every removal so a
// wrong drop is findable in the deploy logs rather than silent.
function filterSelfPosted(items, label = "reputation") {
  const kept = [];
  let dropped = 0;
  for (const item of items || []) {
    const why = selfPostedReason(item.url, item.agency, item.title);
    if (why) {
      dropped++;
      console.log(`[${label}] dropped self-posted (${why}): ${item.agency || "?"} - "${item.title}" - ${item.url}`);
      continue;
    }
    kept.push(item);
  }
  return { items: kept, dropped };
}

module.exports = { isOwnedProperty, isJobPosting, selfPostedReason, filterSelfPosted, sameIdentity, slug, hostOf };
