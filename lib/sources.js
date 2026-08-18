// How authoritative is the page a law change came from?
//
// The verify pass already proves a source page says what the summary claims.
// It says nothing about WHO is saying it - which is how a federal Medicaid rule
// ended up on the calendar cited to another home care agency's blog. The claim
// was true; the citation was not something you would put in front of leadership.
//
// Four tiers, most authoritative first:
//   1 official  - the government that made the rule (any .gov, plus a few
//                 official non-.gov publishers)
//   2 legal     - law firm client alerts and legal publishers; written by
//                 lawyers for compliance audiences, and they cite the primary
//   3 press     - trade and general news
//   4 unranked  - everything else, including competitor and vendor blogs
//
// Tier is derived from the URL on read, never stored, so re-tiering an old
// record is a code change rather than a migration.

// Official publishers that are not .gov domains.
const OFFICIAL_HOSTS = [
  "federalregister.gov", "govinfo.gov", "ecfr.gov", "congress.gov", "regulations.gov",
  "supremecourt.gov", "uscourts.gov", "ncsl.org", "medicaid.gov"
];

// Law firms and legal publishers - they write for compliance officers and cite
// the underlying bill or rule, which makes them a usable second-best.
const LEGAL_HOSTS = [
  "dlapiper.com", "littler.com", "jacksonlewis.com", "ogletree.com", "seyfarth.com",
  "fisherphillips.com", "morganlewis.com", "proskauer.com", "sheppardmullin.com",
  "squirepattonboggs.com", "employmentlawworldview.com", "natlawreview.com",
  "jdsupra.com", "lexology.com", "law360.com", "bloomberglaw.com", "shrm.org",
  "hklaw.com", "bakerdonelson.com", "nixonpeabody.com", "foley.com", "venable.com",
  "polsinelli.com", "mintz.com", "huschblackwell.com", "bricker.com", "epstein.com",
  "ebglaw.com", "wagehourblog.com", "laboremploymentlawblog.com"
];

// Trade and general press.
const PRESS_HOSTS = [
  "homehealthcarenews.com", "mcknights.com", "mcknightshomecare.com", "mcknightsseniorliving.com",
  "modernhealthcare.com", "healthcaredive.com", "hcinnovationgroup.com", "fiercehealthcare.com",
  "kff.org", "khn.org", "kffhealthnews.org", "statnews.com", "politico.com", "axios.com",
  "reuters.com", "apnews.com", "bloomberg.com", "wsj.com", "nytimes.com", "washingtonpost.com",
  "forbes.com", "cnbc.com", "npr.org", "stateline.org", "governing.com", "route-fifty.com",
  "hrdive.com", "shrm.com", "benefitspro.com", "shrm.co"
];

const TIER_LABEL = {
  1: "official source",
  2: "law firm alert",
  3: "press",
  4: "unranked source"
};

function hostOf(url) {
  try { return new URL(String(url)).hostname.toLowerCase().replace(/^www\./, ""); }
  catch { return ""; }
}

function matches(host, list) {
  return list.some(h => host === h || host.endsWith("." + h));
}

// 1 = official, 2 = law firm, 3 = press, 4 = everything else (incl. no URL).
function sourceTier(url) {
  const host = hostOf(url);
  if (!host) return 4;
  // Any government host, at any level: cms.gov, dol.gov, leg.state.ct.us style
  // domains, nj.gov, and every state legislature that lives under .gov.
  if (host === "gov" || host.endsWith(".gov") || host.endsWith(".mil")) return 1;
  if (/\.state\.[a-z]{2}\.us$/.test(host) || /^leg(is|islature)?\./.test(host)) return 1;
  if (matches(host, OFFICIAL_HOSTS)) return 1;
  if (matches(host, LEGAL_HOSTS)) return 2;
  if (matches(host, PRESS_HOSTS)) return 3;
  return 4;
}

function tierLabel(url) { return TIER_LABEL[sourceTier(url)]; }

// True when a source is weak enough that a human should find the primary rule
// before quoting the item to leadership. Applied to the email and admin views.
function needsBetterSource(url) { return sourceTier(url) >= 3; }

// Of two URLs for the same change, which should the calendar keep? Lower tier
// number wins; ties keep what is already stored, so a re-sweep does not churn
// the citation between equally good sources every day.
function preferSource(currentUrl, candidateUrl) {
  if (!candidateUrl) return currentUrl;
  if (!currentUrl) return candidateUrl;
  return sourceTier(candidateUrl) < sourceTier(currentUrl) ? candidateUrl : currentUrl;
}

module.exports = { sourceTier, tierLabel, needsBetterSource, preferSource, TIER_LABEL };
