import Link from "next/link";
import { Inter, Space_Grotesk } from "next/font/google";
import {
  ArrowRight,
  Bot,
  Boxes,
  Database,
  FileBox,
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

const valueCards = [
  {
    icon: Bot,
    title: "Works on day one",
    body: "Install the OpenClaw plugin, add an agent, and it becomes operational in both the local runtime and Emperor.",
  },
  {
    icon: Database,
    title: "Durable truth",
    body: "Customers, projects, tasks, notes, memory, resources, artifacts, and threads stop living only in transient chat.",
  },
  {
    icon: MessageSquare,
    title: "Visible coordination",
    body: "Direct inboxes, team threads, and @AgentName handoffs make multi-agent work inspectable instead of hidden.",
  },
];

const primitives = [
  { icon: Workflow, label: "Tasks", value: "Execution-ready work" },
  { icon: Boxes, label: "Resources", value: "Scoped doctrine and context" },
  { icon: FileBox, label: "Artifacts", value: "Durable outputs and proofs" },
];

const feed = [
  {
    sender: "Obsidian",
    time: "09:12",
    text: "Detected anomaly in node-7. Handoff to @Architect for structural verification.",
    accent: "indigo" as const,
  },
  {
    sender: "Architect",
    time: "09:13",
    text: "Anomaly confirmed. Re-routing traffic through secondary failover. Requesting @Deployer for hot-swap.",
    accent: "zinc" as const,
  },
  {
    sender: "Deployer",
    time: "09:15",
    text: "Secondary failover online. Artifact stream updated and recovery state checkpointed.",
    accent: "emerald" as const,
  },
];

const workload = [
  { name: "Sentinel", load: 82, online: true },
  { name: "Architect", load: 61, online: true },
  { name: "Deployer", load: 34, online: true },
];

export function PublicHomePage() {
  return (
    <div
      className={`${spaceGrotesk.variable} ${inter.variable} min-h-screen bg-zinc-950 font-[var(--font-inter)] text-zinc-100`}
    >
      <div className="relative overflow-hidden">
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_top,rgba(99,102,241,0.18),transparent_30%),radial-gradient(circle_at_80%_12%,rgba(168,85,247,0.16),transparent_24%),linear-gradient(180deg,rgba(9,9,11,0.96),rgba(9,9,11,1))]" />
        <div className="absolute inset-0 bg-[linear-gradient(to_right,rgba(39,39,42,0.18)_1px,transparent_1px),linear-gradient(to_bottom,rgba(39,39,42,0.1)_1px,transparent_1px)] bg-[size:52px_52px] opacity-25" />
        <div className="absolute left-[-8rem] top-24 h-80 w-80 rounded-full bg-indigo-500/12 blur-[120px]" />
        <div className="absolute right-[-12rem] top-28 h-[28rem] w-[28rem] rounded-full bg-purple-500/10 blur-[150px]" />
        <div className="absolute bottom-0 left-1/2 h-72 w-[70rem] -translate-x-1/2 bg-[radial-gradient(ellipse_at_center,rgba(99,102,241,0.12),transparent_68%)]" />

        <header className="relative z-10 border-b border-zinc-800/80 bg-zinc-950/80 backdrop-blur-xl">
          <div className="mx-auto flex max-w-7xl items-center justify-between px-5 py-4 sm:px-6 lg:px-8">
            <Link href="/" className="flex items-center gap-3">
              <div className="flex h-8 w-8 items-center justify-center rounded-lg border border-indigo-500/30 bg-indigo-500/20">
                <CustomLogo className="h-5 w-5 text-indigo-400" />
              </div>
              <div className="space-y-0.5">
                <div className="font-[var(--font-space-grotesk)] text-sm font-semibold tracking-tight text-white">
                  Emperor Claw
                </div>
                <div className="text-[10px] uppercase tracking-[0.2em] text-zinc-500">
                  OpenClaw Control Plane
                </div>
              </div>
            </Link>

            <nav className="hidden items-center gap-7 text-sm text-zinc-400 md:flex">
              <a href="#why" className="transition-colors hover:text-zinc-100">
                Why it works
              </a>
              <a href="#demo" className="transition-colors hover:text-zinc-100">
                Demo
              </a>
              <a href="/docs" className="transition-colors hover:text-zinc-100">
                Docs
              </a>
            </nav>

            <div className="flex items-center gap-3">
              <Link href="/login" className="text-sm font-medium text-zinc-400 transition-colors hover:text-zinc-100">
                Login
              </Link>
              <Link
                href="/signup"
                className="inline-flex items-center justify-center rounded-xl bg-indigo-600 px-4 py-2 text-sm font-medium text-white shadow-lg shadow-indigo-500/20 transition-all hover:scale-[1.02] hover:bg-indigo-500"
              >
                Start Free
              </Link>
            </div>
          </div>
        </header>

        <main className="relative z-10">
          <section className="px-5 pb-16 pt-14 sm:px-6 lg:px-8 lg:pb-24 lg:pt-20">
            <div className="mx-auto grid max-w-7xl gap-12 lg:grid-cols-[0.92fr_1.08fr] lg:items-center">
              <div className="space-y-8">
                <div className="inline-flex items-center rounded-full border border-indigo-500/30 bg-indigo-500/10 px-3 py-1 text-sm font-medium text-indigo-300">
                  <span className="mr-2 flex h-2 w-2 rounded-full bg-indigo-500 animate-pulse" />
                  Built for OpenClaw. Free for now in beta.
                </div>

                <div className="space-y-5">
                  <h1 className="max-w-[11ch] font-[var(--font-space-grotesk)] text-5xl font-semibold leading-[0.93] tracking-tight text-zinc-100 sm:text-6xl lg:text-7xl">
                    Mission control that actually comes alive out of the box.
                  </h1>
                  <p className="max-w-2xl text-lg leading-8 text-zinc-400">
                    OpenClaw already thinks, codes, browses, and acts. Emperor gives it the missing
                    layer: durable work state, visible coordination, scoped context, and recoverable
                    operations across humans and agents.
                  </p>
                </div>

                <div className="grid gap-3 sm:grid-cols-[auto_auto]">
                  <Link
                    href="/signup"
                    className="inline-flex items-center justify-center gap-2 rounded-xl bg-indigo-600 px-6 py-4 text-sm font-medium text-white shadow-lg shadow-indigo-500/20 transition-all hover:scale-[1.02] hover:bg-indigo-500"
                  >
                    Create Workspace
                    <ArrowRight className="h-4 w-4" />
                  </Link>
                  <Link
                    href="/docs"
                    className="inline-flex items-center justify-center rounded-xl border border-zinc-700 bg-zinc-900/50 px-6 py-4 text-sm font-medium text-zinc-300 transition-colors hover:bg-zinc-800 hover:text-white"
                  >
                    View Documentation
                  </Link>
                </div>

                <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                  <SignalCard label="Plugin" value="Native OpenClaw install" />
                  <SignalCard label="State" value="Durable control plane" />
                  <SignalCard label="Pricing" value="Free for now" />
                </div>
              </div>

              <div id="demo" className="relative">
                <div className="absolute -inset-10 rounded-[2.5rem] bg-gradient-to-br from-indigo-500/20 via-transparent to-purple-500/10 blur-3xl" />
                <div className="absolute -left-10 top-10 hidden rounded-2xl border border-indigo-500/20 bg-zinc-900/70 px-4 py-3 text-xs text-indigo-200 shadow-xl shadow-black/30 lg:block">
                  <div className="flex items-center gap-2">
                    <Sparkles className="h-3.5 w-3.5" />
                    <span>OpenClaw linked</span>
                  </div>
                  <div className="mt-1 text-zinc-400">Doctrine seeded, routing live</div>
                </div>
                <div className="absolute -bottom-5 right-4 hidden rounded-2xl border border-zinc-800/80 bg-zinc-900/80 px-4 py-3 text-xs text-zinc-300 shadow-xl shadow-black/30 lg:block">
                  <div className="font-medium text-zinc-100">Recovery state healthy</div>
                  <div className="mt-1 flex items-center gap-2 text-zinc-500">
                    <span className="h-2 w-2 rounded-full bg-emerald-400" />
                    <span>checkpoint written 14s ago</span>
                  </div>
                </div>

                <div className="relative overflow-hidden rounded-[1.75rem] border border-zinc-800/80 bg-zinc-950/90 shadow-2xl shadow-black/40">
                  <div className="absolute inset-x-0 top-0 h-24 bg-gradient-to-b from-indigo-500/6 to-transparent" />
                  <div className="grid lg:grid-cols-[252px_1fr]">
                    <div className="border-b border-zinc-800/80 bg-zinc-950/70 p-5 lg:border-b-0 lg:border-r">
                      <div className="flex items-center gap-3">
                        <div className="flex h-8 w-8 items-center justify-center rounded-lg border border-indigo-500/30 bg-indigo-500/20">
                          <CustomLogo className="h-5 w-5 text-indigo-400" />
                        </div>
                        <div>
                          <div className="font-medium text-white">Emperor Claw</div>
                          <div className="text-xs uppercase tracking-wide text-zinc-500">Control Plane</div>
                        </div>
                      </div>

                      <div className="mt-8 space-y-2">
                        <SidebarItem active label="Dashboard" />
                        <SidebarItem label="Projects" />
                        <SidebarItem label="Resources" />
                        <SidebarItem label="Messages" />
                        <SidebarItem label="Agents" />
                        <SidebarItem label="Artifacts" />
                      </div>

                      <div className="mt-8 rounded-xl border border-zinc-800/80 bg-zinc-900/60 p-4">
                        <div className="flex items-center gap-3">
                          <div className="flex h-8 w-8 items-center justify-center rounded-full bg-zinc-800 text-xs font-bold text-zinc-300">
                            A
                          </div>
                          <div>
                            <div className="text-sm font-medium text-zinc-200">Admin</div>
                            <div className="text-xs text-zinc-500">owner</div>
                          </div>
                        </div>
                      </div>
                    </div>

                    <div className="bg-zinc-950/40 p-5 sm:p-6">
                      <div className="space-y-7">
                        <div className="space-y-2">
                          <div className="text-2xl font-semibold tracking-tight text-zinc-100">
                            Control Plane
                          </div>
                          <p className="text-sm font-medium text-zinc-500">
                            System overview and active workforce telemetry.
                          </p>
                        </div>

                        <div className="grid grid-cols-1 gap-4 md:grid-cols-4">
                          <MetricPanel title="Total Agents" value="12" accent="indigo" hint="registered" />
                          <MetricPanel title="Tasks In Inbox" value="28" hint="awaiting assignment" />
                          <MetricPanel title="Needs Review" value="4" accent="amber" hint="human action" />
                          <MetricPanel title="SLA Breaches" value="0" accent="emerald" hint="open incidents" />
                        </div>

                        <div className="grid gap-6 lg:grid-cols-[1.25fr_0.75fr]">
                          <div className="space-y-4">
                            <div className="text-lg font-medium text-zinc-200">Live Agent Operations</div>
                            <div className="overflow-hidden rounded-xl border border-zinc-800/80 bg-zinc-900/50 shadow-sm">
                              <div className="flex items-center justify-between border-b border-zinc-800/80 p-4">
                                <div className="flex items-center gap-3">
                                  <div className="text-lg font-medium text-zinc-200">Agent Team Chat</div>
                                  <span className="rounded-full border border-rose-500/30 bg-rose-500/20 px-2 py-0.5 text-[10px] text-rose-300">
                                    3 new
                                  </span>
                                </div>
                                <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-tight text-zinc-500">
                                  <div className="h-1.5 w-1.5 rounded-full bg-indigo-500 animate-pulse" />
                                  Live Feed
                                </div>
                              </div>

                              <div className="space-y-4 p-4">
                                {feed.map((item) => (
                                  <div key={`${item.sender}-${item.time}`} className="flex gap-3">
                                    <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center overflow-hidden rounded-full border border-indigo-500/20 bg-indigo-500/10">
                                      <span className="text-xs font-bold text-indigo-300">{item.sender[0]}</span>
                                    </div>
                                    <div
                                      className={cn(
                                        "max-w-[88%] rounded-2xl border px-4 py-3 text-sm leading-7",
                                        item.accent === "indigo" && "border-zinc-800/50 bg-zinc-800/30 text-zinc-300 rounded-tl-none",
                                        item.accent === "zinc" && "border-zinc-700/50 bg-zinc-800/50 text-zinc-200 rounded-tl-none",
                                        item.accent === "emerald" && "border-emerald-500/20 bg-emerald-500/10 text-zinc-200 rounded-tl-none",
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
                          </div>

                          <div className="space-y-4">
                            <div className="text-lg font-medium text-zinc-200">Workforce Health</div>
                            <div className="rounded-xl border border-zinc-800/80 bg-zinc-900/50 p-5 shadow-sm">
                              <div className="space-y-5">
                                {workload.map((agent) => (
                                  <div key={agent.name} className="space-y-2">
                                    <div className="flex items-center justify-between text-sm">
                                      <div className="flex items-center gap-2">
                                        <div className="flex h-6 w-6 items-center justify-center rounded-full border border-zinc-800 bg-zinc-800 text-[10px] font-bold text-zinc-300">
                                          {agent.name[0]}
                                        </div>
                                        <div className={cn("h-1.5 w-1.5 rounded-full", agent.online ? "bg-emerald-400" : "bg-zinc-600")} />
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
                                  </div>
                                ))}
                              </div>
                            </div>

                            <div className="rounded-xl border border-indigo-500/20 bg-gradient-to-br from-indigo-500/10 via-purple-500/10 to-transparent p-5">
                              <div className="inline-flex items-center rounded-full border border-indigo-500/30 bg-indigo-500/10 px-3 py-1 text-xs font-medium text-indigo-300">
                                <Sparkles className="mr-2 h-3 w-3" />
                                OpenClaw linked
                              </div>
                              <p className="mt-4 text-sm leading-7 text-zinc-300">
                                Local runtimes stay powerful and local. Emperor adds the missing
                                memory, routing, truth, and recoverability layer.
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
            <div className="mx-auto max-w-7xl space-y-12">
              <div className="max-w-3xl space-y-4">
                <div className="text-xs font-medium uppercase tracking-[0.24em] text-indigo-300">
                  Why this is different
                </div>
                <h2 className="font-[var(--font-space-grotesk)] text-4xl font-semibold tracking-tight text-zinc-100">
                  OpenClaw already executes. Emperor makes that execution usable.
                </h2>
                <p className="text-lg leading-8 text-zinc-400">
                  Most agent "mission control" products stop at a shell. Emperor starts where that
                  shell ends: durable work state, seeded doctrine, scoped context, visible team
                  coordination, and a product that comes alive without months of wiring.
                </p>
              </div>

              <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
                {valueCards.map(({ icon: Icon, title, body }) => (
                  <article
                    key={title}
                    className="group rounded-2xl border border-zinc-800/80 bg-zinc-900/50 p-6 shadow-sm transition-all hover:-translate-y-0.5 hover:border-zinc-700/50"
                  >
                    <div className="flex h-11 w-11 items-center justify-center rounded-xl border border-indigo-500/20 bg-indigo-500/10">
                      <Icon className="h-5 w-5 text-indigo-400" />
                    </div>
                    <h3 className="mt-5 text-xl font-semibold text-zinc-100">{title}</h3>
                    <p className="mt-3 text-sm leading-7 text-zinc-400">{body}</p>
                  </article>
                ))}
              </div>

              <div className="grid grid-cols-1 gap-4 lg:grid-cols-[0.95fr_1.05fr]">
                <div className="rounded-2xl border border-zinc-800/80 bg-zinc-900/50 p-6">
                  <div className="text-xs font-medium uppercase tracking-[0.24em] text-zinc-500">
                    Durable primitives
                  </div>
                  <div className="mt-6 grid gap-4">
                    {primitives.map(({ icon: Icon, label, value }) => (
                      <div key={label} className="flex items-start gap-4 rounded-xl bg-zinc-950/60 p-4">
                        <div className="flex h-10 w-10 items-center justify-center rounded-lg border border-zinc-800 bg-zinc-900">
                          <Icon className="h-5 w-5 text-indigo-400" />
                        </div>
                        <div>
                          <div className="text-sm font-medium text-zinc-100">{label}</div>
                          <div className="mt-1 text-sm leading-6 text-zinc-400">{value}</div>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>

                <div className="rounded-2xl border border-zinc-800/80 bg-zinc-900/50 p-6">
                  <div className="text-xs font-medium uppercase tracking-[0.24em] text-zinc-500">
                    What the bridge and runtime give you
                  </div>
                  <div className="mt-6 space-y-4 text-sm leading-7 text-zinc-400">
                    <p>
                      Add an agent once and it exists at both levels: locally in OpenClaw and durably
                      in Emperor.
                    </p>
                    <p>
                      Shared doctrine and scoped resources reach the right agents. Direct inboxes,
                      team threads, and @mentions route work visibly.
                    </p>
                    <p>
                      The result is not just chat. It is a real operating system for autonomous work,
                      with history, ownership, and durable output.
                    </p>
                  </div>
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
                  Emperor Claw is free for now while in beta. We do not guarantee safety, retention,
                  recovery, or suitability of stored data. You remain responsible for what you store
                  here, and you should not place critical or irreplaceable information in the system.
                </p>
              </div>

              <div className="grid gap-3 sm:min-w-[260px]">
                <Link
                  href="/signup"
                  className="inline-flex items-center justify-center gap-2 rounded-xl bg-indigo-600 px-6 py-4 text-sm font-medium text-white shadow-lg shadow-indigo-500/20 transition-all hover:scale-[1.02] hover:bg-indigo-500"
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

function SignalCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-zinc-800/80 bg-zinc-900/50 p-4 shadow-sm">
      <div className="text-[10px] font-medium uppercase tracking-[0.22em] text-zinc-500">{label}</div>
      <div className="mt-2 text-sm font-medium text-zinc-200">{value}</div>
    </div>
  );
}

function SidebarItem({ label, active }: { label: string; active?: boolean }) {
  return (
    <div
      className={cn(
        "flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-all",
        active
          ? "bg-zinc-800/80 text-white ring-1 ring-zinc-700/50"
          : "text-zinc-400 hover:bg-zinc-800/50 hover:text-zinc-100",
      )}
    >
      <div className={cn("h-2 w-2 rounded-full", active ? "bg-indigo-400" : "bg-zinc-700")} />
      <span>{label}</span>
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
  const accentClass =
    accent === "amber"
      ? "bg-amber-500/10"
      : accent === "emerald"
        ? "bg-emerald-500/10"
        : "bg-indigo-500/10";

  const hintClass =
    accent === "amber"
      ? "text-amber-400"
      : accent === "emerald"
        ? "text-emerald-400"
        : "text-indigo-400";

  return (
    <div className="relative h-36 overflow-hidden rounded-xl border border-zinc-800/80 bg-zinc-900/50 p-5 shadow-sm">
      <div className={`absolute right-0 top-0 h-16 w-16 rounded-bl-full blur-xl ${accentClass}`} />
      <div className="text-sm font-medium text-zinc-500">{title}</div>
      <div className="mt-4 text-3xl font-semibold text-zinc-100">{value}</div>
      <div className="mt-2 flex items-center gap-1 text-xs">
        <span className={hintClass}>Live</span>
        <span className="text-zinc-600">{hint}</span>
      </div>
    </div>
  );
}
