import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

/**
 * The agent profile lives in the Agents page panel. This route only keeps old
 * links working, so it forwards the tab a caller asked for: a failure entry
 * links to `/agents/<id>?tab=scope` and must still land on that section.
 */
export default async function AgentDetailPage({ params, searchParams }: {
    params: Promise<{ id: string }>;
    searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
    const { id } = await params;
    const { tab } = await searchParams;
    const requested = Array.isArray(tab) ? tab[0] : tab;
    const target = new URLSearchParams({ agent: id });
    if (requested) target.set("tab", requested);
    redirect(`/agents?${target.toString()}`);
}
