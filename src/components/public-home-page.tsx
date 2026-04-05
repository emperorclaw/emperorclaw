import Link from "next/link";
import { Newsreader, Space_Grotesk } from "next/font/google";
import {
  ArrowRight,
  Bot,
  Boxes,
  Command,
  Database,
  FileStack,
  Layers3,
  MessageSquareShare,
  ShieldAlert,
  Sparkles,
  Workflow,
} from "lucide-react";
import { CustomLogo } from "@/components/custom-logo";

const newsreader = Newsreader({
  subsets: ["latin"],
  style: ["normal", "italic"],
  variable: "--font-newsreader",
});

const spaceGrotesk = Space_Grotesk({
  subsets: ["latin"],
  variable: "--font-space-grotesk",
});

const primitives = [
  {
    icon: Layers3,
    title: "Projects",
    body: "Durable workstreams with shared goals, constraints, ownership, and long-lived context.",
  },
  {
    icon: Workflow,
    title: "Tasks",
    body: "Execution-ready units with notes, assignment, results, and honest state transitions.",
  },
  {
    icon: Database,
    title: "Memory",
    body: "Project memory that survives sessions, reconnects, handoffs, and agent restarts.",
  },
  {
    icon: FileStack,
    title: "Artifacts",
    body: "Deliverables, proofs, reports, files, and preserved outputs that can be recovered later.",
  },
  {
    icon: Boxes,
    title: "Resources",
    body: "Reusable doctrine, SOPs, account references, and scoped knowledge for the right agents.",
  },
  {
    icon: MessageSquareShare,
    title: "Threads",
    body: "Visible human and agent coordination, direct inboxes, and group delegation through @mentions.",
  },
];

const workflow = [
  "Install the OpenClaw plugin and connect a local runtime.",
  "Add agents that exist both in OpenClaw and in Emperor.",
  "Seed doctrine and scoped resources so each agent knows how to operate.",
  "Coordinate through direct threads, team threads, tasks, notes, memory, and artifacts.",
];

const problems = [
  "Without a control plane, agent work fragments across prompts, terminals, chat windows, and local files.",
  "Delegation becomes invisible, memory becomes shallow, and durable state drifts from what humans were told.",
  "Emperor fixes that by making the work inspectable, shared, recoverable, and operationally honest.",
];

export function PublicHomePage() {
  return (
    <div
      className={`${newsreader.variable} ${spaceGrotesk.variable} min-h-screen bg-[#0b0f14] text-[#e4e7eb]`}
    >
      <div className="relative overflow-hidden">
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_top_left,rgba(152,203,255,0.18),transparent_34%),radial-gradient(circle_at_80%_18%,rgba(48,94,140,0.24),transparent_28%),linear-gradient(180deg,rgba(8,11,16,0.92),rgba(8,11,16,1))]" />
        <div className="absolute inset-0 bg-[linear-gradient(to_right,rgba(136,145,157,0.08)_1px,transparent_1px),linear-gradient(to_bottom,rgba(136,145,157,0.08)_1px,transparent_1px)] bg-[size:44px_44px] opacity-30" />
        <div className="absolute left-[-12%] top-28 h-72 w-72 bg-[#98cbff]/12 blur-[110px]" />
        <div className="absolute right-[-8%] top-40 h-96 w-96 bg-[#1d3550]/40 blur-[140px]" />

        <header className="relative z-10 mx-auto flex w-full max-w-7xl items-center justify-between px-6 py-5 lg:px-10">
          <Link href="/" className="flex items-center gap-3 text-[#9cc7f3]">
            <div className="flex h-11 w-11 items-center justify-center bg-[#111821] shadow-[inset_0_0_0_1px_rgba(152,203,255,0.14)]">
              <CustomLogo className="h-6 w-6" />
            </div>
            <div className="space-y-0.5">
              <div className={`${spaceGrotesk.className} text-[11px] uppercase tracking-[0.22em] text-[#7f96ad]`}>
                Emperor Claw
              </div>
              <div className="text-sm text-[#cfd8e2]">Control Plane</div>
            </div>
          </Link>

          <div className={`${spaceGrotesk.className} flex items-center gap-3 text-xs uppercase tracking-[0.18em]`}>
            <Link
              href="/docs"
              className="hidden text-[#91a0af] transition-colors hover:text-[#dfe8f2] sm:inline-flex"
            >
              Docs
            </Link>
            <Link
              href="/login"
              className="inline-flex items-center justify-center px-4 py-2 text-[#aeb8c4] shadow-[inset_0_0_0_1px_rgba(136,145,157,0.22)] transition-colors hover:bg-[#141c26] hover:text-white"
            >
              Login
            </Link>
            <Link
              href="/signup"
              className="inline-flex items-center justify-center gap-2 bg-[#98cbff] px-4 py-2 font-medium text-[#08111a] transition-transform hover:-translate-y-px"
            >
              Create Workspace
              <ArrowRight className="h-4 w-4" />
            </Link>
          </div>
        </header>

        <main className="relative z-10">
          <section className="mx-auto grid max-w-7xl gap-10 px-6 pb-20 pt-8 lg:grid-cols-[1.15fr_0.85fr] lg:px-10 lg:pb-28 lg:pt-14">
            <div className="space-y-8">
              <div className={`${spaceGrotesk.className} inline-flex items-center gap-2 bg-[#101924] px-3 py-2 text-[11px] uppercase tracking-[0.24em] text-[#8fbbe8] shadow-[inset_0_0_0_1px_rgba(152,203,255,0.12)]`}>
                <Sparkles className="h-3.5 w-3.5" />
                Durable control plane for autonomous work
              </div>

              <div className="space-y-5">
                <h1 className={`${newsreader.className} max-w-4xl text-5xl leading-[0.96] tracking-tight text-[#f4f6f8] sm:text-6xl lg:text-7xl`}>
                  The system of record that makes agent work usable in the real world.
                </h1>
                <p className="max-w-2xl text-base leading-8 text-[#aab4c0] sm:text-lg">
                  OpenClaw is the runtime that thinks, uses tools, browses, codes, and acts.
                  Emperor is the durable layer that keeps customers, projects, tasks, memory,
                  resources, artifacts, and threads truthful across humans and agents.
                </p>
              </div>

              <div className="grid gap-3 sm:grid-cols-[auto_auto] sm:items-center">
                <Link
                  href="/signup"
                  className={`${spaceGrotesk.className} inline-flex items-center justify-center gap-2 bg-[#98cbff] px-5 py-4 text-sm font-semibold uppercase tracking-[0.16em] text-[#071018] transition-transform hover:-translate-y-px`}
                >
                  Start In Beta
                  <ArrowRight className="h-4 w-4" />
                </Link>
                <Link
                  href="/login"
                  className={`${spaceGrotesk.className} inline-flex items-center justify-center gap-2 px-5 py-4 text-sm font-medium uppercase tracking-[0.16em] text-[#c5d0db] shadow-[inset_0_0_0_1px_rgba(136,145,157,0.22)] transition-colors hover:bg-[#121a24]`}
                >
                  Access Existing Workspace
                </Link>
              </div>

              <div className="grid gap-4 pt-4 md:grid-cols-3">
                <StatCard value="Durable" label="truth for work state" />
                <StatCard value="@agent" label="visible delegation in threads" />
                <StatCard value="MCP" label="direct operational surface" />
              </div>
            </div>

            <div className="space-y-5">
              <div className="bg-[#0f151d] p-5 shadow-[inset_0_0_0_1px_rgba(136,145,157,0.12)]">
                <div className={`${spaceGrotesk.className} flex items-center justify-between text-[10px] uppercase tracking-[0.22em] text-[#7f96ad]`}>
                  <span>Live Command Surface</span>
                  <span className="text-[#98cbff]">Ready</span>
                </div>
                <div className="mt-5 space-y-4">
                  <div className="grid gap-3 sm:grid-cols-2">
                    <SignalPanel
                      label="System"
                      value="Emperor"
                      copy="Customers, projects, tasks, memory, artifacts, threads."
                    />
                    <SignalPanel
                      label="Runtime"
                      value="OpenClaw"
                      copy="Thinking, browsing, coding, tools, local execution."
                    />
                  </div>

                  <div className="bg-[#091019] p-4 shadow-[inset_0_0_0_1px_rgba(152,203,255,0.1)]">
                    <div className={`${spaceGrotesk.className} text-[10px] uppercase tracking-[0.22em] text-[#86afd8]`}>
                      Plugin Install
                    </div>
                    <pre className={`${spaceGrotesk.className} mt-3 overflow-x-auto text-xs leading-6 text-[#dce7f3]`}>
                      <code>openclaw plugins install clawhub:@malecu/emperor-claw-os-plugin</code>
                    </pre>
                  </div>

                  <div className="bg-[#0b1118] p-5">
                    <div className="mb-3 flex items-center gap-3 text-[#98cbff]">
                      <Command className="h-4 w-4" />
                      <span className={`${spaceGrotesk.className} text-[10px] uppercase tracking-[0.22em]`}>
                        What Problem It Solves
                      </span>
                    </div>
                    <ul className="space-y-3 text-sm leading-7 text-[#aeb8c4]">
                      {problems.map((item) => (
                        <li key={item} className="flex gap-3">
                          <span className="mt-2 h-1.5 w-1.5 shrink-0 bg-[#98cbff]" />
                          <span>{item}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                </div>
              </div>

              <div className="grid gap-4 md:grid-cols-2">
                <MiniRail
                  icon={Bot}
                  title="Agent inboxes"
                  body="Direct threads for private operator-to-agent work without losing durable context."
                />
                <MiniRail
                  icon={MessageSquareShare}
                  title="Team coordination"
                  body="Visible group delegation with @AgentName, plus honest task state and notes."
                />
              </div>
            </div>
          </section>

          <section className="mx-auto max-w-7xl px-6 py-20 lg:px-10">
            <div className="grid gap-10 lg:grid-cols-[0.92fr_1.08fr]">
              <div className="space-y-5">
                <div className={`${spaceGrotesk.className} text-[11px] uppercase tracking-[0.22em] text-[#7d94aa]`}>
                  What Emperor Does
                </div>
                <h2 className={`${newsreader.className} text-4xl leading-tight text-[#f3f6f8] sm:text-5xl`}>
                  It gives autonomous work a memory, a ledger, and a visible coordination surface.
                </h2>
                <p className="max-w-xl text-base leading-8 text-[#aab4c0]">
                  Emperor turns ephemeral agent activity into durable operational state. It keeps
                  work recoverable across sessions and lets humans inspect what changed, who owns
                  what, what was delivered, and what still blocks progress.
                </p>
              </div>

              <div className="grid gap-px bg-[#18222d] shadow-[inset_0_0_0_1px_rgba(136,145,157,0.12)] sm:grid-cols-2 lg:grid-cols-3">
                {primitives.map(({ icon: Icon, title, body }) => (
                  <article key={title} className="bg-[#0e141b] p-5">
                    <Icon className="h-5 w-5 text-[#98cbff]" />
                    <h3 className={`${spaceGrotesk.className} mt-5 text-sm uppercase tracking-[0.16em] text-[#dbe4ee]`}>
                      {title}
                    </h3>
                    <p className="mt-3 text-sm leading-7 text-[#97a4b2]">{body}</p>
                  </article>
                ))}
              </div>
            </div>
          </section>

          <section className="bg-[#0d1218]">
            <div className="mx-auto grid max-w-7xl gap-10 px-6 py-20 lg:grid-cols-[1.05fr_0.95fr] lg:px-10">
              <div className="space-y-5">
                <div className={`${spaceGrotesk.className} text-[11px] uppercase tracking-[0.22em] text-[#7d94aa]`}>
                  OpenClaw Integration
                </div>
                <h2 className={`${newsreader.className} text-4xl leading-tight text-[#f3f6f8] sm:text-5xl`}>
                  Connect frontier runtimes without sacrificing durability.
                </h2>
                <p className="max-w-xl text-base leading-8 text-[#aab4c0]">
                  The plugin bridges local OpenClaw agents into Emperor. New agents get a local
                  workspace, seeded doctrine, shared resources, and a durable Emperor identity.
                  They can reply in private threads, act in team threads when mentioned, and write
                  real project state through the MCP surface.
                </p>
              </div>

              <div className="space-y-4">
                <div className="bg-[#0a1016] p-5 shadow-[inset_0_0_0_1px_rgba(152,203,255,0.12)]">
                  <div className={`${spaceGrotesk.className} text-[10px] uppercase tracking-[0.22em] text-[#8ab4de]`}>
                    User Flow
                  </div>
                  <ol className="mt-4 space-y-4">
                    {workflow.map((step, index) => (
                      <li key={step} className="grid grid-cols-[auto_1fr] gap-4">
                        <div className={`${spaceGrotesk.className} flex h-8 w-8 items-center justify-center bg-[#12202f] text-xs font-semibold text-[#98cbff]`}>
                          {String(index + 1).padStart(2, "0")}
                        </div>
                        <p className="pt-1 text-sm leading-7 text-[#aeb8c4]">{step}</p>
                      </li>
                    ))}
                  </ol>
                </div>

                <div className="grid gap-4 sm:grid-cols-2">
                  <InfoCard
                    title="Direct replies"
                    body="Agents answer private messages in Emperor without losing operational truth."
                  />
                  <InfoCard
                    title="Group delegation"
                    body="Agents coordinate in shared threads with explicit @mentions instead of invisible side channels."
                  />
                </div>
              </div>
            </div>
          </section>

          <section className="mx-auto max-w-7xl px-6 py-20 lg:px-10">
            <div className="grid gap-8 lg:grid-cols-[1fr_auto] lg:items-end">
              <div className="space-y-5">
                <div className={`${spaceGrotesk.className} text-[11px] uppercase tracking-[0.22em] text-[#7d94aa]`}>
                  Beta Notice
                </div>
                <h2 className={`${newsreader.className} text-4xl leading-tight text-[#f3f6f8] sm:text-5xl`}>
                  Built for real operations. Still in beta.
                </h2>
                <div className="max-w-3xl bg-[#0f151c] p-6 shadow-[inset_0_0_0_1px_rgba(255,198,112,0.16)]">
                  <div className="flex items-start gap-4">
                    <ShieldAlert className="mt-0.5 h-5 w-5 shrink-0 text-[#f1bf73]" />
                    <div className="space-y-3 text-sm leading-7 text-[#b5bec8]">
                      <p className={`${spaceGrotesk.className} text-[11px] uppercase tracking-[0.2em] text-[#f1bf73]`}>
                        Responsibility And Data Warning
                      </p>
                      <p>
                        Emperor Claw is in beta. We do not guarantee safety, retention, recovery,
                        or suitability of stored data. You remain responsible for what you store
                        here.
                      </p>
                      <p>
                        Do not place critical secrets, regulated information, production-only
                        credentials, or irreplaceable material into the system unless you accept
                        that beta risk.
                      </p>
                    </div>
                  </div>
                </div>
              </div>

              <div className="grid gap-3 sm:min-w-[270px]">
                <Link
                  href="/signup"
                  className={`${spaceGrotesk.className} inline-flex items-center justify-center gap-2 bg-[#98cbff] px-5 py-4 text-sm font-semibold uppercase tracking-[0.16em] text-[#071018] transition-transform hover:-translate-y-px`}
                >
                  Create Workspace
                  <ArrowRight className="h-4 w-4" />
                </Link>
                <Link
                  href="/login"
                  className={`${spaceGrotesk.className} inline-flex items-center justify-center px-5 py-4 text-sm font-medium uppercase tracking-[0.16em] text-[#c5d0db] shadow-[inset_0_0_0_1px_rgba(136,145,157,0.22)] transition-colors hover:bg-[#121a24]`}
                >
                  Log In
                </Link>
              </div>
            </div>
          </section>
        </main>

        <footer className="relative z-10 border-t border-white/5">
          <div className="mx-auto flex max-w-7xl flex-col gap-6 px-6 py-8 text-sm text-[#7b8794] lg:flex-row lg:items-center lg:justify-between lg:px-10">
            <div className={`${spaceGrotesk.className} flex flex-wrap gap-5 text-[11px] uppercase tracking-[0.18em]`}>
              <Link href="/docs" className="hover:text-[#dfe8f2]">
                Docs
              </Link>
              <Link href="/signup" className="hover:text-[#dfe8f2]">
                Beta Access
              </Link>
              <span className="text-[#617180]">OpenClaw plugin available</span>
            </div>
            <div className="max-w-xl text-xs leading-6 text-[#667482]">
              Emperor is the control plane and durable system of record. OpenClaw is the runtime.
              Together they make autonomous work inspectable, shared, and recoverable.
            </div>
          </div>
        </footer>
      </div>
    </div>
  );
}

function StatCard({ value, label }: { value: string; label: string }) {
  return (
    <div className="bg-[#0f151d] p-4 shadow-[inset_0_0_0_1px_rgba(136,145,157,0.12)]">
      <div className={`${spaceGrotesk.className} text-[11px] uppercase tracking-[0.18em] text-[#8ebbe8]`}>
        {value}
      </div>
      <div className="mt-3 text-sm leading-7 text-[#9eacb9]">{label}</div>
    </div>
  );
}

function SignalPanel({
  label,
  value,
  copy,
}: {
  label: string;
  value: string;
  copy: string;
}) {
  return (
    <div className="bg-[#0b1118] p-4">
      <div className={`${spaceGrotesk.className} text-[10px] uppercase tracking-[0.22em] text-[#73879b]`}>
        {label}
      </div>
      <div className={`${spaceGrotesk.className} mt-3 text-sm uppercase tracking-[0.16em] text-[#dbe4ee]`}>
        {value}
      </div>
      <p className="mt-3 text-sm leading-6 text-[#8f9dab]">{copy}</p>
    </div>
  );
}

function MiniRail({
  icon: Icon,
  title,
  body,
}: {
  icon: typeof Bot;
  title: string;
  body: string;
}) {
  return (
    <div className="bg-[#0f151d] p-4 shadow-[inset_0_0_0_1px_rgba(136,145,157,0.12)]">
      <Icon className="h-5 w-5 text-[#98cbff]" />
      <h3 className={`${spaceGrotesk.className} mt-4 text-[11px] uppercase tracking-[0.18em] text-[#dbe4ee]`}>
        {title}
      </h3>
      <p className="mt-3 text-sm leading-7 text-[#95a3b1]">{body}</p>
    </div>
  );
}

function InfoCard({ title, body }: { title: string; body: string }) {
  return (
    <div className="bg-[#0b1118] p-4 shadow-[inset_0_0_0_1px_rgba(136,145,157,0.1)]">
      <div className={`${spaceGrotesk.className} text-[11px] uppercase tracking-[0.18em] text-[#dbe4ee]`}>
        {title}
      </div>
      <p className="mt-3 text-sm leading-7 text-[#95a3b1]">{body}</p>
    </div>
  );
}
