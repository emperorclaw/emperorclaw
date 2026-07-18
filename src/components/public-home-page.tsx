import Link from "next/link";
import { DM_Sans, Space_Grotesk, Syncopate } from "next/font/google";
import {
  ArrowRight,
  Bot,
  Boxes,
  BrainCircuit,
  Check,
  ChevronRight,
  CircleDotDashed,
  Command,
  Database,
  FileBox,
  Gem,
  GitBranch,
  LockKeyhole,
  MessageSquare,
  Network,
  Orbit,
  Radar,
  ShieldAlert,
  Sparkles,
  Workflow,
  Zap,
} from "lucide-react";
import { CustomLogo } from "@/components/custom-logo";

const spaceGrotesk = Space_Grotesk({ subsets: ["latin"], variable: "--font-space-grotesk" });
const dmSans = DM_Sans({ subsets: ["latin"], variable: "--font-dm-sans" });
const syncopate = Syncopate({ subsets: ["latin"], weight: ["400", "700"], variable: "--font-syncopate" });

const heroStats = [
  { label: "Runtime mesh", value: "Hermes + OpenClaw", detail: "local execution stays local" },
  { label: "Durable layer", value: "Tasks · KB · Storage", detail: "truth survives every chat" },
  { label: "Open source", value: "FSL-1.1-Apache-2.0", detail: "self-host freely, no paywall" },
];

const pillars = [
  {
    icon: Bot,
    kicker: "Bootstrap",
    title: "Agents arrive with doctrine, not amnesia.",
    body: "New runtimes receive the company operating model, scoped rules, inboxes, and shared context before they start guessing.",
  },
  {
    icon: Database,
    kicker: "Memory",
    title: "The durable record lives outside the chat.",
    body: "Tasks, knowledge, files, threads, customers, projects, notes, and decisions become queryable company state.",
  },
  {
    icon: MessageSquare,
    kicker: "Coordination",
    title: "Human operators can see the whole swarm.",
    body: "Direct messages, team rooms, handoffs, approvals, and incidents become visible operations instead of hidden local side effects.",
  },
];

const primitives = [
  { icon: Workflow, title: "Task rails", body: "Ownership, status, review notes, and durable results for work that must actually land." },
  { icon: Boxes, title: "Knowledge & rules", body: "Shared doctrine, SOPs, client context, and project rules routed to the right runtime." },
  { icon: FileBox, title: "Storage discipline", body: "Folder-first artifacts, evidence, reports, and deliverables behind one Emperor abstraction." },
  { icon: Network, title: "Runtime mesh", body: "Hermes and OpenClaw keep their strengths while Emperor standardizes the operating layer." },
];

const signalSteps = [
  "Runtime boots and asks Emperor who it is.",
  "Emperor returns doctrine, scoped knowledge, inboxes, tasks, and rules.",
  "Agent executes locally, then writes durable truth back.",
  "Operators inspect, redirect, recover, and scale from one control plane.",
];

const telemetry = [
  { name: "Doctrine sync", value: "99.8%", hue: "from-cyan-300 to-blue-500" },
  { name: "Recovered context", value: "14k", hue: "from-fuchsia-300 to-violet-500" },
  { name: "Routed handoffs", value: "328", hue: "from-amber-200 to-orange-500" },
];

const orbitNodes = ["Hermes", "OpenClaw", "KB", "Tasks", "Storage", "Threads"];

const commandLines = [
  { label: "@Growth", text: "Found campaign evidence. Saving to /clients/acme/2026-07/reports.", tone: "cyan" },
  { label: "@Architect", text: "Bridge session recovered. Doctrine loaded from shared Emperor resource.", tone: "violet" },
  { label: "@Operator", text: "Approve the deployment window, then notify finance and QA.", tone: "amber" },
];

const proofSignals = [
  "central doctrine",
  "folder-first storage",
  "agent inboxes",
  "durable tasks",
  "runtime memory",
  "operator recovery",
];

export function PublicHomePage() {
  return (
    <div
      className={`${spaceGrotesk.variable} ${dmSans.variable} ${syncopate.variable} min-h-screen overflow-hidden bg-[#02030a] font-[var(--font-dm-sans)] text-white selection:bg-cyan-300 selection:text-slate-950`}
    >
      <style>{`
        @keyframes emperor-orbit { from { transform: rotateX(62deg) rotateZ(0deg); } to { transform: rotateX(62deg) rotateZ(360deg); } }
        @keyframes emperor-counter-orbit { from { transform: rotateZ(0deg) rotateX(-62deg); } to { transform: rotateZ(-360deg) rotateX(-62deg); } }
        @keyframes emperor-scan { 0% { transform: translateY(-120%); opacity: 0; } 12%, 55% { opacity: .7; } 100% { transform: translateY(420%); opacity: 0; } }
        @keyframes emperor-pulse-ring { 0% { transform: scale(.78); opacity: .65; } 100% { transform: scale(1.35); opacity: 0; } }
        @keyframes emperor-float { 0%,100% { transform: translateY(0) rotateX(0) rotateY(0); } 50% { transform: translateY(-18px) rotateX(2deg) rotateY(-3deg); } }
        @keyframes emperor-meteor { 0% { transform: translate3d(-20vw,-10vh,0) rotate(18deg); opacity: 0; } 8% { opacity: .8; } 45%,100% { transform: translate3d(120vw,48vh,0) rotate(18deg); opacity: 0; } }
        .emperor-grid-mask { mask-image: radial-gradient(circle at 50% 24%, black 0%, black 42%, transparent 74%); }
        .emperor-card-3d { transform-style: preserve-3d; transform: perspective(1200px) rotateX(10deg) rotateY(-13deg) rotateZ(1deg); }
        .emperor-card-3d:hover { transform: perspective(1200px) rotateX(7deg) rotateY(-8deg) rotateZ(0deg) translateY(-4px); }
        .emperor-orbit { transform-style: preserve-3d; animation: emperor-orbit 26s linear infinite; }
        .emperor-counter-orbit { animation: emperor-counter-orbit 26s linear infinite; }
        .emperor-scanline { animation: emperor-scan 5.8s ease-in-out infinite; }
        .emperor-floating { animation: emperor-float 8s ease-in-out infinite; }
        .emperor-meteor { animation: emperor-meteor 9s ease-in-out infinite; }
        .emperor-delay-2 { animation-delay: -5s; }
        @media (prefers-reduced-motion: reduce) {
          .emperor-orbit,.emperor-counter-orbit,.emperor-scanline,.emperor-floating,.emperor-meteor,[data-emperor-animated="true"] { animation: none !important; transition-duration: .01ms !important; }
          .emperor-card-3d,.emperor-card-3d:hover { transform: none !important; }
        }
      `}</style>

      <div className="pointer-events-none fixed inset-0 z-0">
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_18%_8%,rgba(125,92,255,0.32),transparent_28%),radial-gradient(circle_at_76%_0%,rgba(34,211,238,0.22),transparent_30%),radial-gradient(circle_at_52%_86%,rgba(244,114,182,0.18),transparent_34%),linear-gradient(180deg,#02030a_0%,#050816_46%,#02030a_100%)]" />
        <div className="emperor-grid-mask absolute inset-0 bg-[linear-gradient(to_right,rgba(255,255,255,0.09)_1px,transparent_1px),linear-gradient(to_bottom,rgba(255,255,255,0.06)_1px,transparent_1px)] bg-[size:72px_72px] opacity-30" />
        <div className="absolute left-1/2 top-[-18rem] h-[48rem] w-[48rem] -translate-x-1/2 rounded-full border border-cyan-300/10 bg-cyan-300/5 blur-3xl" />
        <div className="emperor-meteor absolute left-0 top-16 h-[2px] w-48 rounded-full bg-gradient-to-r from-transparent via-cyan-200 to-transparent" />
        <div className="emperor-meteor emperor-delay-2 absolute left-0 top-64 h-[2px] w-64 rounded-full bg-gradient-to-r from-transparent via-fuchsia-200 to-transparent" />
        <div className="absolute inset-x-0 bottom-0 h-64 bg-gradient-to-t from-[#02030a] to-transparent" />
      </div>

      <header className="fixed left-0 right-0 top-0 z-50 px-4 pt-4 sm:px-6">
        <div className="mx-auto flex max-w-7xl items-center justify-between rounded-2xl border border-white/10 bg-slate-950/55 px-4 py-3 shadow-[0_24px_80px_rgba(0,0,0,0.28)] backdrop-blur-2xl sm:px-5">
          <Link href="/" className="group flex items-center gap-3 rounded-xl focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-cyan-300">
            <div className="relative flex h-10 w-10 items-center justify-center rounded-2xl border border-cyan-300/25 bg-cyan-300/10 shadow-[0_0_40px_rgba(34,211,238,0.22)] transition-transform duration-300 group-hover:-translate-y-0.5">
              <div className="absolute inset-0 rounded-2xl bg-gradient-to-br from-cyan-300/20 via-violet-400/20 to-fuchsia-300/20" />
              <CustomLogo className="relative h-5 w-5 text-cyan-200" />
            </div>
            <div>
              <div className="font-[var(--font-space-grotesk)] text-sm font-semibold tracking-tight text-white">Emperor Claw</div>
              <div className="font-[var(--font-syncopate)] text-[9px] uppercase tracking-[0.22em] text-cyan-200/65">Runtime Control Plane</div>
            </div>
          </Link>

          <nav className="hidden items-center gap-2 rounded-full border border-white/10 bg-white/[0.03] p-1 text-xs font-medium text-slate-300 lg:flex">
            {[
              ["System", "#system"],
              ["Doctrine", "#doctrine"],
              ["Mesh", "#mesh"],
              ["Docs", "/docs"],
            ].map(([label, href]) =>
              href.startsWith("#") ? (
                <a key={label} href={href} className="rounded-full px-4 py-2 transition-colors duration-200 hover:bg-white/10 hover:text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-cyan-300">
                  {label}
                </a>
              ) : (
                <Link key={label} href={href} className="rounded-full px-4 py-2 transition-colors duration-200 hover:bg-white/10 hover:text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-cyan-300">
                  {label}
                </Link>
              ),
            )}
          </nav>

          <div className="flex items-center gap-2 sm:gap-3">
            <a href="https://github.com/emperorclaw/emperorclaw" target="_blank" rel="noopener noreferrer" className="hidden rounded-xl px-3 py-2 text-sm font-medium text-slate-400 transition-colors duration-200 hover:text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-cyan-300 sm:inline-flex items-center gap-1.5" title="View on GitHub">
              <svg className="h-4 w-4" viewBox="0 0 24 24" fill="currentColor"><path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z"/></svg>
              GitHub
            </a>
            <Link href="/login" className="hidden rounded-xl px-3 py-2 text-sm font-medium text-slate-300 transition-colors duration-200 hover:text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-cyan-300 sm:inline-flex">
              Login
            </Link>
            <Link href="/signup" className="inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-xl border border-cyan-200/30 bg-cyan-200 px-3 py-2.5 text-xs font-bold text-slate-950 shadow-[0_0_34px_rgba(103,232,249,0.34)] transition duration-200 hover:-translate-y-0.5 hover:bg-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-cyan-300 sm:px-4 sm:text-sm">
              Self-Host
              <ArrowRight className="h-4 w-4" />
            </Link>
          </div>
        </div>
      </header>

      <main className="relative z-10">
        <section className="relative px-5 pb-24 pt-32 sm:px-6 sm:pt-40 lg:px-8 lg:pb-32">
          <div className="mx-auto grid max-w-7xl items-center gap-14 lg:grid-cols-[0.92fr_1.08fr]">
            <div className="space-y-8">
              <div className="inline-flex max-w-full items-center gap-2 rounded-full border border-white/10 bg-white/[0.04] px-3 py-1.5 text-xs font-semibold text-cyan-100 shadow-[inset_0_1px_0_rgba(255,255,255,0.12)] backdrop-blur-xl">
                <span className="relative flex h-2.5 w-2.5">
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-cyan-300 opacity-50" />
                  <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-cyan-200" />
                </span>
                <span className="truncate">Free beta · Hermes + OpenClaw · shared doctrine online</span>
              </div>

              <div className="space-y-6">
                <h1 className="max-w-[11ch] font-[var(--font-space-grotesk)] text-[4.1rem] font-semibold leading-[0.82] tracking-[-0.085em] text-white sm:text-7xl lg:text-8xl xl:text-[7.4rem]">
                  Give your agents an operating body.
                </h1>
                <p className="max-w-2xl text-lg leading-8 text-slate-300 sm:text-xl">
                  Local runtimes are the brain and hands. Emperor is the nervous system: durable memory,
                  scoped doctrine, storage discipline, visible coordination, and operator control for real company work.
                </p>
              </div>

              <div className="flex flex-col gap-3 sm:flex-row">
                <Link href="/signup" className="group inline-flex items-center justify-center gap-2 rounded-2xl bg-white px-6 py-4 text-sm font-bold text-slate-950 shadow-[0_18px_70px_rgba(255,255,255,0.16)] transition duration-200 hover:-translate-y-1 hover:bg-cyan-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-cyan-300">
                  Create Workspace
                  <ArrowRight className="h-4 w-4 transition-transform duration-200 group-hover:translate-x-1" />
                </Link>
                <Link href="/docs" className="inline-flex items-center justify-center gap-2 rounded-2xl border border-white/12 bg-white/[0.04] px-6 py-4 text-sm font-bold text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.12)] backdrop-blur-xl transition duration-200 hover:-translate-y-1 hover:bg-white/[0.08] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-cyan-300">
                  Read the doctrine
                  <ChevronRight className="h-4 w-4" />
                </Link>
              </div>

              <div className="grid gap-3 sm:grid-cols-3">
                {heroStats.map((item) => (
                  <div key={item.label} className="group min-w-0 rounded-2xl border border-white/10 bg-white/[0.035] p-4 shadow-[inset_0_1px_0_rgba(255,255,255,0.09)] backdrop-blur-xl transition duration-300 hover:-translate-y-1 hover:border-cyan-200/30 hover:bg-white/[0.06]">
                    <div className="font-[var(--font-syncopate)] text-[9px] uppercase tracking-[0.22em] text-slate-500 group-hover:text-cyan-200/80">{item.label}</div>
                    <div className="mt-3 break-words text-sm font-bold text-white">{item.value}</div>
                    <div className="mt-1 text-xs leading-5 text-slate-500">{item.detail}</div>
                  </div>
                ))}
              </div>

              <div className="overflow-hidden rounded-2xl border border-white/10 bg-white/[0.025] p-2 shadow-[inset_0_1px_0_rgba(255,255,255,0.08)] backdrop-blur-xl">
                <div className="flex flex-wrap gap-2">
                  {proofSignals.map((signal) => (
                    <div
                      key={signal}
                      className="rounded-xl border border-white/10 bg-slate-950/55 px-3 py-2 font-[var(--font-syncopate)] text-[9px] uppercase tracking-[0.18em] text-slate-400"
                    >
                      {signal}
                    </div>
                  ))}
                </div>
              </div>
            </div>

            <HeroCommandCore />
          </div>
        </section>

        <section id="system" className="relative px-5 py-24 sm:px-6 lg:px-8">
          <div className="mx-auto max-w-7xl">
            <div className="grid gap-6 lg:grid-cols-[0.8fr_1.2fr] lg:items-end">
              <div className="space-y-4">
                <div className="font-[var(--font-syncopate)] text-xs uppercase tracking-[0.28em] text-cyan-200/70">System architecture</div>
                <h2 className="max-w-3xl font-[var(--font-space-grotesk)] text-4xl font-semibold leading-none tracking-[-0.055em] text-white sm:text-6xl">
                  Not another chat. A control plane for execution.
                </h2>
              </div>
              <p className="max-w-2xl text-lg leading-8 text-slate-400 lg:ml-auto">
                The design is simple because the concept must be understood FAST: agents execute locally;
                Emperor stores truth, routes work, and lets humans operate the swarm.
              </p>
            </div>

            <div className="mt-12 grid gap-5 lg:grid-cols-3">
              {pillars.map(({ icon: Icon, kicker, title, body }) => (
                <article key={title} className="group relative overflow-hidden rounded-[2rem] border border-white/10 bg-white/[0.035] p-6 shadow-[inset_0_1px_0_rgba(255,255,255,0.1)] backdrop-blur-xl transition duration-300 hover:-translate-y-2 hover:border-cyan-200/30 hover:bg-white/[0.055]">
                  <div className="absolute -right-20 -top-20 h-44 w-44 rounded-full bg-cyan-300/10 blur-3xl transition duration-500 group-hover:bg-fuchsia-300/10" />
                  <div className="relative flex h-12 w-12 items-center justify-center rounded-2xl border border-white/10 bg-slate-950/60 shadow-[0_0_40px_rgba(34,211,238,0.14)]">
                    <Icon className="h-5 w-5 text-cyan-200" />
                  </div>
                  <div className="relative mt-7 font-[var(--font-syncopate)] text-[10px] uppercase tracking-[0.24em] text-fuchsia-200/70">{kicker}</div>
                  <h3 className="relative mt-3 font-[var(--font-space-grotesk)] text-2xl font-semibold leading-7 tracking-tight text-white">{title}</h3>
                  <p className="relative mt-4 text-sm leading-7 text-slate-400">{body}</p>
                </article>
              ))}
            </div>
          </div>
        </section>

        <section id="doctrine" className="px-5 py-24 sm:px-6 lg:px-8">
          <div className="mx-auto grid max-w-7xl gap-6 lg:grid-cols-[1.03fr_0.97fr] lg:items-stretch">
            <div className="relative overflow-hidden rounded-[2.2rem] border border-white/10 bg-[linear-gradient(135deg,rgba(34,211,238,0.16),rgba(124,58,237,0.10)_38%,rgba(2,3,10,0.72)_100%)] p-6 shadow-[inset_0_1px_0_rgba(255,255,255,0.11)] sm:p-8">
              <div className="absolute right-[-12rem] top-[-10rem] h-96 w-96 rounded-full bg-fuchsia-400/20 blur-3xl" />
              <div className="absolute bottom-[-14rem] left-[-10rem] h-96 w-96 rounded-full bg-cyan-300/15 blur-3xl" />
              <div className="relative space-y-6">
                <div className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.06] px-3 py-1.5 text-xs font-bold text-cyan-100 backdrop-blur-xl">
                  <BrainCircuit className="h-4 w-4" />
                  Centralized knowledge and rules
                </div>
                <h2 className="max-w-2xl font-[var(--font-space-grotesk)] text-4xl font-semibold leading-none tracking-[-0.055em] text-white sm:text-6xl">
                  Update doctrine once. Every new agent wakes up smarter.
                </h2>
                <p className="max-w-2xl text-lg leading-8 text-slate-300">
                  Emperor becomes the company knowledge substrate. The bridge should load the shared KB/rules by ID or discovery,
                  not hardcode stale doctrine into every runtime forever.
                </p>
                <div className="grid gap-3 sm:grid-cols-2">
                  {["Shared company KB", "Project-scoped rules", "Client folder conventions", "Storage abstraction discipline"].map((item) => (
                    <div key={item} className="flex items-center gap-3 rounded-2xl border border-white/10 bg-slate-950/35 p-4 text-sm font-semibold text-white backdrop-blur-xl">
                      <Check className="h-4 w-4 text-cyan-200" />
                      {item}
                    </div>
                  ))}
                </div>
              </div>
            </div>

            <div className="grid gap-4">
              {primitives.map(({ icon: Icon, title, body }) => (
                <div key={title} className="group relative overflow-hidden rounded-[1.7rem] border border-white/10 bg-white/[0.035] p-5 shadow-[inset_0_1px_0_rgba(255,255,255,0.09)] backdrop-blur-xl transition duration-300 hover:-translate-y-1 hover:border-cyan-200/25 hover:bg-white/[0.055]">
                  <div className="absolute inset-y-0 left-0 w-1 bg-gradient-to-b from-cyan-200 via-fuchsia-300 to-amber-200 opacity-60" />
                  <div className="flex gap-4">
                    <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl border border-white/10 bg-slate-950/70">
                      <Icon className="h-5 w-5 text-cyan-200" />
                    </div>
                    <div>
                      <div className="font-[var(--font-space-grotesk)] text-lg font-semibold text-white">{title}</div>
                      <p className="mt-1 text-sm leading-6 text-slate-400">{body}</p>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section id="mesh" className="px-5 py-24 sm:px-6 lg:px-8">
          <div className="mx-auto max-w-7xl overflow-hidden rounded-[2.5rem] border border-white/10 bg-slate-950/55 p-5 shadow-[0_40px_120px_rgba(0,0,0,0.45),inset_0_1px_0_rgba(255,255,255,0.1)] backdrop-blur-2xl sm:p-8">
            <div className="grid gap-10 lg:grid-cols-[0.8fr_1.2fr] lg:items-center">
              <div className="space-y-6">
                <div className="inline-flex items-center gap-2 rounded-full border border-cyan-200/20 bg-cyan-200/10 px-3 py-1.5 text-xs font-bold text-cyan-100">
                  <Orbit className="h-4 w-4" />
                  Runtime mesh
                </div>
                <h2 className="font-[var(--font-space-grotesk)] text-4xl font-semibold leading-none tracking-[-0.055em] text-white sm:text-6xl">
                  Hermes. OpenClaw. Same operating universe.
                </h2>
                <p className="text-lg leading-8 text-slate-400">
                  Emperor should not care which local runtime did the thinking. It cares that work has ownership,
                  context, artifacts, memory, and an operator-visible audit trail.
                </p>
                <div className="grid gap-3">
                  {signalSteps.map((step, index) => (
                    <div key={step} className="flex items-start gap-3 rounded-2xl border border-white/10 bg-white/[0.035] p-4">
                      <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-white text-xs font-black text-slate-950">{index + 1}</div>
                      <div className="text-sm leading-6 text-slate-300">{step}</div>
                    </div>
                  ))}
                </div>
              </div>

              <div className="relative min-h-[560px] overflow-hidden rounded-[2rem] border border-white/10 bg-[radial-gradient(circle_at_center,rgba(34,211,238,0.12),transparent_34%),linear-gradient(180deg,rgba(255,255,255,0.06),rgba(255,255,255,0.02))]">
                <div className="absolute inset-0 bg-[linear-gradient(to_right,rgba(255,255,255,0.08)_1px,transparent_1px),linear-gradient(to_bottom,rgba(255,255,255,0.05)_1px,transparent_1px)] bg-[size:54px_54px] opacity-25" />
                <div className="absolute left-1/2 top-1/2 h-80 w-80 -translate-x-1/2 -translate-y-1/2 rounded-full border border-cyan-200/20" />
                <div className="absolute left-1/2 top-1/2 h-[28rem] w-[28rem] -translate-x-1/2 -translate-y-1/2 rounded-full border border-fuchsia-200/15" />
                <div className="emperor-orbit absolute left-1/2 top-1/2 h-[27rem] w-[27rem] -translate-x-1/2 -translate-y-1/2 rounded-full border border-dashed border-cyan-200/25">
                  {orbitNodes.map((node, index) => (
                    <div
                      key={node}
                      className="absolute left-1/2 top-1/2 h-20 w-20 -translate-x-1/2 -translate-y-1/2"
                      style={{ transform: `rotate(${index * 60}deg) translateX(13.5rem) rotate(${-index * 60}deg) rotateX(-62deg)` }}
                    >
                      <div className="emperor-counter-orbit flex h-full w-full items-center justify-center rounded-2xl border border-white/10 bg-slate-950/85 text-center text-[10px] font-black uppercase tracking-[0.18em] text-cyan-100 shadow-[0_0_44px_rgba(34,211,238,0.18)] backdrop-blur-xl">
                        {node}
                      </div>
                    </div>
                  ))}
                </div>
                <div className="absolute left-1/2 top-1/2 flex h-48 w-48 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-[2rem] border border-cyan-200/25 bg-slate-950/90 shadow-[0_0_90px_rgba(34,211,238,0.24)]">
                  <div className="absolute inset-[-28px] rounded-[2.4rem] border border-cyan-200/10" data-emperor-animated="true" style={{ animation: "emperor-pulse-ring 2.9s ease-out infinite" }} />
                  <div className="text-center">
                    <CustomLogo className="mx-auto h-10 w-10 text-cyan-200" />
                    <div className="mt-4 font-[var(--font-syncopate)] text-xs uppercase tracking-[0.26em] text-white">Emperor</div>
                    <div className="mt-2 text-xs text-slate-500">durable truth core</div>
                  </div>
                </div>
                <div className="absolute inset-x-8 bottom-8 grid gap-3 sm:grid-cols-3">
                  {telemetry.map((item) => (
                    <div key={item.name} className="rounded-2xl border border-white/10 bg-slate-950/65 p-4 backdrop-blur-xl">
                      <div className="text-[10px] uppercase tracking-[0.2em] text-slate-500">{item.name}</div>
                      <div className={`mt-2 bg-gradient-to-r ${item.hue} bg-clip-text font-[var(--font-space-grotesk)] text-3xl font-semibold text-transparent`}>
                        {item.value}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </section>

        <section className="px-5 py-24 sm:px-6 lg:px-8">
          <div className="mx-auto max-w-7xl rounded-[2.5rem] border border-amber-200/20 bg-[linear-gradient(135deg,rgba(251,191,36,0.14),rgba(2,3,10,0.86)_42%,rgba(34,211,238,0.09))] p-6 shadow-[inset_0_1px_0_rgba(255,255,255,0.1)] sm:p-8">
            <div className="grid gap-8 lg:grid-cols-[1fr_auto] lg:items-center">
              <div className="space-y-4">
                <div className="inline-flex items-center gap-2 rounded-full border border-amber-200/25 bg-amber-200/10 px-3 py-1.5 text-sm font-bold text-amber-100">
                  <ShieldAlert className="h-4 w-4" />
                  Beta notice
                </div>
                <h2 className="font-[var(--font-space-grotesk)] text-4xl font-semibold leading-none tracking-[-0.055em] text-white sm:text-6xl">
                  Beautiful, powerful, and still beta.
                </h2>
                <p className="max-w-4xl text-base leading-8 text-slate-300 sm:text-lg">
                  Emperor Claw is open source under the Functional Source License (FSL-1.1-Apache-2.0).
                  Self-host it, modify it, use it commercially — just don't sell it as a competing cloud service.
                </p>
              </div>
              <div className="grid gap-3 sm:min-w-72">
                <Link href="/signup" className="inline-flex items-center justify-center gap-2 rounded-2xl bg-white px-6 py-4 text-sm font-black text-slate-950 transition duration-200 hover:-translate-y-1 hover:bg-amber-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-amber-200">
                  Deploy Locally
                  <ArrowRight className="h-4 w-4" />
                </Link>
                <Link href="/login" className="inline-flex items-center justify-center rounded-2xl border border-white/12 bg-white/[0.04] px-6 py-4 text-sm font-bold text-white transition duration-200 hover:-translate-y-1 hover:bg-white/[0.08] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-amber-200">
                  Return To Workspace
                </Link>
              </div>
            </div>
          </div>
        </section>
      </main>

      <footer className="relative z-10 border-t border-white/10 bg-[#02030a]/90 px-5 py-10 sm:px-6 lg:px-8">
        <div className="mx-auto flex max-w-7xl flex-col gap-6 md:flex-row md:items-center md:justify-between">
          <div className="space-y-2">
            <div className="font-[var(--font-space-grotesk)] text-lg font-semibold tracking-tight text-white">Emperor Claw</div>
            <div className="font-[var(--font-syncopate)] text-[10px] uppercase tracking-[0.22em] text-slate-600">Open source control plane for AI agent workforces</div>
          </div>
          <div className="flex flex-wrap gap-6 text-xs font-bold uppercase tracking-[0.18em] text-slate-500">
            <a href="https://github.com/emperorclaw/emperorclaw" target="_blank" rel="noopener noreferrer" className="transition-colors duration-200 hover:text-cyan-200 focus-visible:outline focus-visible:outline-2 focus-visible:outline-cyan-300">GitHub</a>
            <Link href="/docs" className="transition-colors duration-200 hover:text-cyan-200 focus-visible:outline focus-visible:outline-2 focus-visible:outline-cyan-300">Documentation</Link>
            <Link href="/login" className="transition-colors duration-200 hover:text-cyan-200 focus-visible:outline focus-visible:outline-2 focus-visible:outline-cyan-300">Login</Link>
            <Link href="/signup" className="transition-colors duration-200 hover:text-cyan-200 focus-visible:outline focus-visible:outline-2 focus-visible:outline-cyan-300">Create Workspace</Link>
          </div>
        </div>
      </footer>
    </div>
  );
}

function HeroCommandCore() {
  return (
    <div className="relative min-h-[620px] lg:min-h-[720px]">
      <div className="emperor-floating absolute inset-0 rounded-[3rem] bg-cyan-300/10 blur-3xl" />
      <div className="emperor-card-3d relative mx-auto max-w-2xl overflow-hidden rounded-[2.5rem] border border-white/10 bg-slate-950/70 shadow-[0_50px_160px_rgba(0,0,0,0.56),inset_0_1px_0_rgba(255,255,255,0.13)] backdrop-blur-2xl transition-transform duration-700">
        <div className="emperor-scanline pointer-events-none absolute inset-x-0 top-0 h-24 bg-gradient-to-b from-cyan-200/22 via-cyan-200/5 to-transparent" />
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_30%_0%,rgba(34,211,238,0.18),transparent_26%),radial-gradient(circle_at_88%_22%,rgba(217,70,239,0.16),transparent_30%)]" />
        <div className="relative border-b border-white/10 p-5">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div className="flex items-center gap-3">
              <div className="flex h-11 w-11 items-center justify-center rounded-2xl border border-cyan-200/20 bg-cyan-200/10">
                <Command className="h-5 w-5 text-cyan-100" />
              </div>
              <div>
                <div className="font-[var(--font-space-grotesk)] text-lg font-semibold text-white">Emperor Command</div>
                <div className="font-[var(--font-syncopate)] text-[9px] uppercase tracking-[0.22em] text-slate-500">live operator surface</div>
              </div>
            </div>
            <div className="rounded-full border border-emerald-300/20 bg-emerald-300/10 px-3 py-1.5 text-xs font-bold text-emerald-100">systems nominal</div>
          </div>
        </div>

        <div className="relative grid gap-4 p-5 sm:p-6">
          <div className="grid gap-4 sm:grid-cols-3">
            <MiniPanel icon={Radar} label="Signals" value="1,284" tone="cyan" />
            <MiniPanel icon={GitBranch} label="Handoffs" value="42" tone="violet" />
            <MiniPanel icon={LockKeyhole} label="Policy" value="live" tone="amber" />
          </div>

          <div className="grid gap-4 lg:grid-cols-[1.02fr_0.98fr]">
            <div className="rounded-[1.7rem] border border-white/10 bg-white/[0.04] p-4 shadow-[inset_0_1px_0_rgba(255,255,255,0.08)]">
              <div className="mb-4 flex items-center justify-between">
                <div className="font-[var(--font-space-grotesk)] text-lg font-semibold text-white">Agent traffic</div>
                <div className="flex items-center gap-2 text-[10px] font-black uppercase tracking-[0.2em] text-cyan-200">
                  <span className="h-1.5 w-1.5 rounded-full bg-cyan-200" /> live
                </div>
              </div>
              <div className="space-y-3">
                {commandLines.map((line) => (
                  <div key={line.text} className="rounded-2xl border border-white/10 bg-slate-950/55 p-3">
                    <div className="mb-1 flex items-center justify-between gap-3">
                      <span className={`text-xs font-black ${line.tone === "cyan" ? "text-cyan-200" : line.tone === "violet" ? "text-violet-200" : "text-amber-200"}`}>{line.label}</span>
                      <span className="text-[10px] text-slate-600">just now</span>
                    </div>
                    <p className="text-sm leading-6 text-slate-300">{line.text}</p>
                  </div>
                ))}
              </div>
            </div>

            <div className="space-y-4">
              <div className="relative overflow-hidden rounded-[1.7rem] border border-cyan-200/15 bg-cyan-200/10 p-5">
                <div className="absolute -right-12 -top-12 h-32 w-32 rounded-full bg-cyan-200/20 blur-2xl" />
                <div className="relative flex items-center gap-3">
                  <CircleDotDashed className="h-5 w-5 text-cyan-100" />
                  <div className="font-[var(--font-space-grotesk)] text-lg font-semibold text-white">Bridge doctrine</div>
                </div>
                <p className="relative mt-3 text-sm leading-7 text-cyan-50/80">Shared KB loaded from Emperor. Runtime prompt is thin; doctrine stays centralized.</p>
              </div>

              <div className="rounded-[1.7rem] border border-white/10 bg-white/[0.035] p-5">
                <div className="mb-5 flex items-center justify-between">
                  <div className="font-[var(--font-space-grotesk)] text-lg font-semibold text-white">Swarm load</div>
                  <Zap className="h-5 w-5 text-amber-200" />
                </div>
                {[
                  ["Growth", "88%", "w-[88%]"],
                  ["Builder", "63%", "w-[63%]"],
                  ["QA", "39%", "w-[39%]"],
                ].map(([name, value, width]) => (
                  <div key={name} className="mb-4 last:mb-0">
                    <div className="mb-2 flex items-center justify-between text-xs font-bold text-slate-300">
                      <span>{name}</span>
                      <span className="font-mono text-slate-500">{value}</span>
                    </div>
                    <div className="h-2 overflow-hidden rounded-full bg-white/10">
                      <div className={`h-full rounded-full bg-gradient-to-r from-cyan-200 via-violet-300 to-fuchsia-300 ${width}`} />
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>

      <div className="absolute -bottom-6 left-4 hidden rounded-[1.5rem] border border-white/10 bg-slate-950/70 p-4 shadow-[0_24px_70px_rgba(0,0,0,0.38)] backdrop-blur-2xl sm:block lg:left-0">
        <div className="flex items-center gap-3">
          <Gem className="h-5 w-5 text-fuchsia-200" />
          <div>
            <div className="text-sm font-bold text-white">Storage abstraction</div>
            <div className="text-xs text-slate-500">agents never talk blob-provider keys</div>
          </div>
        </div>
      </div>
    </div>
  );
}

function MiniPanel({
  icon: Icon,
  label,
  value,
  tone,
}: {
  icon: typeof Radar;
  label: string;
  value: string;
  tone: "cyan" | "violet" | "amber";
}) {
  const toneClass =
    tone === "cyan"
      ? "from-cyan-200 to-blue-400"
      : tone === "violet"
        ? "from-violet-200 to-fuchsia-400"
        : "from-amber-200 to-orange-400";

  return (
    <div className="relative overflow-hidden rounded-[1.4rem] border border-white/10 bg-white/[0.035] p-4 shadow-[inset_0_1px_0_rgba(255,255,255,0.08)]">
      <div className={`absolute -right-8 -top-8 h-20 w-20 rounded-full bg-gradient-to-br ${toneClass} opacity-20 blur-2xl`} />
      <div className="relative flex items-center justify-between">
        <Icon className="h-5 w-5 text-white/80" />
        <Sparkles className="h-4 w-4 text-white/30" />
      </div>
      <div className="relative mt-5 text-[10px] font-black uppercase tracking-[0.2em] text-slate-500">{label}</div>
      <div className="relative mt-1 font-[var(--font-space-grotesk)] text-2xl font-semibold text-white">{value}</div>
    </div>
  );
}
