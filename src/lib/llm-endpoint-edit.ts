/**
 * The agent panel's model endpoint editor: what an owner/admin's draft sends
 * to PATCH /api/agents/[id].
 *
 * The stored key only ever goes back to the endpoint it was given for, so
 * the server refuses a provider or base URL change without that endpoint's
 * key (`llmApiKey`), or `llmApiKey: null` for an endpoint without one. This
 * plans the same rule on the client, so the editor can ask for the key
 * before saving instead of failing with a 400.
 *
 * Pure and client-safe; the server validates everything again.
 */

import { CUSTOM_LLM_PROVIDER, normalizeLlmBaseUrl } from "./llm-endpoint";

export type LlmEndpointDraft = {
    /** The agent's saved provider ("" or null = none). */
    currentProvider: string | null | undefined;
    /** The provider picked in the editor ("" = none). */
    provider: string;
    /** Custom endpoints only. Blank keeps the saved base URL (when the agent already uses a custom endpoint). */
    baseUrl: string;
    apiKey: string;
    /** Custom endpoints only: the endpoint takes no key. */
    noKey: boolean;
    /** The model to save with it; undefined leaves the model to the server's provider/model rules. */
    model?: string;
};

export type LlmEndpointPlan = {
    /** The provider or base URL changes, so the stored key can't follow. */
    endpointChanged: boolean;
    /** The editor must show the key field. */
    keyRequired: boolean;
    /** Why the draft can't be saved yet, or null. */
    error: string | null;
    /** The PATCH body when there is no error. */
    fields: Record<string, unknown> | null;
    /** The loopback-to-Docker hint for a base URL that points at localhost. */
    baseUrlHint: string | null;
};

export function planLlmEndpointEdit(draft: LlmEndpointDraft): LlmEndpointPlan {
    const current = draft.currentProvider || "";
    const custom = draft.provider === CUSTOM_LLM_PROVIDER;
    const wasCustom = current === CUSTOM_LLM_PROVIDER;
    const baseUrlText = custom ? draft.baseUrl.trim() : "";
    const apiKey = draft.apiKey.trim();
    const model = draft.model?.trim();

    const endpointChanged = draft.provider !== current || baseUrlText !== "";
    const keyRequired = endpointChanged && draft.provider !== "";
    let baseUrl: string | null = null;
    let baseUrlHint: string | null = null;
    const fail = (error: string): LlmEndpointPlan => ({ endpointChanged, keyRequired, error, fields: null, baseUrlHint });

    if (baseUrlText) {
        const checked = normalizeLlmBaseUrl(baseUrlText);
        if (!checked.ok) return fail(checked.error);
        baseUrl = checked.url;
        baseUrlHint = checked.hint;
    } else if (custom && !wasCustom) {
        return fail("Enter the endpoint's base URL, for example http://host.docker.internal:11434/v1.");
    }
    if (custom && !wasCustom && !model) return fail("Enter the model name the endpoint serves, for example llama3.1:8b.");

    const keyless = custom && draft.noKey;
    if (keyRequired && !apiKey && !keyless) {
        return fail(custom
            ? "Enter the endpoint's API key, or choose that it needs no key."
            : "Enter the API key for the new provider: the saved key is never sent to a different endpoint.");
    }

    const fields: Record<string, unknown> = { llmProvider: draft.provider };
    if (model !== undefined) fields.llmModel = model;
    if (baseUrl) fields.llmBaseUrl = baseUrl;
    if (keyless && endpointChanged) fields.llmApiKey = null;
    else if (apiKey) fields.llmApiKey = apiKey;
    return { endpointChanged, keyRequired, error: null, fields, baseUrlHint };
}
