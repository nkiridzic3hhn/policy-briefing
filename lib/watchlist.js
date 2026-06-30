// Honor Health Network agencies, brands, and people to monitor for the
// reputation digest. Kept in sync with the WATCHLIST in public/index.html.
const WATCHLIST = [
  { name: "Honor Health Network", context: "national home health and home care network, parent company. NOT HonorHealth the Arizona hospital system, and NOT Honor / Honor Care (joinhonor.com) the San Francisco home-care tech company" },
  { name: "CaringPays", context: "Honor's nationwide paid-family-caregiver brand, caringpays.com" },
  { name: "Simon Shemia", context: "CEO of Honor Health Network" },
  { name: "Agility Home Care", context: "Georgia home care agency" },
  { name: "All Health Home Care", context: "New York home care agency (NHTD waiver)" },
  { name: "All at Home", context: "Massachusetts home care agency" },
  { name: "Always Home Services", context: "New Jersey home care agency" },
  { name: "Angels On Call", context: "Pennsylvania home care agency" },
  { name: "Angels On Call", context: "Michigan home care agency" },
  { name: "Broadway Medical Adult Day Care", context: "New Jersey adult day care" },
  { name: "Broadway Respite and Home Care", context: "New Jersey home care agency" },
  { name: "Caring Home Care", context: "Maryland home care agency" },
  { name: "Central Penn Nursing Care", context: "Pennsylvania home care agency" },
  { name: "FamilyCares", context: "Pennsylvania private-duty home care agency" },
  { name: "First Horizon", context: "Indiana home care agency. NOT First Horizon the bank" },
  { name: "Golden Years Homecare Services", context: "Massachusetts home care agency" },
  { name: "Hand In Hand", context: "New York home care agency" },
  { name: "Home Care Visiting Nurse", context: "Connecticut home health agency" },
  { name: "IRN Home Care", context: "Colorado home care agency" },
  { name: "Juniper Home Care Services", context: "Connecticut home care agency" },
  { name: "Juniper Adult Day Care", context: "Connecticut adult day care" },
  { name: "Juniper Meals on Wheels", context: "Connecticut meals on wheels program" },
  { name: "Just Home Medical Adult Day Care", context: "New Jersey adult day care" },
  { name: "Nightingale Services", context: "Georgia home care agency" },
  { name: "Quality Healthcare", context: "New York home care agency" },
  { name: "VMT Home Health", context: "Washington DC home health agency" }
];

const EXCLUDE = [
  "honorhealthnetwork.com",
  "linkedin.com/company/honorhealthnetwork",
  "caringpays.com",
  "tiktok.com/@caringpays",
  "youtube.com/@CaringPays",
  "instagram.com/caringpays",
  "linkedin.com/company/caringpays",
  "facebook.com/caringpays",
  "agilityhomecare.com",
  "juniperhomecare.com"
];

module.exports = { WATCHLIST, EXCLUDE };
