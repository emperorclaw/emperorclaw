"use client";

import { useEffect, useMemo, useState } from "react";
import { useFormatter, useLocale, useTranslations } from "next-intl";
import { IconArrowDown, IconArrowUp, IconPlus, IconTrash } from "@tabler/icons-react";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { Textarea } from "@/components/ui/textarea";
import { describeCron, isValidCron, MIN_EMPEROR_INTERVAL_MINUTES, shortestCronGapMinutes } from "@/lib/pipeline-schedule";
import {
  cronToPreset, formatTimeOfDay, hasDayOfMonthStep, nextCronRuns, parseTimeOfDay, presetToCron, timeZoneOptions, WEEK_DAYS,
  type SchedulePreset, type SchedulePresetKind,
} from "@/lib/schedule-presets";
import { cn } from "@/lib/utils";
import type { AgentOption, AutomationRow } from "./automation-parts";

type T = ReturnType<typeof useTranslations<"pipelines">>;

/** The fields of an automation the editor changes (the page row has them all). */
export type EditableAutomation = AutomationRow & {
  purpose: string | null;
  docMarkdown: string | null;
  stepsJson: unknown;
  contextQuery: string | null;
  contextTagFilters: string[] | null;
  contextMaxChars: number | null;
};

type StepDraft = { key: string; name: string; description: string; agentRef: string; gate: boolean; taskType?: string };

const PRESET_KINDS: SchedulePresetKind[] = ["hourly", "daily", "weekdays", "custom"];

let stepKeySeed = 0;
const nextStepKey = () => `step-${++stepKeySeed}`;

function stepsFrom(value: unknown): StepDraft[] {
  if (!Array.isArray(value)) return [];
  return value.filter((raw): raw is Record<string, unknown> => typeof raw === "object" && raw !== null).map((raw) => ({
    key: nextStepKey(),
    name: typeof raw.name === "string" ? raw.name : typeof raw.title === "string" ? raw.title : "",
    description: typeof raw.description === "string" ? raw.description : "",
    agentRef: typeof raw.agentRef === "string" ? raw.agentRef : "",
    gate: raw.gate === true,
    ...(typeof raw.taskType === "string" ? { taskType: raw.taskType } : {}),
  }));
}

/** Steps as the API stores them (empty optional fields left out). */
function stepsPayload(steps: StepDraft[]) {
  return steps.map((step) => ({
    name: step.name.trim(),
    ...(step.agentRef.trim() ? { agentRef: step.agentRef.trim() } : {}),
    ...(step.taskType ? { taskType: step.taskType } : {}),
    ...(step.description.trim() ? { description: step.description.trim() } : {}),
    gate: step.gate,
  }));
}

/** Steps as stored, normalized the same way, to tell whether anything changed. */
function storedStepsPayload(value: unknown) {
  return stepsPayload(stepsFrom(value));
}

function browserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

const tagsText = (tags: string[] | null | undefined) => (Array.isArray(tags) ? tags.join(", ") : "");
const tagsList = (text: string) => text.split(",").map((tag) => tag.trim().replace(/^#/, "")).filter(Boolean);

function Field({ label, hint, children, htmlFor }: { label: string; hint?: string; children: React.ReactNode; htmlFor?: string }) {
  return (
    <div className="space-y-1.5">
      <label htmlFor={htmlFor} className="block text-xs font-medium text-zinc-400">{label}</label>
      {children}
      {hint ? <p className="text-xs leading-5 text-zinc-500">{hint}</p> : null}
    </div>
  );
}

/** Mon … Sun in the viewer's language (2024-01-07 was a Sunday). */
function weekdayLabel(format: ReturnType<typeof useFormatter>, day: number) {
  return format.dateTime(new Date(Date.UTC(2024, 0, 7 + day, 12)), { weekday: "short", timeZone: "UTC" });
}

/** When it runs: preset builder (or custom cron), time zone and a live preview of the next runs. */
function ScheduleBuilder({ preset, onPreset, timezone, onTimezone, zones }: {
  preset: SchedulePreset;
  onPreset: (preset: SchedulePreset) => void;
  timezone: string;
  onTimezone: (zone: string) => void;
  zones: string[];
}) {
  const t = useTranslations("pipelines");
  const format = useFormatter();
  const locale = useLocale();
  const cron = presetToCron(preset);
  const readable = isValidCron(cron);
  const description = readable ? describeCron(cron, locale) : null;
  const gap = readable ? shortestCronGapMinutes(cron, timezone) : null;
  const tooOften = gap !== null && gap < MIN_EMPEROR_INTERVAL_MINUTES;
  const upcoming = readable ? nextCronRuns(cron, timezone, 3) : [];
  const zoneOptions = useMemo(() => zones.map((zone) => ({ value: zone, label: zone.replace(/_/g, " ") })), [zones]);

  const hour = "hour" in preset ? preset.hour : 9;
  const minute = "minute" in preset ? preset.minute : 0;
  const setKind = (kind: SchedulePresetKind) => {
    if (kind === preset.kind) return;
    if (kind === "hourly") onPreset({ kind, minute });
    else if (kind === "daily") onPreset({ kind, hour, minute });
    else if (kind === "weekdays") onPreset({ kind, days: preset.kind === "weekdays" ? preset.days : [1, 2, 3, 4, 5], hour, minute });
    else onPreset({ kind, cron });
  };
  const timeValue = formatTimeOfDay(hour, minute);
  const onTime = (value: string) => {
    const parsed = parseTimeOfDay(value);
    if (!parsed || preset.kind === "hourly" || preset.kind === "custom") return;
    onPreset({ ...preset, ...parsed });
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2" role="radiogroup" aria-label={t("edit.repeat")}>
        {PRESET_KINDS.map((kind) => (
          <button
            key={kind}
            type="button"
            role="radio"
            aria-checked={preset.kind === kind}
            onClick={() => setKind(kind)}
            className={cn(
              "cursor-pointer rounded-full border px-3 py-1 text-xs font-medium transition-colors",
              preset.kind === kind ? "border-cyan-400/50 bg-cyan-400/10 text-cyan-100" : "border-zinc-800 text-zinc-400 hover:border-zinc-700 hover:text-zinc-200",
            )}
          >
            {t(`edit.presets.${kind}`)}
          </button>
        ))}
      </div>

      {preset.kind === "hourly" ? (
        <Field label={t("edit.minute")} htmlFor="automation-minute">
          <Input
            id="automation-minute"
            type="number"
            min={0}
            max={59}
            value={preset.minute}
            onChange={(event) => onPreset({ kind: "hourly", minute: Math.min(59, Math.max(0, Number(event.target.value) || 0)) })}
            className="w-28"
          />
        </Field>
      ) : null}

      {preset.kind === "weekdays" ? (
        <Field label={t("edit.days")}>
          <div className="flex flex-wrap gap-1.5">
            {WEEK_DAYS.map((day) => {
              const on = preset.days.includes(day);
              return (
                <button
                  key={day}
                  type="button"
                  aria-pressed={on}
                  onClick={() => onPreset({ ...preset, days: on ? preset.days.filter((d) => d !== day) : [...preset.days, day] })}
                  className={cn(
                    "min-w-11 cursor-pointer rounded-lg border px-2 py-1.5 text-xs font-medium transition-colors",
                    on ? "border-cyan-400/50 bg-cyan-400/10 text-cyan-100" : "border-zinc-800 text-zinc-400 hover:border-zinc-700",
                  )}
                >
                  {weekdayLabel(format, day)}
                </button>
              );
            })}
          </div>
        </Field>
      ) : null}

      {preset.kind === "daily" || preset.kind === "weekdays" ? (
        <Field label={t("edit.time")} htmlFor="automation-time">
          <Input id="automation-time" type="time" value={timeValue} onChange={(event) => onTime(event.target.value)} className="w-36" />
        </Field>
      ) : null}

      {preset.kind === "custom" ? (
        <Field label={t("edit.cron")} hint={t("edit.cronHint")} htmlFor="automation-cron">
          <Input
            id="automation-cron"
            value={preset.cron}
            onChange={(event) => onPreset({ kind: "custom", cron: event.target.value })}
            className="font-mono"
            spellCheck={false}
            autoComplete="off"
          />
          {hasDayOfMonthStep(preset.cron) ? (
            <p role="alert" className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-2.5 text-xs leading-5 text-amber-200">{t("edit.dayStepWarning")}</p>
          ) : null}
        </Field>
      ) : null}

      <Field label={t("edit.timezone")}>
        <SearchableSelect value={timezone} options={zoneOptions} placeholder={t("edit.timezone")} searchPlaceholder={t("edit.timezoneSearch")} onChange={onTimezone} className="w-full" />
      </Field>

      <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-3 text-sm" aria-live="polite">
        {!readable ? (
          <p role="alert" className="text-red-400">{t("edit.invalidCron")}</p>
        ) : (
          <>
            <p className="text-zinc-100">{description ?? cron}</p>
            <p className="mt-0.5 font-mono text-xs text-zinc-500">{cron}</p>
            {tooOften ? <p role="alert" className="mt-2 text-amber-300">{t("edit.tooOften", { minutes: MIN_EMPEROR_INTERVAL_MINUTES })}</p> : null}
            {upcoming.length > 0 ? (
              <div className="mt-2">
                <div className="text-xs uppercase tracking-wider text-zinc-500">{t("edit.preview")}</div>
                <ul className="mt-1 space-y-0.5 text-xs text-zinc-300">
                  {upcoming.map((date) => (
                    <li key={date.toISOString()}>{format.dateTime(date, { dateStyle: "full", timeStyle: "short", timeZone: timezone })}</li>
                  ))}
                </ul>
              </div>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}

/** The steps: add, remove, reorder, name, description, agent and the approval gate. */
function StepsEditor({ steps, onChange, agents }: { steps: StepDraft[]; onChange: (steps: StepDraft[]) => void; agents: AgentOption[] }) {
  const t = useTranslations("pipelines");
  const update = (index: number, patch: Partial<StepDraft>) => onChange(steps.map((step, i) => (i === index ? { ...step, ...patch } : step)));
  const move = (index: number, by: -1 | 1) => {
    const next = [...steps];
    const [step] = next.splice(index, 1);
    next.splice(index + by, 0, step);
    onChange(next);
  };
  const agentOptions = (current: string) => {
    const options = [{ value: "", label: t("edit.stepAnyAgent") }, ...agents.map((agent) => ({ value: agent.name, label: agent.name }))];
    return current && !options.some((option) => option.value === current) ? [...options, { value: current, label: current }] : options;
  };

  return (
    <div className="space-y-2">
      {steps.length === 0 ? <p className="rounded-xl border border-dashed border-zinc-700 p-3 text-sm text-zinc-500">{t("edit.noSteps")}</p> : null}
      <ol className="space-y-2">
        {steps.map((step, index) => (
          <li key={step.key} className="space-y-2 rounded-xl border border-zinc-800 bg-zinc-900/30 p-3">
            <div className="flex items-center gap-2">
              <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-zinc-800 text-xs text-zinc-400">{index + 1}</span>
              <Input
                value={step.name}
                maxLength={120}
                placeholder={t("edit.stepName")}
                aria-label={t("edit.stepNameN", { n: index + 1 })}
                onChange={(event) => update(index, { name: event.target.value })}
                className="h-9 min-w-0 flex-1"
              />
              <Button type="button" variant="ghost" size="icon-sm" disabled={index === 0} aria-label={t("edit.moveUp", { n: index + 1 })} onClick={() => move(index, -1)}>
                <IconArrowUp className="h-4 w-4" />
              </Button>
              <Button type="button" variant="ghost" size="icon-sm" disabled={index === steps.length - 1} aria-label={t("edit.moveDown", { n: index + 1 })} onClick={() => move(index, 1)}>
                <IconArrowDown className="h-4 w-4" />
              </Button>
              <Button type="button" variant="ghost" size="icon-sm" aria-label={t("edit.removeStep", { n: index + 1 })} onClick={() => onChange(steps.filter((_, i) => i !== index))}>
                <IconTrash className="h-4 w-4" />
              </Button>
            </div>
            <Textarea
              value={step.description}
              maxLength={500}
              rows={2}
              placeholder={t("edit.stepDescription")}
              aria-label={t("edit.stepDescriptionN", { n: index + 1 })}
              onChange={(event) => update(index, { description: event.target.value })}
            />
            <div className="flex flex-wrap items-center gap-3">
              <SearchableSelect
                value={step.agentRef}
                options={agentOptions(step.agentRef)}
                placeholder={t("edit.stepAnyAgent")}
                searchPlaceholder={t("runner.search")}
                onChange={(value) => update(index, { agentRef: value })}
                className="min-w-0 flex-1 sm:max-w-64"
              />
              <label className="inline-flex cursor-pointer items-center gap-2 text-xs text-zinc-300">
                <input type="checkbox" className="accent-cyan-400" checked={step.gate} onChange={(event) => update(index, { gate: event.target.checked })} />
                {t("edit.stepGate")}
              </label>
            </div>
          </li>
        ))}
      </ol>
      <Button type="button" variant="outline" size="sm" disabled={steps.length >= 50} onClick={() => onChange([...steps, { key: nextStepKey(), name: "", description: "", agentRef: "", gate: false }])}>
        <IconPlus className="h-4 w-4" />{t("edit.addStep")}
      </Button>
    </div>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return <h3 className="text-xs font-bold uppercase tracking-[0.22em] text-zinc-500">{children}</h3>;
}

type Draft = {
  scheduled: boolean;
  preset: SchedulePreset;
  timezone: string;
  purpose: string;
  docMarkdown: string;
  steps: StepDraft[];
  contextQuery: string;
  contextTags: string;
  contextMaxChars: string;
};

function draftFrom(pipeline: EditableAutomation): Draft {
  const cron = pipeline.trigger === "cron" ? pipeline.schedule?.cron ?? (typeof pipeline.triggerConfig?.cron === "string" ? pipeline.triggerConfig.cron : null) : null;
  return {
    scheduled: pipeline.trigger === "cron",
    preset: cron ? cronToPreset(cron) : { kind: "daily", hour: 9, minute: 0 },
    timezone: pipeline.schedule?.timezone || (typeof pipeline.triggerConfig?.timezone === "string" ? pipeline.triggerConfig.timezone : null) || browserTimeZone(),
    purpose: pipeline.purpose ?? "",
    docMarkdown: pipeline.docMarkdown ?? "",
    steps: stepsFrom(pipeline.stepsJson),
    contextQuery: pipeline.contextQuery ?? "",
    contextTags: tagsText(pipeline.contextTagFilters),
    contextMaxChars: String(pipeline.contextMaxChars ?? 8000),
  };
}

/** The PATCH body for what changed (an empty object when nothing did). */
function changesOf(pipeline: EditableAutomation, original: Draft, draft: Draft): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (pipeline.trigger !== "event") {
    const cron = presetToCron(draft.preset).replace(/\s+/g, " ");
    const scheduleMoved = draft.scheduled !== original.scheduled
      || (draft.scheduled && (cron !== presetToCron(original.preset).replace(/\s+/g, " ") || draft.timezone !== original.timezone));
    if (scheduleMoved) body.schedule = draft.scheduled ? { cron, timezone: draft.timezone } : null;
  }
  if (draft.purpose.trim() !== original.purpose.trim()) body.purpose = draft.purpose;
  if (draft.docMarkdown.trim() !== original.docMarkdown.trim()) body.docMarkdown = draft.docMarkdown;
  const steps = stepsPayload(draft.steps);
  if (JSON.stringify(steps) !== JSON.stringify(storedStepsPayload(pipeline.stepsJson))) body.steps = steps;
  if (draft.contextQuery.trim() !== original.contextQuery.trim()) body.contextQuery = draft.contextQuery;
  if (JSON.stringify(tagsList(draft.contextTags)) !== JSON.stringify(tagsList(original.contextTags))) body.contextTagFilters = tagsList(draft.contextTags);
  const budget = Number(draft.contextMaxChars);
  if (draft.contextMaxChars.trim() && Number.isFinite(budget) && budget !== Number(original.contextMaxChars)) body.contextMaxChars = budget;
  return body;
}

/** Why the draft can't be saved yet, else null. */
function draftProblem(t: T, draft: Draft): string | null {
  if (draft.steps.some((step) => !step.name.trim())) return t("edit.stepNameRequired");
  if (draft.scheduled) {
    const cron = presetToCron(draft.preset);
    if (!isValidCron(cron)) return t("edit.invalidCron");
    if (draft.preset.kind === "weekdays" && draft.preset.days.length === 0) return t("edit.pickDays");
    const gap = shortestCronGapMinutes(cron, draft.timezone);
    if (gap !== null && gap < MIN_EMPEROR_INTERVAL_MINUTES) return t("edit.tooOften", { minutes: MIN_EMPEROR_INTERVAL_MINUTES });
  }
  return null;
}

/**
 * Edit an automation: when it runs (a preset or a custom cron, in a time zone,
 * with the next runs previewed) and what it does (purpose, documentation,
 * steps, Context Pack). Only what changed is sent; the server makes those
 * fields operator-owned, lets Emperor keep a schedule set here, and tells the
 * runner agent what changed. The name is the agent's key and stays read-only.
 */
export function EditAutomationDialog({ pipeline, agents, open, onClose, onSaved }: {
  pipeline: EditableAutomation | null;
  agents: AgentOption[];
  open: boolean;
  onClose: () => void;
  onSaved: (updated: Record<string, unknown>, notified: boolean) => void;
}) {
  const t = useTranslations("pipelines");
  const tc = useTranslations("common");
  const [original, setOriginal] = useState<Draft | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDiscard, setConfirmDiscard] = useState(false);

  // A fresh draft each time the dialog opens (not on every server refresh while open).
  useEffect(() => {
    if (!open || !pipeline) return;
    const initial = draftFrom(pipeline);
    setOriginal(initial);
    setDraft(initial);
    setError(null);
    setBusy(false);
    setConfirmDiscard(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, pipeline?.id]);

  const zones = useMemo(() => timeZoneOptions([draft?.timezone, original?.timezone, browserTimeZone()]), [draft?.timezone, original?.timezone]);
  if (!pipeline || !draft || !original) return null;

  const changes = changesOf(pipeline, original, draft);
  const dirty = Object.keys(changes).length > 0;
  const problem = draftProblem(t, draft);
  const set = (patch: Partial<Draft>) => setDraft((current) => (current ? { ...current, ...patch } : current));
  const requestClose = () => {
    if (busy) return;
    if (dirty) setConfirmDiscard(true);
    else onClose();
  };

  const save = async () => {
    if (!dirty || problem) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/pipelines/${pipeline.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(changes),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(typeof data?.error === "string" ? data.error : t("edit.failed"));
        return;
      }
      onSaved(data.pipeline as Record<string, unknown>, data.agentNotified === true);
    } catch {
      setError(t("edit.failed"));
    } finally {
      setBusy(false);
    }
  };

  const agentScheduled = pipeline.trigger === "cron" && pipeline.scheduledBy !== "emperor";
  const scheduleTouched = "schedule" in changes && draft.scheduled;

  return (
    <>
      <Dialog open={open} onOpenChange={(next) => { if (!next) requestClose(); }}>
        <DialogContent className="flex max-h-[90dvh] flex-col overflow-hidden sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{t("edit.title", { name: pipeline.name })}</DialogTitle>
            <DialogDescription>{t("edit.description")}</DialogDescription>
          </DialogHeader>

          <div className="-mx-6 min-h-0 flex-1 space-y-6 overflow-y-auto px-6 pb-1">
            <Field label={t("edit.nameLabel")} hint={t("edit.nameHint")} htmlFor="automation-name">
              <Input id="automation-name" value={pipeline.name} readOnly disabled />
            </Field>

            <section className="space-y-3">
              <SectionTitle>{t("edit.whenSection")}</SectionTitle>
              {pipeline.trigger === "event" ? (
                <p className="text-sm text-zinc-400">{t("edit.eventTrigger")}</p>
              ) : (
                <>
                  <div className="flex flex-wrap gap-2" role="radiogroup" aria-label={t("edit.whenSection")}>
                    {([true, false] as const).map((value) => (
                      <button
                        key={String(value)}
                        type="button"
                        role="radio"
                        aria-checked={draft.scheduled === value}
                        onClick={() => set({ scheduled: value })}
                        className={cn(
                          "cursor-pointer rounded-xl border px-3 py-2 text-sm transition-colors",
                          draft.scheduled === value ? "border-cyan-400/40 bg-cyan-400/10 text-cyan-100" : "border-zinc-800 text-zinc-400 hover:border-zinc-700",
                        )}
                      >
                        {value ? t("edit.scheduleOn") : t("edit.scheduleOff")}
                      </button>
                    ))}
                  </div>
                  {draft.scheduled ? (
                    <ScheduleBuilder preset={draft.preset} onPreset={(preset) => set({ preset })} timezone={draft.timezone} onTimezone={(timezone) => set({ timezone })} zones={zones} />
                  ) : null}
                  {agentScheduled && scheduleTouched ? (
                    <p role="note" className="rounded-lg border border-cyan-500/25 bg-cyan-500/[0.06] p-2.5 text-xs leading-5 text-cyan-100">{t("edit.agentScheduledNote")}</p>
                  ) : null}
                </>
              )}
            </section>

            <section className="space-y-3">
              <SectionTitle>{t("edit.whatSection")}</SectionTitle>
              <Field label={t("edit.purpose")} htmlFor="automation-purpose">
                <Textarea id="automation-purpose" rows={2} maxLength={1000} value={draft.purpose} placeholder={t("edit.purposePlaceholder")} onChange={(event) => set({ purpose: event.target.value })} />
              </Field>
              <Field label={t("edit.docs")} htmlFor="automation-docs">
                <Textarea id="automation-docs" rows={8} value={draft.docMarkdown} placeholder={t("edit.docsPlaceholder")} onChange={(event) => set({ docMarkdown: event.target.value })} className="font-mono text-xs" />
              </Field>
              <Field label={t("edit.steps")}>
                <StepsEditor steps={draft.steps} onChange={(steps) => set({ steps })} agents={agents} />
              </Field>
            </section>

            <section className="space-y-3">
              <SectionTitle>{t("graph.contextPack")}</SectionTitle>
              <Field label={t("context.query")} htmlFor="automation-context-query">
                <Input id="automation-context-query" maxLength={500} value={draft.contextQuery} onChange={(event) => set({ contextQuery: event.target.value })} />
              </Field>
              <Field label={t("context.tags")} hint={t("edit.contextTagsHint")} htmlFor="automation-context-tags">
                <Input id="automation-context-tags" value={draft.contextTags} onChange={(event) => set({ contextTags: event.target.value })} />
              </Field>
              <Field label={t("edit.contextBudget")} htmlFor="automation-context-budget">
                <Input id="automation-context-budget" type="number" min={1000} max={24000} step={500} value={draft.contextMaxChars} onChange={(event) => set({ contextMaxChars: event.target.value })} className="w-36" />
              </Field>
            </section>
          </div>

          {error || (dirty && problem) ? <p role="alert" className="text-sm text-red-400">{error ?? problem}</p> : null}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={requestClose} disabled={busy}>{tc("cancel")}</Button>
            <Button type="button" onClick={save} disabled={busy || !dirty || Boolean(problem)}>
              {busy ? t("edit.saving") : t("edit.save")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <ConfirmDialog
        open={confirmDiscard}
        title={t("edit.discardTitle")}
        description={t("edit.discardDescription")}
        confirmLabel={t("edit.discard")}
        destructive
        onConfirm={() => { setConfirmDiscard(false); onClose(); }}
        onCancel={() => setConfirmDiscard(false)}
      />
    </>
  );
}
