// The states Honor Health Network actually operates in. Single source of truth:
// the digest engine, the law tracker, the email filters, and the subscribe form
// all scope to this list, so adding a state here adds it everywhere.
const STATES = ["New York", "New Jersey", "Pennsylvania", "Massachusetts", "Connecticut",
  "Georgia", "Michigan", "Indiana", "Colorado", "Maryland", "Washington DC"];

module.exports = { STATES };
