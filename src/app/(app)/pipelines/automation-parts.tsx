"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useFormatter, useTranslations } from "next-intl";
import { toast } from "sonner";
import { IconArrowsSplit, IconCalendarTime, IconCopy, IconExternalLink, IconPlayerPause, IconPlayerPlay, IconPlayerSkipForward, IconRobot, IconUser } from "@tabler/icons-react";
import { CharacterAvatar } from "@/components/character/character-avatar";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { SettingsSwitch } from "@/components/ui/settings-switch";
import { taskHref } from "@/lib/task-story";
import { pipelineRunDurationMs, pipelineRunOrigin } from "@/lib/pipelines";
import { cn } from "@/lib/utils";

export type AgentOption = {
  id: string;
  name: string;
  avatarUrl: string | null;
  avatarAppearance: unknown;
  budgetStatus: string;
};

export type ScheduleInfo = {
  cron: string | null;
  description: string | null;
  timezone: string;
  nextRunAt: string | null;
};

export type AutomationRow = {
  id: string;
  name: string;
  status: string;
  trigger: string;
  triggerConfig: Record<string, unknown> | null;
  ownerAgentId: string | null;
  scheduledBy: string;
  pausedReason?: string | null;
  createdByType: string;
  createdById: string | null;
  createdAt: string;
  lastRunAt: string | null;
  lastRunStatus: string | null;
  schedule: ScheduleInfo | null;
};

export type AutomationRun = {
  id: string;
  pipelineId: string;
  agentId: string | null;
  status: string;
  source: string | null;
  triggeredByType: string | null;
  triggeredById: string | null;
  summary: string | null;
  statsJson?: Record<string, unknown> | null;
  startedAt: string;
  endedAt: string | null;
};

type T = ReturnType<typeof useTranslations<"pipelines">>;

const RUN_STATUS_TEXT: Record<string, string> = {
  succeeded: "text-emerald-400",
  failed: "text-red-400",
  partial: "text-amber-400",
  running: "text-sky-400",
  skipped: "text-zinc-400",
};

const RUN_STATUS_DOT: Record<string, string> = {
  succeeded: "bg-emerald-400",
  failed: "bg-red-400",
  partial: "bg-amber-400",
  running: "bg-sky-400 animate-pulse",
  skipped: "bg-zinc-500",
};

const KNOWN_RUN_STATUSES = new Set(["succeeded", "failed", "partial", "running", "skipped"]);

export function runStatusText(t: T, status: string) {
  return KNOWN_RUN_STATUSES.has(status) ? t(`runStatuses.${status as "running"}`) : status;
}

export function RunStatusDot({ status }: { status: string }) {
  return <span aria-hidden className={cn("inline-block h-1.5 w-1.5 shrink-0 rounded-full", RUN_STATUS_DOT[status] || "bg-zinc-600")} />;
}

export function AgentChip({ agent, size = 20, className }: { agent: AgentOption | null | undefined; size?: number; className?: string }) {
  const t = useTranslations("pipelines");
  if (!agent) {
    return <span className={cn("inline-flex items-center gap-1.5 text-zinc-500", className)}><IconRobot className="h-3.5 w-3.5" />{t("runner.none")}</span>;
  }
  return (
    <span className={cn("inline-flex min-w-0 items-center gap-1.5", className)}>
      <CharacterAvatar agentId={agent.id} name={agent.name} avatarUrl={agent.avatarUrl} avatarAppearance={agent.avatarAppearance} size={size} decorative />
      <span className="truncate">{agent.name}</span>
    </span>
  );
}

function formatDuration(t: T, ms: number) {
  const totalMinutes = Math.floor(ms / 60_000);
  if (totalMinutes < 1) return t("duration.seconds", { count: Math.max(1, Math.round(ms / 1000)) });
  if (totalMinutes < 60) return t("duration.minutes", { count: totalMinutes });
  return t("duration.hours", { hours: Math.floor(totalMinutes / 60), minutes: totalMinutes % 60 });
}

/** "Run now · by Alex", "Agent · Quill", "Schedule", "Reported by Quill". */
export function runOriginText(t: T, run: AutomationRun, agentsMap: Record<string, string>, peopleMap: Record<string, string>) {
  const origin = pipelineRunOrigin(run);
  if (origin.kind === "legacy") {
    const name = origin.agentId ? agentsMap[origin.agentId] : null;
    return name ? t("origin.reportedBy", { name }) : t("origin.reportedByAgent");
  }
  if (origin.kind === "schedule") return t("origin.schedule");
  const name = origin.who ? (origin.who.type === "user" ? peopleMap[origin.who.id] : agentsMap[origin.who.id]) : null;
  if (!name) return t(`origin.${origin.kind}`);
  return t(`origin.${origin.kind}By`, { name });
}

function runTaskIdsOf(run: AutomationRun): string[] {
  const ids = (run.statsJson as { taskIds?: unknown } | null | undefined)?.taskIds;
  return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === "string") : [];
}

export function RunHistoryItem({ run, agentsMap, peopleMap, tasksMap, now }: {
  run: AutomationRun;
  agentsMap: Record<string, string>;
  peopleMap: Record<string, string>;
  tasksMap: Record<string, string>;
  now: number;
}) {
  const t = useTranslations("pipelines");
  const format = useFormatter();
  const duration = pipelineRunDurationMs(run, new Date(now));
  const taskIds = runTaskIdsOf(run);
  const skipped = run.status === "skipped";
  const stats = (run.statsJson ?? {}) as { repeat?: unknown; lastAt?: unknown };
  const repeat = typeof stats.repeat === "number" && stats.repeat > 1 ? stats.repeat : null;
  return (
    <li className={cn("rounded-2xl border p-3 text-sm", skipped ? "border-dashed border-zinc-800 bg-transparent" : "border-zinc-800 bg-zinc-900/30")}>
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <span className={cn("inline-flex items-center gap-1.5 font-medium", RUN_STATUS_TEXT[run.status] || "text-zinc-300")}>
          {skipped ? <IconPlayerSkipForward className="h-3.5 w-3.5" /> : <RunStatusDot status={run.status} />}
          {runStatusText(t, run.status)}
        </span>
        <span className="text-xs text-zinc-500">{format.dateTime(new Date(run.startedAt), { dateStyle: "medium", timeStyle: "short" })}</span>
      </div>
      <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs text-zinc-400">
        <span>{runOriginText(t, run, agentsMap, peopleMap)}</span>
        {duration !== null && !skipped ? (
          <span className="text-zinc-500">{run.endedAt ? t("history.took", { duration: formatDuration(t, duration) }) : t("history.runningFor", { duration: formatDuration(t, duration) })}</span>
        ) : null}
      </div>
      {run.summary ? <p className={cn("mt-2 text-xs leading-5", run.status === "failed" ? "text-red-300/90" : "text-zinc-400")}>{run.summary}</p> : null}
      {repeat ? (
        <p className="mt-1 text-xs text-zinc-500">
          {t("history.repeated", { count: repeat, time: format.dateTime(new Date(typeof stats.lastAt === "string" ? stats.lastAt : run.endedAt ?? run.startedAt), { dateStyle: "medium", timeStyle: "short" }) })}
        </p>
      ) : null}
      {taskIds.length > 0 ? (
        <ul className="mt-2 space-y-1">
          {taskIds.slice(0, 5).map((taskId) => (
            <li key={taskId}>
              <Link href={taskHref(taskId)} className="inline-flex max-w-full items-center gap-1 text-xs text-cyan-300 hover:text-cyan-200 hover:underline">
                <IconExternalLink className="h-3 w-3 shrink-0" />
                <span className="truncate">{tasksMap[taskId] || t("history.openTask")}</span>
              </Link>
            </li>
          ))}
        </ul>
      ) : null}
    </li>
  );
}

/** Next run / next expected / paused, in the viewer's locale. */
export function nextRunText(t: T, format: ReturnType<typeof useFormatter>, pipeline: AutomationRow): string | null {
  if (pipeline.status === "paused") return t("schedule.paused");
  if (pipeline.status === "draft") return t("schedule.draft");
  if (pipeline.trigger !== "cron" || !pipeline.schedule) return null;
  if (!pipeline.schedule.nextRunAt) return t("schedule.noNext");
  const time = format.dateTime(new Date(pipeline.schedule.nextRunAt), { dateStyle: "medium", timeStyle: "short" });
  return pipeline.scheduledBy === "emperor" ? t("schedule.next", { time }) : t("schedule.nextExpected", { time });
}

export function StatusToggle({ pipeline, disabled, onToggle }: { pipeline: AutomationRow; disabled?: boolean; onToggle: (next: "active" | "paused") => void }) {
  const t = useTranslations("pipelines");
  if (pipeline.status !== "active" && pipeline.status !== "paused") return null;
  const on = pipeline.status === "active";
  return (
    <span className="inline-flex items-center" onClick={(event) => event.stopPropagation()}>
      <SettingsSwitch checked={on} disabled={disabled} label={on ? t("toggle.turnOff", { name: pipeline.name }) : t("toggle.turnOn", { name: pipeline.name })} onChange={(checked) => onToggle(checked ? "active" : "paused")} />
      <span className="text-[11px] text-zinc-500">{on ? t("toggle.on") : t("toggle.off")}</span>
    </span>
  );
}

function agentOptions(t: T, agents: AgentOption[]) {
  return agents.map((agent) => ({ value: agent.id, label: agent.budgetStatus === "paused" ? t("runner.pausedOption", { name: agent.name }) : agent.name }));
}

/** Who runs it, who created it, when it runs and who keeps the schedule. */
export function HowItRuns({ pipeline, agents, agentsMap, peopleMap, canEdit, onChangeRunner, onChangeScheduler }: {
  pipeline: AutomationRow;
  agents: AgentOption[];
  agentsMap: Record<string, string>;
  peopleMap: Record<string, string>;
  canEdit: boolean;
  onChangeRunner: (agentId: string | null) => void;
  onChangeScheduler: (scheduledBy: "agent" | "emperor") => void;
}) {
  const t = useTranslations("pipelines");
  const format = useFormatter();
  const runner = agents.find((agent) => agent.id === pipeline.ownerAgentId) ?? null;
  const options = useMemo(() => [{ value: "", label: t("runner.noneOption") }, ...agentOptions(t, agents)], [agents, t]);
  const createdName = pipeline.createdById
    ? pipeline.createdByType === "human" ? peopleMap[pipeline.createdById] : agentsMap[pipeline.createdById]
    : null;
  const createdDate = format.dateTime(new Date(pipeline.createdAt), { dateStyle: "medium" });
  const cfg = pipeline.triggerConfig || {};
  const next = nextRunText(t, format, pipeline);

  let when: string;
  if (pipeline.trigger === "cron") {
    when = pipeline.schedule?.description || (pipeline.schedule?.cron ? t("schedule.cronRaw", { cron: pipeline.schedule.cron }) : t("trigger.schedule"));
  } else if (pipeline.trigger === "event") {
    when = typeof cfg.event === "string" ? t("schedule.event", { event: cfg.event }) : t("schedule.eventAny");
  } else {
    when = t("schedule.manual");
  }

  return (
    <section className="space-y-4 rounded-2xl border border-cyan-500/20 bg-cyan-500/[0.05] p-4">
      <h3 className="flex items-center gap-2 text-sm font-semibold text-cyan-100"><IconCalendarTime className="h-4 w-4" />{t("schedule.title")}</h3>

      <div className="space-y-1.5">
        <div className="text-xs uppercase tracking-wider text-zinc-500">{t("runner.label")}</div>
        {canEdit ? (
          <div className="flex items-center gap-2">
            {runner ? (
              <CharacterAvatar agentId={runner.id} name={runner.name} avatarUrl={runner.avatarUrl} avatarAppearance={runner.avatarAppearance} size={28} decorative />
            ) : (
              <span className="grid h-7 w-7 shrink-0 place-items-center rounded-[30%] border border-dashed border-zinc-700 text-zinc-500"><IconRobot className="h-3.5 w-3.5" /></span>
            )}
            <SearchableSelect
              value={pipeline.ownerAgentId ?? ""}
              options={options}
              placeholder={t("runner.none")}
              searchPlaceholder={t("runner.search")}
              onChange={(value) => onChangeRunner(value || null)}
              className="min-w-0 flex-1"
            />
          </div>
        ) : (
          <AgentChip agent={runner} size={24} className="text-sm text-zinc-100" />
        )}
      </div>

      <div className="space-y-1">
        <div className="text-xs uppercase tracking-wider text-zinc-500">{t("schedule.when")}</div>
        <p className="text-sm text-zinc-200">{when}</p>
        {pipeline.trigger === "cron" && pipeline.schedule ? (
          <p className="text-xs text-zinc-500">
            {pipeline.schedule.description && pipeline.schedule.cron ? `${t("schedule.cronRaw", { cron: pipeline.schedule.cron })} · ` : ""}
            {t("schedule.timezone", { zone: pipeline.schedule.timezone })}
          </p>
        ) : null}
        {next ? <p className={cn("text-sm", pipeline.status === "active" ? "text-cyan-200" : "text-amber-300")}>{next}</p> : null}
        {pipeline.status === "paused" && pipeline.pausedReason ? (
          <p role="status" className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-2 text-xs leading-5 text-amber-200">{t("schedule.pausedBecause", { reason: pipeline.pausedReason })}</p>
        ) : null}
        {pipeline.trigger === "cron" && pipeline.status === "active" ? (
          <p className="text-xs text-zinc-500">{pipeline.scheduledBy === "emperor" ? t("schedule.emperorHint") : t("schedule.agentHint")}</p>
        ) : null}
      </div>

      {pipeline.trigger === "cron" ? (
        <fieldset className="space-y-2">
          <legend className="text-xs uppercase tracking-wider text-zinc-500">{t("schedule.whoFires")}</legend>
          {(["agent", "emperor"] as const).map((option) => (
            <label key={option} className={cn("flex cursor-pointer gap-2 rounded-xl border p-2.5 text-sm", pipeline.scheduledBy === option ? "border-cyan-400/40 bg-cyan-400/10" : "border-zinc-800", !canEdit && "cursor-default opacity-70")}>
              <input
                type="radio"
                name={`scheduler-${pipeline.id}`}
                className="mt-1 accent-cyan-400"
                checked={pipeline.scheduledBy === option}
                disabled={!canEdit}
                onChange={() => onChangeScheduler(option)}
              />
              <span>
                <span className="block text-zinc-100">{option === "emperor" ? t("schedule.emperorOption") : t("schedule.agentOption")}</span>
                <span className="block text-xs leading-5 text-zinc-500">{option === "emperor" ? t("schedule.emperorExplain") : t("schedule.agentExplain")}</span>
              </span>
            </label>
          ))}
        </fieldset>
      ) : null}

      <div className="flex items-center gap-1.5 text-xs text-zinc-500">
        {pipeline.createdByType === "human" ? <IconUser className="h-3.5 w-3.5" /> : <IconRobot className="h-3.5 w-3.5" />}
        {createdName ? t("created.byOn", { name: createdName, date: createdDate }) : t("created.on", { date: createdDate })}
      </div>
    </section>
  );
}

type RunNowResult = { run: AutomationRun; taskId: string; agentId: string };

/** "Run now": which agent, what will happen, Run. Handles "already running → start another?". */
export function RunNowDialog({ pipeline, agents, open, onClose, onStarted }: {
  pipeline: AutomationRow | null;
  agents: AgentOption[];
  open: boolean;
  onClose: () => void;
  onStarted: (result: RunNowResult, agentName: string) => void;
}) {
  const t = useTranslations("pipelines");
  const tc = useTranslations("common");
  const format = useFormatter();
  const [agentId, setAgentId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState<{ startedAt: string } | null>(null);

  useEffect(() => {
    if (!open) return;
    setAgentId(pipeline?.ownerAgentId ?? "");
    setError(null);
    setRunning(null);
    setBusy(false);
  }, [open, pipeline?.id, pipeline?.ownerAgentId]);

  const options = useMemo(() => agentOptions(t, agents), [agents, t]);
  const agent = agents.find((item) => item.id === agentId) ?? null;
  if (!pipeline) return null;

  const run = async () => {
    if (!agentId) {
      setError(t("runNow.needsAgent"));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/pipelines/${pipeline.id}/run`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ agentId, force: running !== null }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.status === 409 && data?.code === "already_running" && data.run) {
        setRunning({ startedAt: data.run.startedAt });
        return;
      }
      if (!res.ok) {
        setError(typeof data?.error === "string" ? data.error : t("runNow.failed"));
        return;
      }
      onStarted(data as RunNowResult, agent?.name ?? "");
    } catch {
      setError(t("runNow.failed"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onClose(); }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("runNow.title", { name: pipeline.name })}</DialogTitle>
          <DialogDescription>
            {agent ? t("runNow.whatHappens", { agent: agent.name }) : t("runNow.needsAgent")}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <div className="text-xs font-medium text-muted-foreground">{t("runNow.agent")}</div>
          <SearchableSelect value={agentId} options={options} placeholder={t("runner.choose")} searchPlaceholder={t("runner.search")} onChange={(value) => { setAgentId(value); setRunning(null); }} className="w-full" />
          {running ? (
            <p role="alert" className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-2.5 text-sm text-amber-200">
              {t("runNow.alreadyRunning", { time: format.dateTime(new Date(running.startedAt), { dateStyle: "medium", timeStyle: "short" }) })}
            </p>
          ) : null}
          {error ? <p role="alert" className="text-sm text-red-400">{error}</p> : null}
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>{tc("cancel")}</Button>
          <Button type="button" onClick={run} disabled={busy || !agentId}>
            <IconPlayerPlay className="h-4 w-4" />
            {busy ? t("runNow.starting") : running ? t("runNow.startAnother") : t("runNow.run")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function RunNowButton({ onClick, compact, disabled }: { onClick: () => void; compact?: boolean; disabled?: boolean }) {
  const t = useTranslations("pipelines");
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={(event) => { event.stopPropagation(); onClick(); }}
      className={cn(
        "inline-flex cursor-pointer items-center gap-1.5 rounded-full border border-cyan-400/35 bg-cyan-400/10 font-medium text-cyan-100 transition-colors hover:bg-cyan-400/15 disabled:cursor-not-allowed disabled:opacity-40",
        compact ? "min-h-8 px-2.5 py-1 text-xs" : "px-4 py-2 text-sm",
      )}
    >
      <IconPlayerPlay className={compact ? "h-3.5 w-3.5" : "h-4 w-4"} />
      {t("runNow.button")}
    </button>
  );
}

export function PauseResumeButton({ pipeline, disabled, onToggle }: { pipeline: AutomationRow; disabled?: boolean; onToggle: (next: "active" | "paused") => void }) {
  const t = useTranslations("pipelines");
  if (pipeline.status !== "active" && pipeline.status !== "paused") return null;
  const active = pipeline.status === "active";
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={() => onToggle(active ? "paused" : "active")}
      className="inline-flex cursor-pointer items-center gap-2 rounded-full border border-zinc-700 bg-zinc-900/60 px-4 py-2 text-sm font-medium text-zinc-200 transition-colors hover:border-zinc-600 disabled:cursor-not-allowed disabled:opacity-40"
    >
      {active ? <IconPlayerPause className="h-4 w-4" /> : <IconPlayerPlay className="h-4 w-4" />}
      {active ? t("toggle.pause") : t("toggle.resume")}
    </button>
  );
}

/** What an automation is, how to get one, and what you can do with it here. */
export function EmptyAutomationsState() {
  const t = useTranslations("pipelines");
  const example = t("empty.example");
  const copyExample = async () => {
    try {
      await navigator.clipboard.writeText(example);
      toast.success(t("empty.copied"));
    } catch {
      toast.error(t("copyFailed"));
    }
  };
  return (
    <div className="mx-auto w-full max-w-2xl rounded-3xl border border-dashed border-zinc-700 bg-zinc-950/50 p-6 sm:p-10">
      <IconArrowsSplit className="h-10 w-10 text-zinc-500" />
      <h2 className="mt-4 text-xl font-semibold text-zinc-100">{t("empty.title")}</h2>
      <p className="mt-2 text-sm leading-6 text-zinc-400">{t("empty.what")}</p>
      <div className="mt-5 text-sm font-medium text-zinc-200">{t("empty.howTitle")}</div>
      <div className="mt-2 flex flex-col gap-3 rounded-2xl border border-zinc-800 bg-zinc-900/60 p-4 sm:flex-row sm:items-start">
        <q className="flex-1 text-sm italic leading-6 text-zinc-300">{example}</q>
        <button type="button" onClick={copyExample} className="inline-flex shrink-0 cursor-pointer items-center gap-1.5 self-start rounded-full border border-zinc-700 px-3 py-1.5 text-xs text-zinc-300 hover:border-zinc-600">
          <IconCopy className="h-3.5 w-3.5" />{t("empty.copy")}
        </button>
      </div>
      <p className="mt-4 text-sm leading-6 text-zinc-400">{t("empty.then")}</p>
    </div>
  );
}
