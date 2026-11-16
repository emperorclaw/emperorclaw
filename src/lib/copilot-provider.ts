/**
 * GitHub Copilot as an LLM provider for Hermes agents.
 *
 * Hermes (v0.22.4) ships a native `copilot` provider: `model.provider: copilot`
 * talks to https://api.githubcopilot.com and authenticates with a GitHub
 * token read from COPILOT_GITHUB_TOKEN (then GH_TOKEN, GITHUB_TOKEN), which it
 * exchanges for a short-lived Copilot API token on its own.
 *
 * Pure and client-safe: the hire dialog and the API routes share it.
 */

export const COPILOT_PROVIDER = "copilot";

/** The env var Emperor stores the token under, in the container and the host profile .env. */
export const COPILOT_TOKEN_ENV = "COPILOT_GITHUB_TOKEN";

export const COPILOT_DEFAULT_MODEL = "gpt-5-mini";

/**
 * The models Copilot serves through Hermes, from hermes-agent v0.22.4
 * hermes_cli/models_catalog_static.py (`_PROVIDER_MODELS["copilot"]`). Which
 * ones a given account can use depends on its Copilot plan.
 */
export const COPILOT_MODELS = [
    "gpt-5.4",
    "gpt-5.4-mini",
    "gpt-5-mini",
    "gpt-5.3-codex",
    "gpt-5.2-codex",
    "gpt-4.1",
    "gpt-4o",
    "gpt-4o-mini",
    "claude-sonnet-5",
    "claude-sonnet-4.6",
    "claude-sonnet-4.5",
    "claude-haiku-4.5",
    "gemini-3.1-pro-preview",
    "gemini-2.5-pro",
] as const;

export function isCopilotModel(model: string | null | undefined): boolean {
    return typeof model === "string" && (COPILOT_MODELS as readonly string[]).includes(model);
}

/** Token prefixes the Copilot API accepts (hermes_cli/copilot_auth.py `_SUPPORTED_PREFIXES`). */
const SUPPORTED_PREFIXES = ["gho_", "ghu_", "github_pat_"] as const;

export const COPILOT_CLASSIC_PAT_ERROR =
    "Classic PATs (ghp_) are not supported by the Copilot API; use `gh auth login` (gho_) or a fine-grained PAT with Copilot Requests permission.";

/**
 * Check a GitHub token for Copilot use. Never echoes the token back: the
 * error names only the accepted kinds.
 */
export function checkCopilotToken(raw: string): { ok: true } | { ok: false; error: string } {
    const token = raw.trim();
    if (token.startsWith("ghp_")) return { ok: false, error: COPILOT_CLASSIC_PAT_ERROR };
    if (!SUPPORTED_PREFIXES.some((prefix) => token.startsWith(prefix)) || /\s/.test(token)) {
        return {
            ok: false,
            error: "A Copilot token is a GitHub OAuth token (gho_, from `gh auth token`), a GitHub App user token (ghu_) or a fine-grained PAT (github_pat_).",
        };
    }
    return { ok: true };
}

/**
 * The error for an LLM key that cannot work with `provider`, or null. Only
 * Copilot has a key shape worth checking before it is stored; an empty key
 * is left to the caller (it means "unchanged" or "none").
 */
export function llmKeyError(provider: string | null | undefined, key: string): string | null {
    if (provider !== COPILOT_PROVIDER || !key.trim()) return null;
    const checked = checkCopilotToken(key);
    return checked.ok ? null : checked.error;
}

type PricedModel = { provider: string; model: string; label: string; inputPricePer1k: number; outputPricePer1k: number; active?: boolean };

/**
 * The model choices for an agent on `provider`. Copilot serves other vendors'
 * models under their own ids, so the priced catalog (one row per vendor) would
 * move the agent to that vendor: a Copilot agent picks from COPILOT_MODELS,
 * priced by a `copilot` pricing row when an admin added one, else free (the
 * subscription pays).
 */
export function modelOptionsFor<T extends PricedModel>(provider: string | null | undefined, pricing: T[]): PricedModel[] {
    if (provider !== COPILOT_PROVIDER) return pricing;
    return COPILOT_MODELS.map((model) => {
        const row = pricing.find((option) => option.provider === COPILOT_PROVIDER && option.model === model);
        return { provider: COPILOT_PROVIDER, model, label: row?.label || model, inputPricePer1k: row?.inputPricePer1k ?? 0, outputPricePer1k: row?.outputPricePer1k ?? 0, active: true };
    });
}

/** The provider a model pick leaves the agent on: a Copilot agent picking a Copilot model stays on Copilot. */
export function resolvePickedProvider(currentProvider: string | null | undefined, selection: { provider: string; model: string }): string {
    if (currentProvider === COPILOT_PROVIDER && isCopilotModel(selection.model)) return COPILOT_PROVIDER;
    return selection.provider;
}

/**
 * Whether the chosen model still fits after the provider changes to
 * `nextProvider`: a model priced for another vendor does not, except that
 * Copilot keeps any model it serves.
 */
export function modelFitsProvider(nextProvider: string | null | undefined, model: string | null | undefined, pricing: { provider: string; model: string }[]): boolean {
    if (!model) return true;
    if (nextProvider === COPILOT_PROVIDER) return isCopilotModel(model);
    const priced = pricing.find((option) => option.model === model);
    return !priced || priced.provider === nextProvider;
}
