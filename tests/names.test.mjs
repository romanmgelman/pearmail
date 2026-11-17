// Run: node tests/names.test.mjs
import { initials, cleanName, brandOf } from "../ui/js/names.js";

const cases = [
  // [name, email, expected]
  ["Mark Garcia (Jira)", "jira@atlassian.net", "MG"],
  ["Mark Garcia via Jira", "jira@atlassian.net", "MG"],
  ["Garcia, Mark", "mark@x.com", "MG"],
  ["Dr. Mark Garcia Jr.", "", "MG"],
  ["Mark Garcia, PhD", "", "MG"],
  ["Mark Garcia, M.D.", "", "MG"],
  ["Ludwig van Beethoven", "", "LB"],
  ['"Alex Rivera"', "", "AR"],
  ["Design & Ops Team", "", "DT"],
  ["Jira", "jira@atlassian.net", "J"],
  ["[GitHub] Notifications", "", "N"],
  ["Émilie Durand", "", "ÉD"],
  ["王小明", "", "王"],
  ["김민수", "", "김"],
  ["🎉 Party Planners", "", "PP"],
  ["O'Brien, Conan", "", "CO"],
  ["Mary-Jane Watson", "", "MW"],
  ["The New York Times", "nytdirect@nytimes.com", "NT"],
  ["Mark Garcia - Acme Corp", "", "MG"],
  ["GitHub | Security Alerts", "", "G"],
  ["Bank of America", "", "BA"],
  ["Mark Garcia <mark@x.com>", "", "MG"],
  ["mark@x.com", "mark@x.com", "M"],
  ["Turk Telekom", "bilgi@sabitinternet.turktelekom.com.tr", "TT"],
  ["  ", "", "?"],
  // No display name: from the address.
  ["", "notifications@github.com", "G"],
  ["", "noreply@mail.amazon.co.uk", "A"],
  ["", "no-reply@accounts.google.com", "G"],
  ["", "mark.garcia+jira@x.com", "MG"],
  ["", "jsmith42@x.com", "J"],
  ["", "", "?"],
  ["Mr Bean", "", "B"],
  ["Sir", "", "S"],
];

let fail = 0;
for (const [name, email, want] of cases) {
  const got = initials({ name, email });
  if (got !== want) { fail++; console.log(`FAIL ${JSON.stringify(name)} <${email}>: got ${got}, want ${want}  (clean: ${JSON.stringify(cleanName(name, email))})`); }
}
for (const [d, want] of [["github.com", "github"], ["mail.amazon.co.uk", "amazon"], ["accounts.google.com", "google"], ["em.example.com.au", "example"]]) {
  if (brandOf(d) !== want) { fail++; console.log(`FAIL brandOf(${d}) = ${brandOf(d)}, want ${want}`); }
}
console.log(fail ? `${fail} failed` : `all ${cases.length + 4} passed`);
process.exit(fail ? 1 : 0);
