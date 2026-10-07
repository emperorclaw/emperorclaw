import type { CharacterExpression, CharacterMood } from "@/lib/character/draw";
import { tileNode, figureNodes, type FigureOptions } from "@/lib/character/draw";
import {
    appearanceHash, resolveAppearance, resolveAvatarPhoto,
    type CharacterAppearance, type CharacterKind,
} from "@/lib/character/model";
import type { SceneStatus } from "@/lib/team-scene";
import { cn } from "@/lib/utils";
import { SvgNodeView } from "./svg-node";

export function moodForStatus(status: SceneStatus | undefined): CharacterMood {
    if (status === "offline") return "offline";
    if (status === "blocked" || status === "waiting") return "busy";
    return "online";
}

function prefixFor(appearance: CharacterAppearance, salt: string): string {
    return `ch-${appearanceHash(appearance)}-${salt}`;
}

/** The full figure used by the office scene. */
export function CharacterFigureView({ appearance, mood = "online", seated = true, salt = "f", expression, className }: {
    appearance: CharacterAppearance;
    mood?: CharacterMood;
    expression?: CharacterExpression;
    seated?: boolean;
    salt?: string;
    className?: string;
}) {
    const options: FigureOptions = { idPrefix: prefixFor(appearance, salt), mood, seated, expression };
    return <g className={className}>{figureNodes(appearance, options).map((node, i) => <SvgNodeView key={i} node={node} />)}</g>;
}

/** Square avatar tile: the uploaded photo when present, else our character. */
export function CharacterAvatar({ agentId, name, avatarUrl, avatarAppearance, kind, size = 32, status, className, decorative = false }: {
    agentId: string;
    name: string;
    avatarUrl?: string | null;
    avatarAppearance?: unknown;
    kind?: CharacterKind;
    size?: number;
    status?: SceneStatus;
    className?: string;
    decorative?: boolean;
}) {
    const photo = resolveAvatarPhoto({ avatarUrl });
    if (photo) {
        return (
            // eslint-disable-next-line @next/next/no-img-element
            <img
                src={photo}
                alt={decorative ? "" : name}
                width={size}
                height={size}
                className={cn("shrink-0 rounded-[30%] bg-slate-900 object-cover ring-1 ring-white/10", className)}
                style={{ width: size, height: size }}
            />
        );
    }
    const appearance = resolveAppearance({ id: agentId, avatarUrl, avatarAppearance, kind });
    const node = tileNode(appearance, { size, idPrefix: prefixFor(appearance, "t"), label: decorative ? undefined : name, mood: moodForStatus(status) });
    return <span className={cn("inline-flex shrink-0 overflow-hidden rounded-[30%] ring-1 ring-white/10", className)} style={{ width: size, height: size }}><SvgNodeView node={node} /></span>;
}
