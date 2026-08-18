// Tells our own content apart from someone else's mention of us.
//
// Reputation Watch - in both the email and this dashboard - is supposed to show
// what THIRD PARTIES said. Our own posts were already read by us the day we
// published them, so they are noise here.
//
// This file is the single implementation. It runs in the browser (loaded by
// public/index.html) and in Node (lib/owned.js wraps it with the server-side
// watchlist), because the previous arrangement - a prompt asking Claude nicely,
// plus a hand-typed list in two places - let plenty of self-posted content
// through and let the two copies drift apart.
//
// Two ways an owned property is recognised, most confident first:
//   1. the explicit EXCLUDE list passed in by the caller
//   2. a slug match between the URL and the brand the item is filed under -
//      this is what catches the agency sites and social accounts nobody has
//      gotten around to adding to that list (most of the 25 brands)
//
// Job boards are handled separately: a third-party domain carrying a posting we
// wrote ourselves. Press releases and directory/review profiles are NOT
// filtered - a paid wire story still reads as coverage, and a Yelp or BBB page
// is where real reviews live.
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.OwnedFilter = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // Corporate filler that a domain may carry but a brand name may not, or the
  // other way round: "Agility Home Care" vs agilityhomecare.com vs agility.com.
  var FILLER = ["homecare", "healthcare", "homehealth", "adultdaycare", "daycare",
    "care", "health", "home", "services", "service", "nursing", "medical",
    "agency", "group", "inc", "llc", "co", "official", "us", "usa", "online"];

  var SOCIAL = ["facebook.com", "fb.com", "instagram.com", "linkedin.com", "tiktok.com",
    "youtube.com", "x.com", "twitter.com", "threads.net", "pinterest.com"];

  // Boards where the "mention" is a posting we placed ourselves.
  var JOB_BOARDS = ["indeed.com", "ziprecruiter.com", "glassdoor.com", "snagajob.com",
    "simplyhired.com", "monster.com", "careerbuilder.com", "talent.com", "jooble.org",
    "jobcase.com", "myworkdayjobs.com", "lever.co", "greenhouse.io", "workable.com",
    "smartrecruiters.com", "applicantpro.com", "paycomonline.com", "adp.com",
    "jobs.net", "joblist.com", "recruiter.com", "getwork.com", "salary.com"];

  // Social paths that belong to the platform, not to any account.
  var PLATFORM_PATHS = ["watch", "posts", "share", "reel", "video", "shorts",
    "results", "search", "hashtag", "feed", "jobs", "groups", "events"];

  function slug(s) { return String(s == null ? "" : s).toLowerCase().replace(/[^a-z0-9]/g, ""); }

  function parts(url) {
    try {
      var u = new URL(String(url));
      return { host: u.hostname.toLowerCase().replace(/^www\./, ""), path: u.pathname.toLowerCase() };
    } catch (e) { return { host: "", path: "" }; }
  }

  // The registrable label: "agilityhomecare" out of "www.agilityhomecare.com".
  // Handles two-part suffixes (.co.uk) well enough for our purposes.
  function domainLabel(host) {
    var p = host.split(".").filter(Boolean);
    if (p.length < 2) return p[0] || "";
    var last2 = p.slice(-2).join(".");
    return /^(co|com|org|net|gov|ac)\.[a-z]{2}$/.test(last2) ? (p[p.length - 3] || "") : p[p.length - 2];
  }

  function endsWithHost(host, base) {
    return host === base || host.slice(-(base.length + 1)) === "." + base;
  }

  function stripFiller(s) {
    var out = s, changed = true;
    while (changed) {
      changed = false;
      for (var i = 0; i < FILLER.length; i++) {
        var f = FILLER[i];
        if (out.length > f.length && out.slice(-f.length) === f) { out = out.slice(0, -f.length); changed = true; }
      }
    }
    return out;
  }

  // Is this URL fragment the same identity as this brand name? Exact first, then
  // allowing either side to carry extra corporate filler the other one drops.
  // The 6-character floor keeps short generic stems ("all", "care") from
  // matching half the web.
  function sameIdentity(fragment, brandName) {
    var a = slug(fragment), b = slug(brandName);
    if (!a || !b) return false;
    if (a === b) return true;
    if (a.length >= 6 && b.indexOf(a) === 0 && stripFiller(b) === stripFiller(a)) return true;
    if (b.length >= 6 && a.indexOf(b) === 0 && stripFiller(a) === stripFiller(b)) return true;
    return false;
  }

  // The account handle out of a social URL, whatever shape that platform uses.
  function socialHandle(host, path) {
    var segs = path.split("/").filter(Boolean).map(function (s) { return s.replace(/^@/, ""); });
    if (!segs.length) return "";
    if (host.indexOf("linkedin.com") >= 0) {
      var i = segs.findIndex(function (s) { return ["company", "in", "school", "showcase"].indexOf(s) >= 0; });
      return i >= 0 ? (segs[i + 1] || "") : "";
    }
    if (host.indexOf("youtube.com") >= 0) {
      if (["c", "user", "channel"].indexOf(segs[0]) >= 0) return segs[1] || "";
      return segs[0];
    }
    if (["pages", "profile.php", "people", "p"].indexOf(segs[0]) >= 0) return segs[1] || "";
    return segs[0];
  }

  function isJobPosting(url, title) {
    var p = parts(url);
    if (!p.host) return false;
    for (var i = 0; i < JOB_BOARDS.length; i++) {
      if (endsWithHost(p.host, JOB_BOARDS[i])) return true;
    }
    if (p.host.indexOf("linkedin.com") >= 0 && p.path.indexOf("/jobs") === 0) return true;
    // A careers subdomain or a hiring page on any site is still our own posting.
    if (/^(careers?|jobs|apply|hiring)\./.test(p.host)) return true;
    if (/\b(hiring|now hiring|apply now|job opening|caregiver wanted)\b/i.test(String(title == null ? "" : title))) return true;
    return false;
  }

  // watchlist: [{name}] or ["name"]. exclude: ["domain.com", "facebook.com/handle"].
  function createFilter(watchlist, exclude) {
    var names = (watchlist || []).map(function (w) { return typeof w === "string" ? w : (w && w.name) || ""; }).filter(Boolean);
    var owned = (exclude || []).map(function (e) { return String(e).toLowerCase().replace(/^www\./, ""); });

    // Owned property = on the explicit list, or a domain/social handle that IS
    // the brand. brandName narrows rule 2; without it, every name is tried.
    function isOwnedProperty(url, brandName) {
      var p = parts(url);
      if (!p.host) return false;
      var full = (p.host + p.path).replace(/\/$/, "");
      for (var i = 0; i < owned.length; i++) {
        var e = owned[i];
        if (full === e || full.indexOf(e + "/") === 0 || endsWithHost(p.host, e)) return true;
      }

      // An item filed under "A + B" involves several brands; any of them owning
      // the URL makes it ours.
      var candidates = brandName
        ? String(brandName).split("+").map(function (s) { return s.trim(); }).filter(Boolean)
        : names;

      var isSocial = SOCIAL.some(function (s) { return endsWithHost(p.host, s); });
      var fragment = isSocial ? socialHandle(p.host, p.path) : domainLabel(p.host);
      if (!fragment) return false;
      if (isSocial && PLATFORM_PATHS.indexOf(fragment) >= 0) return false;
      return candidates.some(function (n) { return sameIdentity(fragment, n); });
    }

    // Reason this URL should not appear in Reputation Watch, or "" to keep it.
    function selfPostedReason(url, brandName, title) {
      if (isOwnedProperty(url, brandName)) return "own property";
      if (isJobPosting(url, title)) return "job posting";
      return "";
    }

    // Drop our own content from a set of items, logging every removal so a
    // wrong drop is findable rather than silent.
    function filterSelfPosted(items, label) {
      var kept = [], dropped = 0;
      (items || []).forEach(function (item) {
        var why = selfPostedReason(item.url, item.agency, item.title);
        if (why) {
          dropped++;
          if (typeof console !== "undefined") {
            console.log("[" + (label || "reputation") + "] dropped self-posted (" + why + "): " +
              (item.agency || "?") + " - " + item.title + " - " + item.url);
          }
          return;
        }
        kept.push(item);
      });
      return { items: kept, dropped: dropped };
    }

    return {
      isOwnedProperty: isOwnedProperty,
      isJobPosting: isJobPosting,
      selfPostedReason: selfPostedReason,
      filterSelfPosted: filterSelfPosted
    };
  }

  return { createFilter: createFilter, isJobPosting: isJobPosting, sameIdentity: sameIdentity, slug: slug };
});
