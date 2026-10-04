import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

/**
 * The agent profile lives in the Agents page panel (memory, instructions,
 * scope, chat, runs). This route only keeps old links working.
 */
export default async function AgentDetailPage({ params }: { params: Promise<{ id: string }> }) {
    const { id } = await params;
    redirect(`/agents?agent=${encodeURIComponent(id)}`);
}
