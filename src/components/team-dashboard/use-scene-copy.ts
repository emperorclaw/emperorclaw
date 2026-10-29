import { useMemo } from "react";
import { useTranslations } from "next-intl";
import type { AttentionKind, SceneStatus, ZoneId } from "@/lib/team-scene";
import { TASK_STATES } from "@/lib/task-state";
import { SCENE_CAPTION_KEYS, SCENE_CAPTION_PREFIXES } from "./scene-copy-keys";

/**
 * Translated scene words for the dashboard: status labels, zone names, inbox
 * kinds and the captions the scene libraries produce in English. Anything
 * the map does not know (a live activity line, a task title) passes through.
 */
export function useSceneCopy() {
    const t = useTranslations("scene");
    return useMemo(() => ({
        status: (status: SceneStatus) => t(`status.${status}`),
        zone: (zone: ZoneId) => t(`zones.${zone}`),
        kind: (kind: AttentionKind) => t(`kind.${kind}`),
        /** A task's state in words ("in progress"); an unknown state reads as itself. */
        taskState: (state: string) => (Object.values(TASK_STATES) as string[]).includes(state)
            ? t(`taskState.${state as (typeof TASK_STATES)[keyof typeof TASK_STATES]}`)
            : state.replaceAll("_", " "),
        caption: (text: string): string => {
            const key = (SCENE_CAPTION_KEYS as Record<string, (typeof SCENE_CAPTION_KEYS)[keyof typeof SCENE_CAPTION_KEYS]>)[text];
            if (key) return t(`caption.${key}`);
            for (const { prefix, key: prefixKey } of SCENE_CAPTION_PREFIXES) {
                if (!text.startsWith(prefix)) continue;
                const detail = text.slice(prefix.length);
                if (prefixKey === "stuckReason") return t("caption.stuckReason", { reason: detail });
                if (prefixKey === "notStarted") return t("caption.notStarted", { task: detail });
                return t("caption.runningLate", { task: detail });
            }
            return text;
        },
    }), [t]);
}
