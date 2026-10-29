"use client";

import { useMemo } from "react";
import { useFormatter, useTranslations } from "next-intl";
import { sentenceCase, type BoardColumnKey, type CardSignal, type PriorityLevel, type ReviewBucket } from "@/lib/project-board-model";

/**
 * Translated labels for the projects board. The English copy lives in
 * messages/en.json (`tasks.*`, `projects.*`) and is kept equal to the labels
 * in lib/project-board-model.ts by tests/unit/i18n-parity.test.ts; the values
 * sent to the API (states, statuses, work types) stay as they are.
 */

export const TASK_STATES = ["inbox", "in_progress", "review", "blocked", "done", "failed", "dead_letter"] as const;
export const PROJECT_STATUSES = ["active", "paused", "completed", "killed"] as const;
export const WORK_TYPES = ["manual_task", "research", "implementation", "review", "outreach", "reporting"] as const;

/** Priority choices offered in menus and forms; `tone` names the label (tasks.priority.<tone>). */
export const PRIORITY_CHOICES = [
    { value: 0, tone: "none" },
    { value: 25, tone: "low" },
    { value: 50, tone: "medium" },
    { value: 75, tone: "high" },
    { value: 100, tone: "critical" },
] as const;

const isOneOf = <T extends string>(list: readonly T[], value: unknown): value is T => typeof value === "string" && (list as readonly string[]).includes(value);

export function useBoardLabels() {
    const t = useTranslations("tasks");
    const tp = useTranslations("projects");
    return useMemo(() => ({
        /** A task state ("in_progress" → "In progress"); unknown states are sentence-cased. */
        state: (state: unknown) => isOneOf(TASK_STATES, state) ? t(`states.${state}`) : sentenceCase(state),
        projectStatus: (status: unknown) => isOneOf(PROJECT_STATUSES, status) ? tp(`statuses.${status}`) : sentenceCase(status),
        column: (key: BoardColumnKey) => t(`columns.${key}`),
        reviewBucket: (bucket: ReviewBucket) => t(`reviewBuckets.${bucket}`),
        signal: (signal: CardSignal) => t(`signals.${signal}`),
        priority: (tone: PriorityLevel["tone"] | "none") => t(`priority.${tone}`),
        workType: (value: unknown) => isOneOf(WORK_TYPES, value) ? t(`workTypes.${value}`) : sentenceCase(value) || t("workTypes.manual_task"),
    }), [t, tp]);
}

/** "Oct 29, 14:05" in the person's language and time zone. */
export function useShortDateTime() {
    const format = useFormatter();
    return useMemo(() => (value: string | Date) => format.dateTime(new Date(value), { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }), [format]);
}
