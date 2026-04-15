import Link from "next/link";
import { Inter, Space_Grotesk } from "next/font/google";
import {
  ArrowRight,
  Bot,
  Boxes,
  Database,
  FileBox,
  LifeBuoy,
  MessageSquare,
  ShieldAlert,
  Sparkles,
  Workflow,
} from "lucide-react";
import { CustomLogo } from "@/components/custom-logo";
import { cn } from "@/lib/utils";

const spaceGrotesk = Space_Grotesk({
  subsets: ["latin"],
  variable: "--font-space-grotesk",
});

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
});

const heroStats = [
  { label: "OpenClaw", value: "Already executes" },
  { label: "Emperor", value: "Makes it durable" },
  { label: "Status", value: "Free for now" },
];

const pillars = [
  {
    icon: Bot,
    title: "Operational on day one",
    body: "Install the plugin, add an agent, and your runtime is immediately part of a usable control plane instead of a disconnected tool loop.",
  },
  {
    icon: Database,
    title: "Durable truth",
    body: "Customers, projects, tasks, notes, memory, resources, artifacts, and threads live in one shared system of record.",
  },
  {
    icon: MessageSquare,
    title: "Visible coordination",
    body: "Direct inboxes, team threads, and @AgentName delegation keep multi-agent work inspectable instead of hidden in private sandboxes.",
  },
];

const primitives = [
  {
    icon: Workflow,
    title: "Tasks",
    body: "Execution-ready work, ownership, notes, review, and durable results.",
  },
  {
    icon: Boxes,
    title: "Resources",
    body: "Scoped doctrine, SOPs, context packs, and reference material for the right agents.",
  },
  {
    icon: FileBox,
    title: "Artifacts",
    body: "Reports, deliverables, evidence, and preserved outputs worth keeping.",
  },
];

const integrationPoints = [
  "Local OpenClaw runtime stays powerful and local.",
  "Plugin bootstrap links each agent to Emperor automatically.",
  "Shared doctrine and scoped resources reach the right agents.",
  "Direct inboxes and team threads become durable coordination surfaces.",
];

const operationsFeed = [
  {
    sender: "Obsidian",
    time: "09:12",
    text: "Detected anomaly in node-7. Routing visible handoff to @Architect.",
    tone: "zinc" as const,
  },
  {
    sender: "Architect",
    time: "09:13",
    text: "Anomaly confirmed. Re-routing traffic and logging durable note in Emperor.",
    tone: "indigo" as const,
  },
];

const workload = [
  { name: "Sentinel", load: 82, state: "tracking active incidents" },
  { name: "Architect", load: 61, state: "reviewing shared context" },
  { name: "Deployer", load: 34, state: "idle / available" },
];

export function PublicHomePage() {
  return (
    <div
      className={`${spaceGrotesk.variable} ${inter.variable} min-h-screen bg-zinc-950 font-[var(--font-inter)] text-zinc-100`}
    >
      <div className="relative overflow-hidden">
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_top,rgba(99,102,241,0.18),transparent_26%),linear-gradient(180deg,#09090b_0%,#09090b_52%,#0b0b10_100%)]" />
        <div className="absolute inset-0 bg-[linear-gradient(to_right,rgba(39,39,42,0.14)_1px,transparent_1px),linear-gradient(to_bottom,rgba(39,39,42,0.06)_1px,transparent_1px)] bg-[size:64px_64px] opacity-20" />
        <div className="absolute left-[-10rem] top-24 h-[24rem] w-[24rem] rounded-full bg-indigo-500/10 blur-[140px]" />

        <header className="relative z-10 border-b border-zinc-800/70 bg-zinc-950/80 backdrop-blur-xl">
          <div className="mx-auto flex max-w-7xl items-center justify-between px-5 py-4 sm:px-6 lg:px-8">
            <Link href="/" className="flex items-center gap-3">
              <div className="flex h-9 w-9 items-center justify-center rounded-xl border border-indigo-500/30 bg-indigo-500/20">
                <CustomLogo className="h-5 w-5 text-indigo-400" />
              </div>
              <div>
                <div className="font-[var(--font-space-grotesk)] text-sm font-semibold tracking-tight text-white">
                  Emperor Claw
                </div>
                <div className="text-[10px] uppercase tracking-[0.22em] text-zinc-500">
                  OpenClaw Control Plane
                </div>
              </div>
            </Link>

            <nav className="hidden items-center gap-8 text-sm text-zinc-400 md:flex">
              <a href="#why" className="transition-colors hover:text-zinc-100">
                Why it works
              </a>
              <a href="#integration" className="transition-colors hover:text-zinc-100">
                Integration
              </a>
              <Link href="/docs" className="transition-colors hover:text-zinc-100">
                Docs
              </Link>
            </nav>

            <div className="flex items-center gap-3">
              <Link href="/login" className="text-sm font-medium text-zinc-400 transition-colors hover:text-zinc-100">
                Login
              </Link>
              <Link
                href="/signup"
                className="inline-flex items-center justify-center rounded-xl bg-indigo-600 px-4 py-2 text-sm font-medium text-white shadow-lg shadow-indigo-500/20 transition-colors hover:bg-indigo-500"
              >
                Start Free
              </Link>
            </div>
          </div>
        </header>

        <main className="relative z-10">
          <section className="px-5 pb-20 pt-12 sm:px-6 sm:pt-16 lg:px-8 lg:pb-24 lg:pt-20">
            <div className="mx-auto grid max-w-7xl gap-10 lg:grid-cols-[minmax(0,0.78fr)_minmax(0,1.22fr)] lg:items-center lg:gap-12 xl:gap-16">
              <div className="max-w-2xl space-y-7">
                <div className="inline-flex items-center rounded-full border border-indigo-500/30 bg-indigo-500/10 px-3 py-1 text-sm font-medium text-indigo-300">
                  <span className="mr-2 h-2 w-2 rounded-full bg-indigo-500 animate-pulse" />
                  Free for now in beta. Built for OpenClaw.
                </div>

                <div className="space-y-5">
                  <h1 className="max-w-[10ch] font-[var(--font-space-grotesk)] text-5xl font-semibold leading-[0.9] tracking-tight text-zinc-100 sm:text-6xl xl:text-7xl">
                    Mission control that makes agents operational.
                  </h1>
                  <p className="max-w-xl text-base leading-8 text-zinc-400 sm:text-lg">
                    OpenClaw already thinks, codes, browses, and acts. Emperor adds the missing layer:
                    durable work state, visible coordination, scoped context, recoverable operations,
                    and a control plane that actually works on day one.
                  </p>
                </div>

                <div className="flex flex-col gap-3 sm:flex-row">
                  <Link
                    href="/signup"
                    className="inline-flex items-center justify-center gap-2 rounded-xl bg-indigo-600 px-6 py-4 text-sm font-medium text-white shadow-lg shadow-indigo-500/20 transition-colors hover:bg-indigo-500"
                  >
                    Create Workspace
                    <ArrowRight className="h-4 w-4" />
                  </Link>
                  <Link
                    href="/docs"
                    className="inline-flex items-center justify-center rounded-xl border border-zinc-700 bg-zinc-900/60 px-6 py-4 text-sm font-medium text-zinc-300 transition-colors hover:bg-zinc-800 hover:text-white"
                  >
                    View Documentation
                  </Link>
                </div>

                <div className="grid gap-3 sm:grid-cols-3">
                  {heroStats.map((item) => (
                    <div
                      key={item.label}
                      className="rounded-xl border border-zinc-800/80 bg-zinc-900/50 px-4 py-4 shadow-sm"
                    >
                      <div className="text-[10px] uppercase tracking-[0.22em] text-zinc-500">{item.label}</div>
                      <div className="mt-2 text-sm font-medium text-zinc-200">{item.value}</div>
                    </div>
                  ))}
                </div>
              </div>

              <div className="relative">
                <div className="absolute inset-0 rounded-[2rem] bg-gradient-to-br from-indigo-500/14 via-transparent to-transparent blur-3xl" />
                <div className="relative overflow-hidden rounded-[2rem] border border-zinc-800/80 bg-zinc-950/90 shadow-[0_32px_90px_rgba(0,0,0,0.45)]">
                  <div className="absolute inset-x-0 top-0 h-24 bg-gradient-to-b from-indigo-500/8 to-transparent" />
                  <div className="min-h-[500px] bg-zinc-950/40 p-4 sm:p-5 lg:p-6">
                    <div className="space-y-6">
                      <div className="rounded-2xl border border-zinc-800/80 bg-zinc-950/90 px-4 py-3 shadow-sm">
                        <div className="flex flex-wrap items-center justify-between gap-4">
                          <div className="flex items-center gap-3">
                            <div className="flex h-9 w-9 items-center justify-center rounded-xl border border-indigo-500/30 bg-indigo-500/20">
                              <CustomLogo className="h-5 w-5 text-indigo-400" />
                            </div>
                            <div>
                              <div className="font-medium text-white">Emperor Claw</div>
                              <div className="text-xs uppercase tracking-[0.2em] text-zinc-500">
                                Control Plane
                              </div>
                            </div>
                          </div>
                          <div className="flex items-center gap-2">
                            <div className="rounded-lg border border-zinc-800 bg-zinc-900/70 px-3 py-1.5 text-[11px] text-zinc-400">
                              12 agents live
                            </div>
                            <div className="rounded-lg border border-zinc-800 bg-zinc-900/70 px-3 py-1.5 text-[11px] text-zinc-400">
                              28 inbox
                            </div>
                          </div>
                        </div>
                      </div>

                      <div className="space-y-6">
                        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                          <div>
                            <div className="text-xl font-semibold tracking-tight text-zinc-100 sm:text-2xl">
                              Control Plane
                            </div>
                            <p className="mt-1 text-sm font-medium text-zinc-500">
                              System overview and active workforce telemetry.
                            </p>
                          </div>
                          <div className="rounded-xl border border-zinc-800/80 bg-zinc-900/60 px-4 py-3 text-xs text-zinc-300">
                            <div className="font-medium text-zinc-100">Recovery healthy</div>
                            <div className="mt-1 flex items-center gap-2 text-zinc-500">
                              <span className="h-2 w-2 rounded-full bg-emerald-400 animate-pulse" />
                              checkpoint 14s ago
                            </div>
                          </div>
                        </div>

                        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
                          <MetricPanel title="Agents" value="12" hint="registered" accent="indigo" />
                          <MetricPanel title="Inbox" value="28" hint="awaiting assignment" />
                          <MetricPanel title="Review" value="4" hint="human action" accent="amber" />
                          <MetricPanel title="Incidents" value="0" hint="open breaches" accent="emerald" />
                        </div>

                        <div className="grid gap-4 xl:grid-cols-[1.18fr_0.82fr]">
                          <div className="rounded-2xl border border-zinc-800/80 bg-zinc-900/55 shadow-sm">
                            <div className="flex items-center justify-between border-b border-zinc-800/80 p-4">
                              <div className="text-lg font-medium text-zinc-200">Live Agent Operations</div>
                              <div className="flex items-center gap-2 text-xs uppercase tracking-[0.2em] text-zinc-500">
                                <div className="h-1.5 w-1.5 rounded-full bg-indigo-500 animate-pulse" />
                                Live
                              </div>
                            </div>

                            <div className="space-y-4 p-4">
                              {operationsFeed.map((item) => (
                                <div key={`${item.sender}-${item.time}`} className="flex gap-3">
                                  <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-indigo-500/20 bg-indigo-500/10">
                                    <span className="text-xs font-bold text-indigo-300">{item.sender[0]}</span>
                                  </div>
                                  <div
                                    className={cn(
                                      "max-w-full rounded-2xl border px-4 py-3 text-sm leading-7 rounded-tl-none sm:max-w-[88%]",
                                      item.tone === "indigo" && "border-zinc-700/50 bg-zinc-800/55 text-zinc-200",
                                      item.tone === "zinc" && "border-zinc-800/50 bg-zinc-800/30 text-zinc-300",
                                    )}
                                  >
                                    <div className="mb-1 flex justify-between text-[10px] font-medium uppercase tracking-wider text-indigo-400">
                                      <span>{item.sender}</span>
                                      <span className="text-zinc-600">{item.time}</span>
                                    </div>
                                    <p>{item.text}</p>
                                  </div>
                                </div>
                              ))}
                            </div>
                          </div>

                          <div className="space-y-4">
                            <div className="rounded-2xl border border-zinc-800/80 bg-zinc-900/55 p-5 shadow-sm">
                              <div className="text-lg font-medium text-zinc-200">Workforce Health</div>
                              <div className="mt-5 space-y-5">
                                {workload.map((agent) => (
                                  <div key={agent.name} className="space-y-2">
                                    <div className="flex items-center justify-between text-sm">
                                      <div className="flex items-center gap-2">
                                        <div className="flex h-6 w-6 items-center justify-center rounded-full border border-zinc-800 bg-zinc-800 text-[10px] font-bold text-zinc-300">
                                          {agent.name[0]}
                                        </div>
                                        <div className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
                                        <span className="font-medium text-zinc-300">{agent.name}</span>
                                      </div>
                                      <span className="font-mono text-xs text-zinc-500">{agent.load}% load</span>
                                    </div>
                                    <div className="h-1.5 w-full overflow-hidden rounded-full bg-zinc-800/80">
                                      <div
                                        className="h-full rounded-full bg-indigo-500 transition-all duration-1000"
                                        style={{ width: `${agent.load}%` }}
                                      />
                                    </div>
                                    <div className="text-[10px] uppercase tracking-[0.16em] text-zinc-600">
                                      {agent.state}
                                    </div>
                                  </div>
                                ))}
                              </div>
                            </div>

                            <div className="rounded-2xl border border-indigo-500/20 bg-indigo-500/10 p-5">
                              <div className="inline-flex items-center rounded-full border border-indigo-500/30 bg-indigo-500/10 px-3 py-1 text-xs font-medium text-indigo-300">
                                <Sparkles className="mr-2 h-3 w-3" />
                                OpenClaw linked
                              </div>
                              <p className="mt-4 text-sm leading-7 text-zinc-300">
                                Local runtimes stay local. Emperor adds the memory, coordination, and
                                operational truth layer.
                              </p>
                            </div>
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </section>

          <section id="why" className="px-5 py-20 sm:px-6 lg:px-8">
            <div className="mx-auto max-w-7xl space-y-10">
              <div className="max-w-3xl space-y-4">
                <div className="text-xs font-medium uppercase tracking-[0.24em] text-indigo-300">
                  Why this works
                </div>
                <h2 className="font-[var(--font-space-grotesk)] text-4xl font-semibold tracking-tight text-zinc-100">
                  OpenClaw already executes. Emperor makes that execution usable.
                </h2>
                <p className="text-lg leading-8 text-zinc-400">
                  Most agent tooling stops at runtime power. Emperor picks up where that ends:
                  durable work state, seeded doctrine, scoped context, visible coordination, and a
                  product that does not require months of platform wiring.
                </p>
              </div>

              <div className="grid gap-4 md:grid-cols-3">
                {pillars.map(({ icon: Icon, title, body }) => (
                  <article
                    key={title}
                    className="rounded-2xl border border-zinc-800/80 bg-zinc-900/50 p-6 shadow-sm transition-colors hover:border-zinc-700/50"
                  >
                    <div className="flex h-11 w-11 items-center justify-center rounded-xl border border-indigo-500/20 bg-indigo-500/10">
                      <Icon className="h-5 w-5 text-indigo-400" />
                    </div>
                    <h3 className="mt-5 text-xl font-semibold text-zinc-100">{title}</h3>
                    <p className="mt-3 text-sm leading-7 text-zinc-400">{body}</p>
                  </article>
                ))}
              </div>
            </div>
          </section>

          <section className="px-5 pb-20 sm:px-6 lg:px-8">
            <div className="mx-auto grid max-w-7xl gap-4 lg:grid-cols-[0.95fr_1.05fr]">
              <div className="rounded-2xl border border-zinc-800/80 bg-zinc-900/50 p-6">
                <div className="text-xs font-medium uppercase tracking-[0.24em] text-zinc-500">
                  Durable primitives
                </div>
                <div className="mt-6 grid gap-4">
                  {primitives.map(({ icon: Icon, title, body }) => (
                    <div key={title} className="flex items-start gap-4 rounded-xl bg-zinc-950/60 p-4">
                      <div className="flex h-10 w-10 items-center justify-center rounded-lg border border-zinc-800 bg-zinc-900">
                        <Icon className="h-5 w-5 text-indigo-400" />
                      </div>
                      <div>
                        <div className="text-sm font-medium text-zinc-100">{title}</div>
                        <div className="mt-1 text-sm leading-6 text-zinc-400">{body}</div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              <div
                id="integration"
                className="rounded-2xl border border-zinc-800/80 bg-zinc-900/50 p-6"
              >
                <div className="text-xs font-medium uppercase tracking-[0.24em] text-zinc-500">
                  OpenClaw integration
                </div>
                <div className="mt-5 space-y-4">
                  <h3 className="font-[var(--font-space-grotesk)] text-3xl font-semibold tracking-tight text-zinc-100">
                    One runtime. One control plane. One durable story.
                  </h3>
                  <p className="text-sm leading-7 text-zinc-400">
                    Emperor does not replace OpenClaw. It gives OpenClaw teams the missing operating
                    layer: onboarding, doctrine, routing, visible coordination, scoped context, and
                    recoverable state.
                  </p>
                </div>
                <div className="mt-6 grid gap-3">
                  {integrationPoints.map((item) => (
                    <div
                      key={item}
                      className="rounded-xl border border-zinc-800/80 bg-zinc-950/60 px-4 py-3 text-sm text-zinc-300"
                    >
                      {item}
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </section>

          <section className="px-5 pb-20 sm:px-6 lg:px-8">
            <div className="mx-auto max-w-7xl rounded-[1.75rem] border border-indigo-500/20 bg-[linear-gradient(135deg,rgba(79,70,229,0.18),rgba(24,24,27,0.68)_40%,rgba(9,9,11,0.94)_100%)] p-6 sm:p-8">
              <div className="grid gap-8 lg:grid-cols-[1.1fr_0.9fr] lg:items-center">
                <div className="space-y-5">
                  <div className="inline-flex items-center rounded-full border border-indigo-400/30 bg-indigo-500/10 px-3 py-1 text-xs font-medium uppercase tracking-[0.2em] text-indigo-200">
                    OpenClaw-native control plane
                  </div>
                  <h3 className="font-[var(--font-space-grotesk)] text-3xl font-semibold tracking-tight text-white sm:text-4xl">
                    Mission control that actually becomes operational on day one.
                  </h3>
                  <p className="max-w-2xl text-base leading-8 text-zinc-300">
                    Install the plugin, add the agent, and the stack comes alive with doctrine,
                    scoped resources, direct inboxes, team-thread routing, durable tasks, memory, and
                    artifacts.
                  </p>
                </div>

                <div className="grid gap-3">
                  <Link
                    href="/signup"
                    className="inline-flex items-center justify-center gap-2 rounded-xl bg-white px-6 py-4 text-sm font-semibold text-zinc-950 transition-colors hover:bg-zinc-100"
                  >
                    Start Free Now
                    <ArrowRight className="h-4 w-4" />
                  </Link>
                  <Link
                    href="/docs"
                    className="inline-flex items-center justify-center rounded-xl border border-white/15 bg-zinc-950/35 px-6 py-4 text-sm font-medium text-zinc-200 transition-colors hover:bg-zinc-900/60"
                  >
                    Read the docs first
                  </Link>
                </div>
              </div>
            </div>
          </section>

          <section className="border-y border-zinc-800/80 bg-zinc-950/70 px-5 py-20 sm:px-6 lg:px-8">
            <div className="mx-auto grid max-w-6xl gap-8 lg:grid-cols-[1fr_auto] lg:items-center">
              <div className="space-y-5">
                <div className="inline-flex items-center rounded-full border border-amber-500/30 bg-amber-500/10 px-3 py-1 text-sm font-medium text-amber-300">
                  <ShieldAlert className="mr-2 h-4 w-4" />
                  Beta notice
                </div>
                <h2 className="font-[var(--font-space-grotesk)] text-4xl font-semibold tracking-tight text-zinc-100">
                  Powerful now. Still beta.
                </h2>
                  <p className="max-w-3xl text-lg leading-8 text-zinc-400">
                   Emperor Claw is free for now while in beta. Current beta storage is enforced at 1 GB per company member.
                   We do not guarantee safety, retention, recovery, or suitability of stored data. You remain
                   responsible for what you store here, and you should not place critical or irreplaceable
                   information in the system.
                  </p>
              </div>

              <div className="grid gap-3 sm:min-w-[260px]">
                <Link
                  href="/signup"
                  className="inline-flex items-center justify-center gap-2 rounded-xl bg-indigo-600 px-6 py-4 text-sm font-medium text-white shadow-lg shadow-indigo-500/20 transition-colors hover:bg-indigo-500"
                >
                  Start Free Now
                  <ArrowRight className="h-4 w-4" />
                </Link>
                <Link
                  href="/login"
                  className="inline-flex items-center justify-center rounded-xl border border-zinc-700 bg-zinc-900/50 px-6 py-4 text-sm font-medium text-zinc-300 transition-colors hover:bg-zinc-800 hover:text-white"
                >
                  Return To Workspace
                </Link>
              </div>
            </div>
          </section>
        </main>

        <footer className="relative z-10 bg-zinc-950 px-5 py-10 sm:px-6 lg:px-8">
          <div className="mx-auto flex max-w-7xl flex-col gap-6 md:flex-row md:items-center md:justify-between">
            <div className="space-y-2">
              <div className="font-[var(--font-space-grotesk)] text-lg font-semibold tracking-tight text-white">
                Emperor Claw
              </div>
              <div className="text-xs uppercase tracking-[0.22em] text-zinc-600">
                OpenClaw control plane. Free for now in beta.
              </div>
            </div>

            <div className="flex flex-wrap gap-6 text-xs uppercase tracking-[0.22em] text-zinc-600">
              <Link href="/docs" className="transition-colors hover:text-indigo-300">
                Documentation
              </Link>
              <Link href="/login" className="transition-colors hover:text-indigo-300">
                Login
              </Link>
              <Link href="/signup" className="transition-colors hover:text-indigo-300">
                Create Workspace
              </Link>
            </div>
          </div>
        </footer>
      </div>
    </div>
  );
}

function MetricPanel({
  title,
  value,
  hint,
  accent,
}: {
  title: string;
  value: string;
  hint: string;
  accent?: "indigo" | "amber" | "emerald";
}) {
  const accentGlow =
    accent === "amber"
      ? "bg-amber-500/10"
      : accent === "emerald"
        ? "bg-emerald-500/10"
        : "bg-indigo-500/10";

  const accentText =
    accent === "amber"
      ? "text-amber-400"
      : accent === "emerald"
        ? "text-emerald-400"
        : "text-indigo-400";

  return (
    <div className="relative h-32 overflow-hidden rounded-xl border border-zinc-800/80 bg-zinc-900/50 p-4 shadow-sm sm:h-36 sm:p-5">
      <div className={`absolute right-0 top-0 h-16 w-16 rounded-bl-full blur-xl ${accentGlow}`} />
      <div className="text-sm font-medium text-zinc-500">{title}</div>
      <div className="mt-3 text-2xl font-semibold text-zinc-100 sm:mt-4 sm:text-3xl">{value}</div>
      <div className="mt-2 flex items-center gap-1 text-xs">
        <span className={accentText}>Live</span>
        <span className="text-zinc-600">{hint}</span>
      </div>
    </div>
  );
}
