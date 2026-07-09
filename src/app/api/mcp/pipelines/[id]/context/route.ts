import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { pipelines } from "@/db/schema";
import { verifyMcpToken } from "@/lib/mcp";
import { buildPipelineContextParams } from "@/lib/pipelines";
import { resolveCompanyBrainContext } from "@/lib/resources";
import { and, eq, isNull } from "drizzle-orm";

// GET /api/mcp/pipelines/[id]/context — resolve the Company Brain Context Pack for one pipeline.
export async function GET(
    req: NextRequest,
    { params }: { params: Promise<{ id: string }> }
) {
    const auth = await verifyMcpToken(req);
    if (auth.error) {
        return NextResponse.json({ error: auth.error }, { status: auth.status });
    }

    const companyId = auth.companyToken!.companyId;
    const { id } = await params;

    const [pipeline] = await db.select().from(pipelines).where(
        and(eq(pipelines.id, id), eq(pipelines.companyId, companyId), isNull(pipelines.deletedAt))
    ).limit(1);

    if (!pipeline) {
        return NextResponse.json({ error: "Pipeline not found" }, { status: 404 });
    }

    const context = await resolveCompanyBrainContext({
        companyId,
        ...buildPipelineContextParams(pipeline),
    });

    return NextResponse.json({
        pipelineId: pipeline.id,
        pipelineName: pipeline.name,
        contextQuery: pipeline.contextQuery,
        context,
        sourceIds: context.sources.map((source) => source.id),
    });
}
