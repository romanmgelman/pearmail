// Sender names → avatar initials.
//
// Approach modeled on established name parsers (e.g. Python's nameparser: nicknames in
// quotes/parentheses are set aside, titles and suffixes are matched against known lists,
// "Last, First" is recognized by its comma), plus rules specific to email senders:
// service tags like "(Jira)" or "via LinkedIn", role/no-reply addresses, and brand
// names taken from the sending domain.

const TITLES = new Set([
  "mr", "mrs", "ms", "mx", "miss", "mister", "madam", "dr", "doctor", "prof", "professor", "sir", "dame", "lady", "lord",
  "rev", "reverend", "fr", "father", "pastor", "rabbi", "imam", "hon", "honorable", "capt", "captain", "col", "colonel",
  "gen", "general", "lt", "maj", "major", "sgt", "sergeant", "cpt", "cmdr", "adm", "admiral", "officer", "judge",
  "president", "senator", "sen", "rep", "gov", "mayor", "dean", "coach", "chef",
]);
const SUFFIXES = new Set([
  "jr", "sr", "ii", "iii", "iv", "v", "vi", "phd", "md", "do", "dds", "dmd", "dvm", "esq", "esquire", "cpa", "mba", "rn", "np",
  "pa", "pe", "jd", "llm", "ma", "ms", "msc", "bsc", "ba", "bs", "cfa", "cfp", "pmp", "obe", "mbe", "cbe", "kbe", "frcs", "facs",
]);
// Lowercase particles that aren't the "last name" initial: Ludwig van Beethoven → LB.
const PARTICLES = new Set(["van", "von", "der", "den", "de", "da", "das", "dos", "del", "della", "di", "du", "la", "le", "bin", "ibn", "al", "el", "ten", "ter", "y", "e", "of", "the"]);
// Local parts that are roles or robots rather than people.
const ROLE_LOCALS = new Set([
  "noreply", "no-reply", "no_reply", "donotreply", "do-not-reply", "do_not_reply", "notifications", "notification", "notify",
  "info", "information", "support", "help", "helpdesk", "hello", "hi", "team", "news", "newsletter", "newsletters", "mailer",
  "mailer-daemon", "postmaster", "billing", "invoice", "invoices", "receipts", "orders", "order", "alerts", "alert", "updates",
  "update", "admin", "administrator", "contact", "service", "services", "customerservice", "customer-service", "care", "accounts",
  "account", "security", "sales", "marketing", "mail", "email", "bounce", "bounces", "reply", "auto", "automated", "system",
  "digest", "community", "feedback", "jobs", "careers", "press", "privacy", "legal", "office", "reception", "webmaster",
]);
// Subdomains that aren't the brand (mail.amazon.co.uk → amazon).
const SUBDOMAINS = new Set(["mail", "email", "em", "e", "m", "news", "newsletter", "mailer", "info", "notifications", "notification", "notify", "updates", "reply", "send", "smtp", "mx", "bounce", "bounces", "eu", "us", "mg", "sg", "post", "messages", "msg", "service", "accounts", "account", "alerts", "hello", "go", "click", "t", "links"]);
// Second-level labels used before a country code (amazon.co.uk, example.com.au).
const SLD = new Set(["co", "com", "net", "org", "ac", "gov", "edu", "ne", "or", "go"]);

const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const LETTER_START = /^\p{L}/u;
const EMAIL_RE = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;

const segmenter = typeof Intl !== "undefined" && Intl.Segmenter ? new Intl.Segmenter(undefined, { granularity: "grapheme" }) : null;
/** First user-perceived character (keeps "É" or combining accents together). */
function firstGrapheme(s) {
  if (!s) return "";
  if (segmenter) for (const { segment } of segmenter.segment(s)) return segment;
  return Array.from(s)[0] || "";
}
const upper = (s) => s.toLocaleUpperCase();
const bare = (w) => w.toLowerCase().replace(/\./g, "");

/**
 * Clean a display name down to the person (or organization) it names.
 * Returns "" when there's nothing usable.
 */
export function cleanName(raw, email = "") {
  let s = String(raw ?? "").replace(/\s+/g, " ").trim();
  // Strip wrapping quotes (and stray ones).
  s = s.replace(/^["'“”‘’]+|["'“”‘’]+$/g, "").replace(/["“”]/g, "").trim();
  if (!s) return "";
  // A "name" that's really an address isn't a name.
  if (EMAIL_RE.test(s) || (email && s.toLowerCase() === email.toLowerCase())) return "";
  // Bracketed groups: "(Jira)", "[GitHub]", "{bot}", "<x@y>" — nicknames/tags, not name parts.
  let prev;
  do { prev = s; s = s.replace(/\([^()]*\)|\[[^[\]]*\]|\{[^{}]*\}|<[^<>]*>/g, " "); } while (s !== prev);
  s = s.replace(/[()[\]{}<>]/g, " ").replace(/\s+/g, " ").trim();
  // Service / organization tails: "Mark Garcia via Jira", "Mark Garcia - Acme", "GitHub | Alerts".
  const tail = s.split(/\s+(?:via|on behalf of)\s+|\s+[|·–—-]\s+|\s*:\s+/i);
  s = (tail[0] || "").trim() || tail.find((x) => x.trim())?.trim() || "";
  // Commas: "Garcia, Mark" → "Mark Garcia"; "Mark Garcia, PhD" → "Mark Garcia".
  if (s.includes(",")) {
    const parts = s.split(",").map((x) => x.trim()).filter(Boolean);
    const isSuffixList = (p) => p.split(/\s+/).every((w) => SUFFIXES.has(bare(w)));
    const keep = parts.filter((p, i) => i === 0 || !isSuffixList(p));
    if (keep.length >= 2) s = `${keep.slice(1).join(" ")} ${keep[0]}`;
    else s = keep[0] || "";
  }
  return s.replace(/\s+/g, " ").trim();
}

/** Words that can contribute an initial (titles, suffixes and non-letter tokens removed). */
function nameWords(s) {
  let words = s.split(" ").filter(Boolean);
  while (words.length > 1 && TITLES.has(bare(words[0]))) words.shift();
  if (words.length > 1 && bare(words[0]) === "the") words.shift(); // "The New York Times" → NT
  while (words.length > 1 && SUFFIXES.has(bare(words[words.length - 1]))) words.pop();
  return words.filter((w) => LETTER_START.test(w));
}

function initialsFromWords(words) {
  if (!words.length) return "";
  const first = words[0];
  if (CJK.test(firstGrapheme(first))) return firstGrapheme(first); // CJK: one character (family name)
  // Last word for the second initial, skipping lowercase particles ("van", "de").
  let last = null;
  for (let i = words.length - 1; i > 0; i--) {
    const w = words[i];
    if (PARTICLES.has(w.toLowerCase()) && w === w.toLowerCase()) continue;
    last = w;
    break;
  }
  return upper(firstGrapheme(first) + (last ? firstGrapheme(last) : ""));
}

/** Brand label of a domain: "mail.amazon.co.uk" → "amazon", "github.com" → "github". */
export function brandOf(domain) {
  const labels = String(domain || "").toLowerCase().split(".").filter(Boolean);
  if (labels.length < 2) return labels[0] || "";
  let end = labels.length - 1; // TLD
  if (labels.length >= 3 && SLD.has(labels[end - 1]) && labels[end].length === 2) end--; // co.uk
  const reg = labels.slice(0, end);
  // The registrable label is the last one before the (effective) TLD.
  let brand = reg[reg.length - 1] || "";
  if (SUBDOMAINS.has(brand) && reg.length > 1) brand = reg[reg.length - 2];
  return brand;
}

function initialsFromEmail(email) {
  const e = String(email || "").trim().toLowerCase();
  if (!e.includes("@")) return "";
  let [local, domain] = [e.slice(0, e.lastIndexOf("@")), e.slice(e.lastIndexOf("@") + 1)];
  local = local.split("+")[0];
  const compact = local.replace(/[^a-z]/g, "");
  const isRole = ROLE_LOCALS.has(local) || ROLE_LOCALS.has(compact) || /^(no-?reply|do-?not-?reply)/.test(local);
  if (isRole) {
    const brand = brandOf(domain);
    return brand ? upper(firstGrapheme(brand)) : "";
  }
  const parts = local.split(/[._\-\d]+/).filter((p) => LETTER_START.test(p));
  if (!parts.length) return "";
  return upper(firstGrapheme(parts[0]) + (parts.length > 1 ? firstGrapheme(parts[parts.length - 1]) : ""));
}

/** Avatar initials for a sender {name, email}. */
export function initials(person) {
  const email = person?.email || "";
  const name = cleanName(person?.name, email);
  if (name) {
    const ini = initialsFromWords(nameWords(name));
    if (ini) return ini;
  }
  return initialsFromEmail(email) || "?";
}
