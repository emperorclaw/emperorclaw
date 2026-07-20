import { NextRequest, NextResponse } from "next/server";
import { verifyMcpToken } from "@/lib/mcp";
import { PROVIDER_DOCS, PROVIDER_INDEX } from "@/lib/llm-config-docs";

export const dynamic = "force-dynamic";

/**
 * GET /api/mcp/llms/agent-configuration
 *
 * PaperClip-style self-documenting endpoint. Returns:
 * - Without ?provider=: an index of all supported providers
 * - With ?provider=openai: full configuration docs for that provider (plain text)
 * - With ?format=txt: plain text (for bridges/CLI)
 * - Default format: JSON
 *
 * API keys are NEVER returned — only documentation about which env var to set.
 * Secrets live in the agent runtime (Hermes), not in EmperorClaw.
 */
export async function GET(req: NextRequest) {
    const auth = await verifyMcpToken(req);
    if (auth.error) {
        return NextResponse.json({ error: auth.error }, { status: auth.status });
    }

    const { searchParams } = new URL(req.url);
    const provider = searchParams.get("provider")?.toLowerCase().trim();
    const format = searchParams.get("format")?.toLowerCase() === "txt" ? "txt" : "json";

    // Return specific provider docs
    if (provider) {
        const doc = PROVIDER_DOCS[provider];
        if (!doc) {
            return NextResponse.json(
                { error: `Unknown provider: ${provider}. Available: ${Object.keys(PROVIDER_DOCS).join(", ")}` },
                { status: 404 },
            );
        }

        if (format === "txt") {
            return new NextResponse(doc.docs, {
                headers: { "Content-Type": "text/plain; charset=utf-8" },
            });
        }

        return NextResponse.json({
            provider,
            label: doc.label,
            envVar: doc.envVar,
            docs: doc.docs,
        });
    }

    // Return provider index
    if (format === "txt") {
        const lines = PROVIDER_INDEX.map(
            (p) => `- ${p.id} (${p.label}): set ${p.envVar} in your agent runtime environment`,
        );
        const header = [
            "# LLM Agent Configuration",
            "",
            "API keys are managed in the agent runtime (Hermes), not stored in EmperorClaw.",
            "EmperorClaw only stores the provider choice as metadata.",
            "",
            "Available providers:",
            ...lines,
            "",
            "For per-provider details: GET /api/mcp/llms/agent-configuration?provider=<id>&format=txt",
        ].join("\n");

        return new NextResponse(header, {
            headers: { "Content-Type": "text/plain; charset=utf-8" },
        });
    }

    return NextResponse.json({
        providers: PROVIDER_INDEX,
        note: "API keys are managed in the agent runtime, not stored in EmperorClaw. Use ?provider=<id>&format=txt for per-provider docs.",
    });
}
