import { NextRequest, NextResponse } from "next/server";
import { verifyMcpToken, resolveAgentId } from "@/lib/mcp";
import { createScopedResource } from "@/lib/resources";

function slugify(value: string) {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "draft-note";
}

function ensureDraftFrontmatter(input: { text: string; scopeType: string; owner: string }) {
  if (/^---\r?\n[\s\S]*?\r?\n---/.test(input.text)) return input.text;
  return `---\nscope: ${input.scopeType}\ntype: knowledge-note\nstatus: draft\nowner: ${input.owner || "agent"}\ntags:\n  - agent/draft\n---\n\n${input.text}`;
}

export async function POST(req: NextRequest) {
  const auth = await verifyMcpToken(req);
  if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const companyId = auth.companyToken!.companyId;
  const body = await req.json().catch(() => ({}));
  if (!body.title || typeof body.title !== "string") {
    return NextResponse.json({ error: "title is required" }, { status: 400 });
  }

  const scopeType = typeof body.scopeType === "string" ? body.scopeType : "company";
  const scopeId = scopeType === "agent" && body.scopeId ? await resolveAgentId(companyId, body.scopeId) : body.scopeId || null;
  const owner = typeof body.agentId === "string" ? body.agentId : "agent";
  const resource = await createScopedResource({
    companyId,
    scopeType,
    scopeId,
    provider: "knowledge",
    resourceType: "knowledge_base",
    name: slugify(body.title),
    displayName: body.title,
    configText: ensureDraftFrontmatter({
      text: body.proposedText || `# ${body.title}\n\nDraft reusable knowledge note.`,
      scopeType,
      owner,
    }),
    status: "active",
    ownership: "managed",
    isShared: false,
    changeSummary: "Created draft Company Brain note from legacy proposal endpoint",
    createdByType: "agent",
    createdById: body.agentId || null,
  });

  return NextResponse.json({
    resource,
    deprecated: true,
    message: "Proposal queues are deprecated. Created a draft Knowledge & Rules note instead.",
  }, { status: 201 });
}
