// Shared MCP tool-result helpers. Every registered tool handler returns
// through one of these so results are formatted consistently (JSON text
// content block) and errors surface as MCP tool errors (isError: true)
// rather than throwing, which would otherwise crash the whole request.

export function jsonResult(data: unknown) {
    return {
        content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
    };
}

export function errorResult(error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return {
        content: [{ type: "text" as const, text: message }],
        isError: true,
    };
}
