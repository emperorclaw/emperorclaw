/**
 * Custom OpenAI-compatible model endpoints (Ollama, LM Studio, vLLM, LiteLLM,
 * a company gateway): the provider id, base URL validation, and the shape of
 * the encrypted LLM secret that carries the URL.
 *
 * Pure and client-safe: the setup wizard and the hire dialog validate as the
 * person types, the server validates again before storing anything.
 *
 * The base URL is stored inside the agent's encrypted LLM payload
 * (`{ apiKey?, baseUrl }` in agents.llm_api_key_encrypted) rather than in its
 * own column: it can embed an internal host name, and the payload already
 * travels with the agent (reuse, recreate, key rotation) wherever the key does.
 */

export const CUSTOM_LLM_PROVIDER = "custom";

export const LLM_BASE_URL_MAX = 500;

/** Where a local model server on the Docker host is reachable from an agent's container. */
export const DOCKER_HOST_ALIAS = "host.docker.internal";

export type BaseUrlCheck =
    | { ok: true; url: string; hint: string | null }
    | { ok: false; error: string };

const LOOPBACK_HOSTS = new Set(["localhost", "0.0.0.0", "[::1]", "::1"]);

function isLoopbackHost(hostname: string): boolean {
    const host = hostname.toLowerCase();
    return LOOPBACK_HOSTS.has(host) || host.endsWith(".localhost") || /^127(?:\.\d{1,3}){3}$/.test(host);
}

/** `text` without trailing slashes. A loop, not /\/+$/: that regex backtracks quadratically on a run of slashes. */
export function trimTrailingSlashes(text: string): string {
    let end = text.length;
    while (end > 0 && text.charCodeAt(end - 1) === 47 /* "/" */) end--;
    return text.slice(0, end);
}

/** The hint for a loopback URL: inside the agent's container, localhost is the container. */
export function dockerLoopbackHint(url: URL): string {
    const swapped = new URL(url.toString());
    swapped.hostname = DOCKER_HOST_ALIAS;
    return `Agents run in their own containers, where ${url.hostname} is the container itself. For a server on this machine, use ${trimTrailingSlashes(swapped.toString())}.`;
}

/**
 * Validate and normalize a base URL: http or https, no credentials, query or
 * fragment, no trailing slash. A loopback host is accepted (a remote Hermes
 * runs on the same machine as its model server) but comes with the Docker hint.
 */
export function normalizeLlmBaseUrl(raw: unknown): BaseUrlCheck {
    const text = typeof raw === "string" ? raw.trim() : "";
    if (!text) return { ok: false, error: "Enter the endpoint's base URL, for example http://host.docker.internal:11434/v1." };
    if (text.length > LLM_BASE_URL_MAX) return { ok: false, error: `The base URL can have at most ${LLM_BASE_URL_MAX} characters.` };
    let url: URL;
    try {
        url = new URL(text);
    } catch {
        return { ok: false, error: "That is not a URL. Include the scheme, for example http://host.docker.internal:11434/v1." };
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") return { ok: false, error: "The base URL must start with http:// or https://." };
    if (url.username || url.password) return { ok: false, error: "Put the key in the API key field, not in the URL." };
    if (url.search || url.hash) return { ok: false, error: "The base URL can't have a query string or #fragment." };
    const normalized = trimTrailingSlashes(`${url.origin}${url.pathname}`);
    return { ok: true, url: normalized, hint: isLoopbackHost(url.hostname) ? dockerLoopbackHint(url) : null };
}

export type LlmSecret = { apiKey: string | null; baseUrl: string | null };

/** Read a decrypted LLM payload: `{ apiKey }` for hosted providers, `{ apiKey?, baseUrl }` for a custom endpoint. */
export function parseLlmSecret(payload: unknown): LlmSecret {
    const value = payload && typeof payload === "object" ? payload as Record<string, unknown> : {};
    const apiKey = typeof value.apiKey === "string" && value.apiKey.trim() ? value.apiKey.trim() : null;
    const baseUrl = typeof value.baseUrl === "string" && value.baseUrl.trim() ? value.baseUrl.trim() : null;
    return { apiKey, baseUrl };
}

/** The payload to encrypt; null when there is nothing to store. */
export function llmSecretPayload(secret: { apiKey?: string | null; baseUrl?: string | null }): Record<string, string> | null {
    const payload: Record<string, string> = {};
    if (secret.apiKey?.trim()) payload.apiKey = secret.apiKey.trim();
    if (secret.baseUrl?.trim()) payload.baseUrl = secret.baseUrl.trim();
    return Object.keys(payload).length ? payload : null;
}

/** The host name of a stored base URL for the activity log: no scheme, port, path, query or key. */
export function llmEndpointHost(baseUrl: string | null | undefined): string | null {
    if (!baseUrl) return null;
    try {
        return new URL(baseUrl).hostname.replace(/^\[|\]$/g, "").toLowerCase() || null;
    } catch {
        return null;
    }
}

export const LLM_MODEL_MAX = 200;

/**
 * Model ids as providers and local servers name them: `gpt-4o-mini`,
 * `deepseek/deepseek-chat`, `llama3.1:8b`, `qwen2.5-coder:32b-instruct-q4_K_M`,
 * `nvidia/nemotron-3-ultra-550b-a55b:free`. No spaces, quotes or control
 * characters: the name is written into the agent runtime's config file.
 */
const LLM_MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]*$/;

/**
 * Validate a model name. An empty value is "no model" (the provider's default)
 * and is accepted; anything else must be at most LLM_MODEL_MAX characters of
 * letters, digits and `. _ : / @ + -`.
 */
export function checkLlmModelName(raw: unknown): { ok: true; model: string } | { ok: false; error: string } {
    if (raw === null || raw === undefined) return { ok: true, model: "" };
    if (typeof raw !== "string") return { ok: false, error: "The model must be a name." };
    const model = raw.trim();
    if (!model) return { ok: true, model: "" };
    if (model.length > LLM_MODEL_MAX) return { ok: false, error: `The model name can have at most ${LLM_MODEL_MAX} characters.` };
    if (!LLM_MODEL_RE.test(model)) return { ok: false, error: "The model name can only use letters, digits and . _ : / @ + - (no spaces)." };
    return { ok: true, model };
}
