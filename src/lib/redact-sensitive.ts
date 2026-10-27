/**
 * The one secret redactor: live feed thoughts and events, run-ledger errors
 * (agent_runs.error), run events and the failure copy every failure surface
 * shows. Pure and client-safe (no Node or server imports).
 *
 * Unit-tested in tests/unit/live-feed-v2.test.ts,
 * tests/unit/failure-cause.test.ts and tests/unit/redact-sensitive.test.ts.
 *
 * Every pattern is linear on any input: runs that are scanned and can then
 * fail (an email's local part, a PEM header, a JWT's first segment) have an
 * upper bound, and the input itself is capped at REDACT_INPUT_MAX chars, so a
 * hostile 300k-char name or error cannot pin the event loop.
 */

/** The most text one redaction pass reads; anything longer is clipped first. */
export const REDACT_INPUT_MAX = 4_000;

/**
 * The first `max` chars (never more than REDACT_INPUT_MAX), for callers that
 * truncate their output anyway: clip, redact, then truncate. When the text is
 * cut, its trailing partial token is dropped too, since half a key would slip
 * past the patterns below.
 */
export function clipForRedaction(input: string, max: number = REDACT_INPUT_MAX): string {
    const limit = Math.max(0, Math.min(Math.floor(max), REDACT_INPUT_MAX));
    if (input.length <= limit) return input;
    const cut = input.slice(0, limit);
    for (let i = cut.length - 1; i >= 0; i--) {
        if (/\s/.test(cut[i])) return cut.slice(0, i);
    }
    return cut;
}

const REDACTIONS: [RegExp, string][] = [
    // URLs (any scheme) and bare www. hosts.
    [/\b[a-z][a-z0-9+.-]{1,15}:\/\/[^\s<>"'`)\]]+/gi, "[link]"],
    [/\bwww\.[^\s<>"'`)\]]+/gi, "[link]"],
    // Emails.
    [/[a-z0-9._%+-]{1,64}@[a-z0-9-]{1,63}(?:\.[a-z0-9-]{1,63}){1,10}/gi, "[email]"],
    // PEM blocks and bearer credentials.
    [/-----BEGIN [A-Z ]{1,40}-----[\s\S]*?(?:-----END [A-Z ]{1,40}-----|$)/g, "[secret]"],
    [/\b(bearer|basic)\s{1,16}[A-Za-z0-9._~+/=-]{8,}/gi, "$1 [secret]"],
    // An "Authorization:" header value, whatever its scheme ("Token …", "Digest …").
    [/\b(authorization)(["']?\s{0,16}[:=]\s{0,16})["']?(?:(?:bearer|basic|token|digest)\s{1,16})?[^\s"',;]+/gi, "$1$2[secret]"],
    // key=value / key: value credentials.
    [/\b(password|passwd|pwd|secret|token|(?:access|refresh|id|session)[_-]?token|api[_-]?key|access[_-]?key|client[_-]?secret|auth)\b(["']?\s{0,16}[:=]\s{0,16})["']?[^\s"',;]+/gi, "$1$2[secret]"],
    // Credential query parameters ("?key=…", "&sig=…") the rule above leaves.
    [/([?&;](?:key|sig|signature|code)=)[^&#\s"']+/gi, "$1[secret]"],
    // "password hunter2", "token abc123xyz": a keyword followed by a value that
    // is not a plain word (it has a digit or a symbol), so prose like "the key
    // insight" survives. Placeholders from earlier rules ("[link]") are kept.
    [/\b(password|passwd|pwd|secret|token|key)(\s{1,16})(?=[^\s"',;]{6})(?![a-z]{1,64}\b)(?!\[)["']?[^\s"',;]+/gi, "$1$2[secret]"],
    // Known token prefixes: Emperor Claw, GitHub, OpenAI/Anthropic, Slack, Stripe, AWS, Google, JWTs.
    [/\b(?:ec|ghp|gho|ghu|ghs|ghr|glpat|xox[abposr]|sk|pk|rk|whsec)[_-][A-Za-z0-9_-]{6,}/g, "[secret]"],
    [/\bgithub_pat_[A-Za-z0-9_]{10,}/g, "[secret]"],
    [/\bsk-[A-Za-z0-9_-]{6,}/g, "[secret]"],
    [/\b(?:AKIA|ASIA)[A-Z0-9]{12,}/g, "[secret]"],
    [/\bAIza[A-Za-z0-9_-]{20,}/g, "[secret]"],
    [/\beyJ[A-Za-z0-9_-]{8,512}\.[A-Za-z0-9_-]{8,}(?:\.[A-Za-z0-9_-]+)?/g, "[secret]"],
    // Home-directory and system paths (POSIX, macOS, ~) and any Windows drive path.
    [/(?<![\w.])\/(?:home|Users|root|var|etc|opt|srv)(?:\/[^\s"'`<>|]*)?/g, "[path]"],
    [/\b[A-Za-z]:[\\/][^\s"'`<>|]*/g, "[path]"],
    [/(?<![\w~])~[\\/][^\s"'`<>|]*/g, "[path]"],
];

/**
 * A long run of hex, or of base64/url-safe chars containing both letters and
 * digits (keys, ids, hashes). "/" is not part of a run so ordinary relative
 * paths survive; real base64 keys rarely split into short pieces.
 */
const OPAQUE_RUN_RE = /[A-Za-z0-9+=_-]{24,}/g;

/**
 * Is a long run a key, hash or id rather than a word? Hex (dashes allowed:
 * uuids), anything mixing upper case, lower case and digits, or an unbroken
 * letters+digits run with no kebab/snake separators. Identifiers such as
 * `thread_message_reasoning_v2_index` or `live-feed-budget-check-24` are kept.
 */
export function isOpaqueRun(run: string): boolean {
    if (/^[0-9a-f-]{24,}$/i.test(run) && /[0-9]/.test(run) && run.replace(/-/g, "").length >= 24) return true;
    const upper = /[A-Z]/.test(run), lower = /[a-z]/.test(run), digit = /[0-9]/.test(run);
    if (upper && lower && digit) return true;
    return !/[_-]/.test(run) && digit && (upper || lower);
}

/**
 * Standard base64 that does contain "/" or "+" (which split OPAQUE_RUN_RE):
 * 32+ characters mixing upper case, lower case and digits. Relative paths
 * rarely mix all three over that length.
 */
const BASE64_RUN_RE = /[A-Za-z0-9+/]{32,}={0,2}/g;

function isBase64Blob(run: string): boolean {
    return /[+/]/.test(run) && /[A-Z]/.test(run) && /[a-z]/.test(run) && /[0-9]/.test(run);
}

function redactOpaqueRuns(text: string): string {
    return text
        .replace(BASE64_RUN_RE, (run) => (isBase64Blob(run) ? "[secret]" : run))
        .replace(OPAQUE_RUN_RE, (run) => (isOpaqueRun(run) ? "[secret]" : run));
}

/** Remove URLs, emails, credentials, tokens, opaque ids/keys and home paths. */
export function redactSensitive(input: string): string {
    let text = clipForRedaction(input);
    for (const [re, replacement] of REDACTIONS) text = text.replace(re, replacement);
    return redactOpaqueRuns(text);
}
