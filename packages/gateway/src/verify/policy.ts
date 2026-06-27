/**
 * Deterministic policy / PII detection over response text. Pure and side-effect free.
 * Returns matched **category codes** (e.g. `pii.email`) — never the matched substrings,
 * so a trace can record what kind of issue was found without persisting the sensitive value.
 */
export interface PolicyConfig {
  /** Content-policy terms; a case-insensitive substring match flags `policy.blocklist`. */
  blocklist?: string[] | undefined;
  /** PII categories to check; omit or empty ⇒ all built-in categories. */
  pii?: string[] | undefined;
}

interface Detector {
  code: string;
  detect: (text: string) => boolean;
}

function regexDetector(code: string, re: RegExp): Detector {
  return { code, detect: (text) => re.test(text) };
}

const DETECTORS: Detector[] = [
  regexDetector('pii.email', /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i),
  regexDetector('pii.ssn', /\b\d{3}-\d{2}-\d{4}\b/),
  regexDetector('pii.phone', /\b(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/),
  regexDetector('pii.api_key', /\b(?:sk|pk|api[_-]?key)[-_][A-Za-z0-9]{16,}\b/i),
  { code: 'pii.ipv4', detect: detectIpv4 },
  { code: 'pii.credit_card', detect: detectCreditCard },
];

const REFUSAL_RE =
  /\b(?:I['’]?m sorry|I cannot|I can['’]?t (?:help|assist|comply)|as an AI(?: language model)?)\b/i;

/** Detects policy/PII categories present in `text`. */
export function detectPolicy(text: string, config: PolicyConfig = {}): string[] {
  const allow = config.pii;
  const enabled = (code: string): boolean =>
    allow === undefined || allow.length === 0 || allow.includes(code);

  const found = new Set<string>();
  for (const detector of DETECTORS) {
    if (enabled(detector.code) && detector.detect(text)) found.add(detector.code);
  }

  if (config.blocklist !== undefined && config.blocklist.length > 0) {
    const lower = text.toLowerCase();
    for (const term of config.blocklist) {
      if (term.length > 0 && lower.includes(term.toLowerCase())) {
        found.add('policy.blocklist');
        break;
      }
    }
  }

  if (REFUSAL_RE.test(text)) found.add('policy.refusal');

  return [...found];
}

/** IPv4 with octet-range validation, so impossible octets (e.g. `999.x.x.x`) don't match. */
function detectIpv4(text: string): boolean {
  for (const match of text.matchAll(/\b(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\b/g)) {
    if (match.slice(1, 5).every((octet) => Number(octet) <= 255)) return true;
  }
  return false;
}

/** Credit-card-shaped digit runs, confirmed with the Luhn checksum to cut false positives. */
function detectCreditCard(text: string): boolean {
  for (const match of text.matchAll(/\b(?:\d[ -]?){13,19}\b/g)) {
    const digits = match[0].replace(/\D/g, '');
    if (digits.length >= 13 && digits.length <= 19 && luhnValid(digits)) return true;
  }
  return false;
}

function luhnValid(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let d = digits.charCodeAt(i) - 48; // '0'
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}
