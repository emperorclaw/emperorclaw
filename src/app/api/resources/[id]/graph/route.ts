import { NextResponse } from "next/server";
import { listResourceGraph } from "@/lib/resources";
import { visibleResourceIds, memberResourceDenied } from "../../_shared";
import { companyRouteAccess } from "@/lib/company-access";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const access = await companyRouteAccess("viewer");
  if (access.response) return access.response;
  const membership = access.ctx;
  const { id } = await params;
  const denied = await memberResourceDenied(membership, id);
  if (denied) return denied;
  const graph = await listResourceGraph(membership.companyId, id);
  const visible = await visibleResourceIds(membership, graph.nodes.map((node) => node.id));
  if (!visible) return NextResponse.json(graph);
  return NextResponse.json({
    nodes: graph.nodes.filter((node) => visible.has(node.id)),
    edges: graph.edges.filter((edge) => visible.has(edge.source) && (!edge.target || visible.has(edge.target))),
  });
}
