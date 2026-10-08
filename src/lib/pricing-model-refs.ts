/** Provider namespaces are aliases, never permission to guess a different model. */
export function pricingModelRefs(model: string): string[] {
    const refs = [model.trim()].filter(Boolean);
    let current = refs[0] ?? "";
    while (/^(models|openai|anthropic|google|deepseek|openrouter|xai)\//.test(current)) {
        current = current.slice(current.indexOf("/") + 1);
        if (current) refs.push(current);
    }
    return [...new Set(refs)];
}
