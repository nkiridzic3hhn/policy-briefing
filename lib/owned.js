// Server-side binding of the shared self-posted filter.
//
// The implementation lives in public/owned-filter.js so the dashboard's inline
// script and this module run the exact same rules - the previous arrangement
// kept a second hand-typed copy in public/index.html, and the two drifted.
// Everything of substance, including why press releases and review profiles are
// deliberately NOT filtered, is documented there.
const { createFilter } = require("../public/owned-filter");
const { WATCHLIST, EXCLUDE } = require("./watchlist");

module.exports = createFilter(WATCHLIST, EXCLUDE);
