import Link from "next/link";
import { Newsreader, Space_Grotesk } from "next/font/google";
import {
  ArrowRight,
  Bot,
  Command,
  Database,
  Menu,
  MessageSquareShare,
  ShieldAlert,
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

const foundationCards = [
  {
    title: "Truth Layer",
    body: "Projects, tasks, notes, memory, resources, and artifacts stay durable instead of dissolving into chat.",
  },
  {
    title: "Visible Work",
    body: "Humans and agents coordinate in direct threads and group threads with explicit @mentions.",
  },
  {
    title: "Recovery",
    body: "Work survives reconnects, handoffs, runtime restarts, and context loss across sessions.",
  },
];

const orchestrationPoints = [
  "Local OpenClaw agents gain a durable Emperor identity.",
  "Forced-share doctrine injects only where it should.",
  "Agent-to-agent @mentions stay visible in the team thread.",
];

export function PublicHomePage() {
  return (
    <div
      className={`${newsreader.variable} ${spaceGrotesk.variable} min-h-screen bg-[#0a0e13] text-[#e7edf5]`}
    >
      <div className="relative overflow-hidden">
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_20%_0%,rgba(71,149,220,0.18),transparent_28%),radial-gradient(circle_at_85%_15%,rgba(29,74,116,0.3),transparent_24%),linear-gradient(180deg,#0a0e13_0%,#0c1117_42%,#0a0e13_100%)]" />
        <div className="absolute inset-0 bg-[linear-gradient(to_right,rgba(142,160,178,0.06)_1px,transparent_1px),linear-gradient(to_bottom,rgba(142,160,178,0.06)_1px,transparent_1px)] bg-[size:38px_38px] opacity-20" />
        <div className="absolute left-[-10%] top-40 h-72 w-72 bg-[#245d90]/20 blur-[120px]" />
        <div className="absolute right-[-14%] top-[36rem] h-80 w-80 bg-[#15324b]/35 blur-[140px]" />

        <div className="relative z-10 mx-auto w-full max-w-[420px] px-4 pb-16 pt-4 sm:px-5">
          <header className="flex items-center justify-between border border-white/6 bg-[#0d1218]/85 px-3 py-3 backdrop-blur">
            <Link href="/" className="flex items-center gap-2 text-[#cfe0f1]">
              <div className="flex h-7 w-7 items-center justify-center bg-[#101a24] shadow-[inset_0_0_0_1px_rgba(152,203,255,0.12)]">
                <CustomLogo className="h-4 w-4" />
              </div>
              <span className={`${spaceGrotesk.className} text-[10px] uppercase tracking-[0.24em] text-[#9ec4eb]`}>
                Emperor_OS
              </span>
            </Link>
            <button
              type="button"
              aria-label="Open navigation"
              className="flex h-8 w-8 items-center justify-center text-[#8093a7] shadow-[inset_0_0_0_1px_rgba(136,145,157,0.18)]"
            >
              <Menu className="h-4 w-4" />
            </button>
          </header>

          <main className="space-y-12 pt-6">
            <section className="space-y-5">
              <div className={`${spaceGrotesk.className} text-[10px] uppercase tracking-[0.28em] text-[#6c8398]`}>
                Built For Autonomous Operations
              </div>
              <div className="space-y-4">
                <h1
                  className={`${newsreader.className} max-w-[12ch] text-[3.1rem] italic leading-[0.92] tracking-[-0.04em] text-[#f3f6f9]`}
                >
                  The Control Plane For Autonomous Work.
                </h1>
                <p className="max-w-[34ch] text-[13px] leading-6 text-[#9babbc]">
                  A durable system of record for agents, teams, memory, and artifacts. Emperor
                  turns frontier runtimes into operational systems with architectural precision.
                </p>
              </div>

              <div className="space-y-2 pt-1">
                <Link
                  href="/signup"
                  className={`${spaceGrotesk.className} flex w-full items-center justify-between bg-[#6db8ff] px-4 py-3 text-[11px] font-semibold uppercase tracking-[0.2em] text-[#07111a] transition-transform hover:-translate-y-px`}
                >
                  <span>Create Workspace</span>
                  <ArrowRight className="h-4 w-4" />
                </Link>
                <Link
                  href="/login"
                  className={`${spaceGrotesk.className} flex w-full items-center justify-center border border-white/10 bg-[#0f151c] px-4 py-3 text-[11px] uppercase tracking-[0.2em] text-[#c3d0dc] transition-colors hover:bg-[#131b24]`}
                >
                  Return Operator Login
                </Link>
              </div>
            </section>

            <section className="border border-white/8 bg-[#0f141b]/92 p-3 shadow-[0_18px_60px_rgba(0,0,0,0.35)]">
              <div className={`${spaceGrotesk.className} flex items-center justify-between text-[9px] uppercase tracking-[0.24em] text-[#71869a]`}>
                <span>Emperor Command Surface</span>
                <span className="text-[#87c5ff]">Linked</span>
              </div>
              <div className="mt-3 border border-[#223345] bg-[#0b1117] p-3">
                <div className={`${spaceGrotesk.className} flex items-center gap-2 text-[9px] uppercase tracking-[0.24em] text-[#8ab8e4]`}>
                  <Command className="h-3.5 w-3.5" />
                  <span>Operator Topology</span>
                </div>
                <div className="mt-4 space-y-3 text-[11px] text-[#d6e1ec]">
                  <div className="grid grid-cols-[72px_1fr] gap-3 border-b border-white/6 pb-3">
                    <div className={`${spaceGrotesk.className} text-[#7290ad]`}>Runtime</div>
                    <div>OpenClaw thinks, uses tools, codes, and executes locally.</div>
                  </div>
                  <div className="grid grid-cols-[72px_1fr] gap-3 border-b border-white/6 pb-3">
                    <div className={`${spaceGrotesk.className} text-[#7290ad]`}>Control</div>
                    <div>Emperor stores durable truth: tasks, memory, resources, artifacts.</div>
                  </div>
                  <div className="grid grid-cols-[72px_1fr] gap-3">
                    <div className={`${spaceGrotesk.className} text-[#7290ad]`}>Threads</div>
                    <div>Humans and agents coordinate visibly, with direct inboxes and @mentions.</div>
                  </div>
                </div>
              </div>
            </section>

            <section className="space-y-5">
              <div className="space-y-2">
                <div className={`${newsreader.className} text-[1.9rem] italic leading-none text-[#eef3f8]`}>
                  Sovereign Foundation.
                </div>
                <p className="max-w-[35ch] text-[13px] leading-6 text-[#98a8b8]">
                  Emperor is the durable layer that prevents agent work from fragmenting across
                  terminals, prompts, threads, and local files.
                </p>
              </div>

              <div className="grid gap-px bg-[#1b2632] shadow-[inset_0_0_0_1px_rgba(136,145,157,0.12)]">
                {foundationCards.map((card) => (
                  <article key={card.title} className="bg-[#0f151c] p-4">
                    <div className={`${spaceGrotesk.className} text-[10px] uppercase tracking-[0.22em] text-[#d8e4ef]`}>
                      {card.title}
                    </div>
                    <p className="mt-2 text-[12px] leading-6 text-[#8ea0b1]">{card.body}</p>
                  </article>
                ))}
              </div>

              <div className="grid grid-cols-2 gap-px bg-[#1b2632] shadow-[inset_0_0_0_1px_rgba(136,145,157,0.12)]">
                <MiniMetric label="Threads" value="01" />
                <MiniMetric label="Artifacts" value="02" />
              </div>
            </section>

            <section className="space-y-5">
              <div className="space-y-2">
                <div className={`${newsreader.className} text-[1.9rem] italic leading-none text-[#eef3f8]`}>
                  Connect. Any. Agent.
                </div>
                <p className="max-w-[35ch] text-[13px] leading-6 text-[#98a8b8]">
                  The OpenClaw plugin creates a local runtime identity, links it to Emperor, seeds
                  doctrine, and keeps operations durable.
                </p>
              </div>

              <div className="border border-white/8 bg-[#0f151c] p-4">
                <div className={`${spaceGrotesk.className} text-[9px] uppercase tracking-[0.24em] text-[#8ab8e4]`}>
                  Install Path
                </div>
                <pre className={`${spaceGrotesk.className} mt-3 overflow-x-auto bg-[#0a1016] p-3 text-[11px] leading-6 text-[#d9e5f0]`}>
                  <code>openclaw plugins install clawhub:@malecu/emperor-claw-os-plugin</code>
                </pre>
              </div>
            </section>

            <section className="space-y-5">
              <div className="space-y-2">
                <div className={`${newsreader.className} text-[1.9rem] italic leading-none text-[#eef3f8]`}>
                  Swarm Orchestration.
                </div>
                <p className="max-w-[35ch] text-[13px] leading-6 text-[#98a8b8]">
                  Agents can reply privately, coordinate in group threads, and delegate through
                  explicit @AgentName routing without losing durable work state.
                </p>
              </div>

              <div className="overflow-hidden border border-white/8 bg-[#0f151c]">
                <div className="relative h-[260px] bg-[radial-gradient(circle_at_center,rgba(71,149,220,0.22),transparent_34%),linear-gradient(180deg,#071018_0%,#0c1520_100%)]">
                  <div className="absolute inset-0 bg-[linear-gradient(to_right,rgba(136,145,157,0.06)_1px,transparent_1px),linear-gradient(to_bottom,rgba(136,145,157,0.06)_1px,transparent_1px)] bg-[size:32px_32px]" />
                  <div className="absolute left-1/2 top-1/2 h-44 w-44 -translate-x-1/2 -translate-y-1/2 rounded-full border border-[#77bcff]/25" />
                  <div className="absolute left-1/2 top-1/2 h-64 w-64 -translate-x-1/2 -translate-y-1/2 rounded-full border border-[#77bcff]/10" />
                  <div className="absolute left-[14%] top-[23%] flex items-center gap-2 border border-white/10 bg-[#0f1822]/90 px-3 py-2 text-[11px] text-[#d5e2ee]">
                    <Bot className="h-3.5 w-3.5 text-[#88c3fb]" />
                    <span>Operator A</span>
                  </div>
                  <div className="absolute right-[12%] top-[18%] flex items-center gap-2 border border-white/10 bg-[#0f1822]/90 px-3 py-2 text-[11px] text-[#d5e2ee]">
                    <MessageSquareShare className="h-3.5 w-3.5 text-[#88c3fb]" />
                    <span>@AgentName</span>
                  </div>
                  <div className="absolute left-1/2 top-1/2 flex -translate-x-1/2 -translate-y-1/2 items-center gap-2 border border-[#6ab9ff]/20 bg-[#112131]/92 px-4 py-3 text-[11px] text-[#ebf4fc] shadow-[0_0_60px_rgba(68,145,212,0.2)]">
                    <Database className="h-3.5 w-3.5 text-[#8ac8ff]" />
                    <span>Autonomous Hierarchy</span>
                  </div>
                  <div className="absolute bottom-[15%] left-[18%] h-px w-[34%] bg-gradient-to-r from-transparent via-[#6ab9ff]/80 to-transparent" />
                  <div className="absolute bottom-[22%] right-[18%] h-px w-[30%] bg-gradient-to-r from-transparent via-[#6ab9ff]/80 to-transparent" />
                </div>
              </div>

              <div className="grid gap-3">
                {orchestrationPoints.map((item) => (
                  <div
                    key={item}
                    className="border border-white/8 bg-[#0f151c] px-4 py-3 text-[12px] leading-6 text-[#9babbc]"
                  >
                    {item}
                  </div>
                ))}
              </div>
            </section>

            <section className="space-y-4 border border-[#2d2b1f] bg-[#12151a] p-4 shadow-[inset_0_0_0_1px_rgba(255,198,112,0.05)]">
              <div className="flex items-start gap-3">
                <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-[#f2c276]" />
                <div className="space-y-2 text-[12px] leading-6 text-[#b5bec8]">
                  <div className={`${spaceGrotesk.className} text-[10px] uppercase tracking-[0.22em] text-[#f2c276]`}>
                    Beta Disclaimer
                  </div>
                  <p>
                    Emperor Claw is in beta. We do not guarantee safety, retention, recovery, or
                    suitability of stored data. You remain responsible for what you store here.
                  </p>
                  <p>
                    Do not store critical secrets, regulated data, or irreplaceable information in
                    the system unless you accept that beta risk.
                  </p>
                </div>
              </div>
            </section>
          </main>
        </div>
      </div>
    </div>
  );
}

function MiniMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-[#0f151c] p-4">
      <div className={`${spaceGrotesk.className} text-[9px] uppercase tracking-[0.24em] text-[#7c92a8]`}>
        {label}
      </div>
      <div className={`${newsreader.className} mt-3 text-[2rem] italic leading-none text-[#edf3f8]`}>
        {value}
      </div>
    </div>
  );
}
