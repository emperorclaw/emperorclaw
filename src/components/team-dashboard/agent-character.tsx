import { CharacterAvatar } from "@/components/character/character-avatar";
import type { SceneStatus } from "@/lib/team-scene";

export const STATUS_COLOR: Record<SceneStatus, string> = {
    working: "#38bdf8",
    waiting: "#fbbf24",
    blocked: "#fbbf24",
    idle: "#34d399",
    offline: "#64748b",
};

/**
 * Square avatar tile for cards and lists: the agent's uploaded photo, or the
 * shared drawn character from src/lib/character. Kept as a small named wrapper
 * so every dashboard surface renders the exact same avatar.
 */
export function AgentAvatar({ id, kind, name, avatarUrl, avatarAppearance, status = "idle", size = 32, className }: {
    id: string;
    kind: "agent" | "human";
    name: string;
    avatarUrl?: string | null;
    avatarAppearance?: unknown;
    status?: SceneStatus;
    size?: number;
    className?: string;
}) {
    return (
        <CharacterAvatar
            agentId={id}
            name={name}
            avatarUrl={avatarUrl}
            avatarAppearance={avatarAppearance}
            kind={kind === "human" ? "human" : undefined}
            status={status}
            size={size}
            className={className}
        />
    );
}
