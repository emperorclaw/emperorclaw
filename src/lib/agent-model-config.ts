export type ModelPricingIdentity = {
    provider: string;
    model: string;
};

export type AgentModelConfiguration = {
    llmProvider: string | null;
    llmModel: string | null;
};

/**
 * Resolve a partial model update into a coherent provider/model pair.
 *
 * - A known model carries its provider with it.
 * - Changing only the provider clears a known incompatible model.
 * - Unknown/custom models remain supported for self-hosted installations.
 * - Undefined means "leave unchanged"; an empty string explicitly clears.
 */
export function resolveAgentModelConfiguration({
    current,
    provider,
    model,
    pricing,
}: {
    current: AgentModelConfiguration;
    provider?: string | null;
    model?: string | null;
    pricing: ModelPricingIdentity[];
}): AgentModelConfiguration {
    const providerProvided = provider !== undefined;
    const modelProvided = model !== undefined;
    let llmProvider = providerProvided ? normalizeOptional(provider) : current.llmProvider;
    let llmModel = modelProvided ? normalizeOptional(model) : current.llmModel;

    if (modelProvided && llmModel) {
        const matches = pricing.filter((row) => row.model === llmModel);
        const exact = llmProvider
            ? matches.find((row) => row.provider === llmProvider)
            : undefined;
        const resolved = exact || (matches.length === 1 ? matches[0] : undefined);
        if (resolved) llmProvider = resolved.provider;
    } else if (providerProvided && !modelProvided && llmModel && llmProvider) {
        const configured = pricing.find((row) => row.model === llmModel);
        if (configured && configured.provider !== llmProvider) llmModel = null;
    }

    return { llmProvider, llmModel };
}

function normalizeOptional(value: string | null | undefined): string | null {
    if (typeof value !== "string") return null;
    const normalized = value.trim();
    return normalized || null;
}
