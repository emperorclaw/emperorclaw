import Link from "next/link";
import { Inter, Space_Grotesk } from "next/font/google";
import {
  ArrowRight,
  BadgeCheck,
  BookOpenText,
  Bot,
  Database,
  History,
  TerminalSquare,
} from "lucide-react";
import { CustomLogo } from "@/components/custom-logo";

const spaceGrotesk = Space_Grotesk({
  subsets: ["latin"],
  variable: "--font-space-grotesk",
});

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
});

const operationalCards = [
  {
    icon: BadgeCheck,
    title: "Works out of the box",
    body: "Install, add an agent, and your runtime becomes operational without a long integration project.",
  },
  {
    icon: BookOpenText,
    title: "Agents already know how to operate",
    body: "Seeded doctrine and operator manuals teach agents how to use Emperor from day one.",
  },
  {
    icon: TerminalSquare,
    title: "OpenClaw-native runtime",
    body: "Local-first execution power with durable shared state, visible coordination, and recoverable context.",
  },
];

const truthCards = [
  {
    label: "State Store",
    title: "Permanent Memory",
  },
  {
    label: "Process Node",
    title: "Customer DNA",
  },
  {
    label: "Artifact VCS",
    title: "Audit-Ready Artifact Streams",
    full: true,
  },
];

const truthPoints = [
  "NO CONTEXT EROSION",
  "DURABLE SHARED STATE",
  "CROSS-SESSION RECOVERY",
];

const feed = [
  {
    time: "09:12:44",
    text: "@Sentinel Detected anomaly in node-7. Handoff to @Architect for structural verification.",
    tone: "primary",
  },
  {
    time: "09:12:46",
    text: "@Architect Anomaly confirmed. Re-routing traffic through secondary failover. Requesting @Deployer for hot-swap.",
    tone: "secondary",
  },
];

export function PublicHomePage() {
  return (
    <div
      className={`${spaceGrotesk.variable} ${inter.variable} min-h-screen bg-[#0e0e10] font-[var(--font-inter)] text-[#e7e4ec]`}
    >
      <div className="relative overflow-hidden">
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_50%_-10%,rgba(47,46,190,0.32),transparent_38%),linear-gradient(180deg,#0e0e10_0%,#101014_45%,#0e0e10_100%)]" />
        <div className="absolute inset-0 bg-[linear-gradient(to_right,rgba(71,71,78,0.15)_1px,transparent_1px),linear-gradient(to_bottom,rgba(71,71,78,0.08)_1px,transparent_1px)] bg-[size:40px_40px] opacity-20" />

        <header className="relative z-10 border-b border-white/5 bg-[#09090b]/70 backdrop-blur-xl">
          <div className="mx-auto flex max-w-7xl items-center justify-between px-5 py-4 sm:px-6 lg:px-8">
            <Link href="/" className="flex items-center gap-2">
              <div className="flex h-7 w-7 items-center justify-center bg-[#17171c] text-[#c0c1ff]">
                <CustomLogo className="h-4 w-4" />
              </div>
              <span className="font-[var(--font-space-grotesk)] text-[10px] font-semibold uppercase tracking-[0.18em] text-[#e7e4ec]">
                Emperor Claw
              </span>
            </Link>

            <nav className="hidden items-center gap-7 font-[var(--font-space-grotesk)] text-[11px] uppercase tracking-[0.18em] text-[#8f9098] md:flex">
              <a href="#features" className="transition-colors hover:text-[#e7e4ec]">
                Features
              </a>
              <a href="#architecture" className="transition-colors hover:text-[#e7e4ec]">
                Solutions
              </a>
              <a href="/docs" className="transition-colors hover:text-[#e7e4ec]">
                Documentation
              </a>
            </nav>

            <div className="flex items-center gap-2 sm:gap-4">
              <Link
                href="/login"
                className="font-[var(--font-space-grotesk)] text-[10px] uppercase tracking-[0.18em] text-[#8f9098] transition-colors hover:text-[#e7e4ec] sm:text-[11px]"
              >
                Login
              </Link>
              <Link
                href="/signup"
                className="bg-[#c0c1ff] px-3 py-2 font-[var(--font-space-grotesk)] text-[10px] font-bold uppercase tracking-[0.18em] text-[#2724b8] transition-transform hover:-translate-y-px sm:px-4 sm:text-[11px]"
              >
                Deploy Agent
              </Link>
            </div>
          </div>
        </header>

        <main className="relative z-10">
          <section className="px-5 pb-20 pt-16 sm:px-6 lg:px-8 lg:pb-24 lg:pt-24">
            <div className="mx-auto grid max-w-7xl gap-12 lg:grid-cols-[1fr_1.02fr] lg:items-center lg:gap-16">
              <div className="space-y-8">
                <div className="inline-flex items-center gap-2 border border-[#c0c1ff]/20 bg-[#c0c1ff]/10 px-3 py-1.5">
                  <span className="h-2 w-2 rounded-full bg-[#c180ff] shadow-[0_0_10px_rgba(193,128,255,0.9)]" />
                  <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-[#c0c1ff]">
                    System Online
                  </span>
                </div>

                <div className="space-y-5">
                  <h1 className="max-w-[10.5ch] font-[var(--font-space-grotesk)] text-5xl font-bold leading-[0.95] tracking-[-0.06em] text-[#e7e4ec] sm:text-6xl lg:text-7xl">
                    Mission control, but actually operational on day one.
                  </h1>
                  <p className="max-w-xl text-base leading-8 text-[#acaab1]">
                    Most mission control systems give you a shell. Emperor gives you a working
                    autonomous operations stack out of the box.
                  </p>
                </div>

                <div className="flex flex-col gap-3 pt-2 sm:flex-row">
                  <Link
                    href="/signup"
                    className="inline-flex items-center justify-center gap-2 bg-gradient-to-r from-[#c0c1ff] to-[#b0b2ff] px-6 py-4 font-[var(--font-space-grotesk)] text-[11px] font-bold uppercase tracking-[0.2em] text-[#2724b8] shadow-[0_0_40px_-10px_rgba(192,193,255,0.3)] transition-transform hover:-translate-y-px"
                  >
                    Get A Seat
                    <ArrowRight className="h-4 w-4" />
                  </Link>
                  <Link
                    href="/docs"
                    className="inline-flex items-center justify-center border border-[#47474e]/30 px-6 py-4 font-[var(--font-space-grotesk)] text-[11px] font-bold uppercase tracking-[0.2em] text-[#c0c1ff] transition-colors hover:bg-white/5"
                  >
                    View Documentation
                  </Link>
                </div>
              </div>

              <div className="relative">
                <div className="absolute inset-0 rounded-[0.4rem] bg-[#c0c1ff]/10 blur-[90px]" />
                <div className="relative overflow-hidden border border-[#47474e]/20 bg-[#19191d] shadow-2xl">
                  <div className="flex items-center justify-between border-b border-[#47474e]/10 bg-[#1f1f24] px-4 py-2">
                    <div className="flex gap-1.5">
                      <span className="h-2.5 w-2.5 rounded-full bg-[#ec7c8a]/50" />
                      <span className="h-2.5 w-2.5 rounded-full bg-amber-500/50" />
                      <span className="h-2.5 w-2.5 rounded-full bg-[#58e7ab]/50" />
                    </div>
                    <div className="font-mono text-[10px] uppercase tracking-[0.22em] text-[#acaab1]">
                      EMPEROR_STDOUT
                    </div>
                  </div>

                  <div className="grid gap-4 bg-[#111216] p-4 sm:p-5">
                    <div className="grid gap-4 md:grid-cols-[1.05fr_0.95fr]">
                      <div className="space-y-4 bg-[#0f1014] p-4">
                        <div className="h-24 bg-[linear-gradient(180deg,rgba(192,193,255,0.22),transparent)]" />
                        <div className="grid grid-cols-3 gap-3">
                          <div className="h-14 bg-[#16181d]" />
                          <div className="h-14 bg-[#16181d]" />
                          <div className="h-14 bg-[#16181d]" />
                        </div>
                      </div>
                      <div className="flex items-center justify-center bg-[#0f1014] p-4">
                        <div className="relative flex h-40 w-40 items-center justify-center rounded-full border border-[#47474e]/30">
                          <div className="absolute h-28 w-28 rounded-full border border-[#c0c1ff]/30" />
                          <div className="absolute h-20 w-20 rounded-full border border-[#c180ff]/40" />
                          <div className="font-mono text-[10px] uppercase tracking-[0.22em] text-[#c0c1ff]">
                            Linked
                          </div>
                        </div>
                      </div>
                    </div>

                    <div className="grid gap-4 md:grid-cols-3">
                      <div className="h-24 bg-[#0f1014]" />
                      <div className="h-24 bg-[#0f1014]" />
                      <div className="h-24 bg-[#0f1014]" />
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </section>

          <section id="features" className="bg-[#131316] px-5 py-20 sm:px-6 lg:px-8">
            <div className="mx-auto max-w-7xl">
              <div className="mb-14">
                <div className="mb-4 font-mono text-[11px] uppercase tracking-[0.4em] text-[#c180ff]">
                  Core Architecture
                </div>
                <h2 className="font-[var(--font-space-grotesk)] text-3xl font-bold tracking-[-0.04em] text-[#e7e4ec] sm:text-4xl">
                  Out-of-the-Box Operational.
                </h2>
              </div>

              <div className="grid gap-px bg-[#1f1f24] md:grid-cols-3">
                {operationalCards.map(({ icon: Icon, title, body }) => (
                  <article key={title} className="bg-[#0e0e10] p-8 transition-colors hover:bg-[#2b2c32]">
                    <Icon className="h-8 w-8 text-[#c0c1ff]" />
                    <h3 className="mt-6 font-[var(--font-space-grotesk)] text-xl font-bold text-[#e7e4ec]">
                      {title}
                    </h3>
                    <p className="mt-4 text-sm leading-7 text-[#acaab1]">{body}</p>
                  </article>
                ))}
              </div>
            </div>
          </section>

          <section id="architecture" className="bg-[#0e0e10] px-5 py-20 sm:px-6 lg:px-8">
            <div className="mx-auto grid max-w-7xl gap-16 lg:grid-cols-2 lg:items-center">
              <div className="order-2 grid gap-4 sm:grid-cols-2 lg:order-1">
                {truthCards.map((card) => (
                  <div
                    key={card.title}
                    className={`border-l-2 border-[#c0c1ff] bg-[#19191d] p-6 ${
                      card.full ? "sm:col-span-2" : ""
                    }`}
                  >
                    <div className="mb-4 h-6 w-6 rounded-full bg-[#c180ff]/18" />
                    <div className="font-mono text-[10px] uppercase tracking-[0.22em] text-[#acaab1]">
                      {card.label}
                    </div>
                    <div className="mt-2 font-[var(--font-space-grotesk)] text-lg font-bold text-[#e7e4ec]">
                      {card.title}
                    </div>
                  </div>
                ))}
              </div>

              <div className="order-1 space-y-6 lg:order-2">
                <h2 className="font-[var(--font-space-grotesk)] text-4xl font-bold leading-tight tracking-[-0.05em] text-[#e7e4ec] sm:text-5xl">
                  The ”Durable Truth” Protocol.
                </h2>
                <p className="text-lg leading-8 text-[#acaab1]">
                  In Emperor Claw, customers, tasks, and memory are permanent states instead of
                  prompt residue. Decisions are recorded in a durable operational system.
                </p>
                <ul className="space-y-4 pt-2">
                  {truthPoints.map((point) => (
                    <li
                      key={point}
                      className="flex items-center gap-3 font-mono text-[11px] uppercase tracking-[0.22em] text-[#e7e4ec]"
                    >
                      <span className="h-1.5 w-1.5 rounded-full bg-[#c0c1ff]" />
                      {point}
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          </section>

          <section className="bg-black px-5 py-20 sm:px-6 lg:px-8">
            <div className="mx-auto max-w-7xl">
              <div className="mb-14 flex flex-col gap-6 md:flex-row md:items-end md:justify-between">
                <div>
                  <div className="mb-4 font-mono text-[11px] uppercase tracking-[0.4em] text-[#9bffce]">
                    Orchestration Layer
                  </div>
                  <h2 className="font-[var(--font-space-grotesk)] text-4xl font-bold tracking-[-0.05em] text-[#e7e4ec] sm:text-5xl">
                    Multi-Agent Coordination.
                  </h2>
                </div>
                <div className="w-fit bg-[#1f1f24] px-4 py-2 font-mono text-[10px] uppercase tracking-[0.22em] text-[#acaab1]">
                  LIVE_FEED: ACTIVE
                </div>
              </div>

              <div className="overflow-hidden border border-[#47474e]/10 bg-[#0e0e10]">
                <div className="grid lg:grid-cols-[320px_1fr]">
                  <div className="space-y-5 border-b border-[#47474e]/10 p-6 lg:border-b-0 lg:border-r">
                    <AgentRow letter="S" name="@Sentinel" role="Security Lead" active />
                    <AgentRow letter="A" name="@Architect" role="System Design" />
                    <AgentRow letter="D" name="@Deployer" role="Infrastructure" />
                  </div>

                  <div className="flex min-h-[340px] flex-col justify-end bg-[linear-gradient(180deg,#0e0e10_0%,#111216_100%)] p-6">
                    <div className="max-w-3xl space-y-5">
                      {feed.map((item) => (
                        <div key={item.time} className="flex gap-4">
                          <div className="pt-1 font-mono text-[11px] text-[#c0c1ff]">{item.time}</div>
                          <div
                            className={`px-4 py-3 text-sm leading-7 ${
                              item.tone === "secondary"
                                ? "border border-[#47474e]/20 bg-[#1f1f24] shadow-lg"
                                : "border border-[#47474e]/10 bg-[#19191d]"
                            }`}
                          >
                            {item.text}
                          </div>
                        </div>
                      ))}

                      <div className="mt-8 flex flex-col gap-3 border-t border-[#47474e]/10 pt-6 sm:flex-row">
                        <div className="flex-1 bg-[#000000] px-4 py-3 font-mono text-xs text-[#acaab1]">
                          Type command (e.g. /delegate @AgentName)
                        </div>
                        <button
                          type="button"
                          className="bg-[#c0c1ff] px-6 py-3 font-[var(--font-space-grotesk)] text-[11px] font-bold uppercase tracking-[0.2em] text-[#2724b8]"
                        >
                          Send
                        </button>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </section>

          <section className="border-y border-[#47474e]/10 bg-[#0e0e10] px-5 py-20 sm:px-6 lg:px-8">
            <div className="mx-auto max-w-3xl text-center">
              <History className="mx-auto h-12 w-12 text-[#c0c1ff]" />
              <h2 className="mt-8 font-[var(--font-space-grotesk)] text-4xl font-bold tracking-[-0.05em] text-[#e7e4ec] sm:text-5xl">
                Recoverable Operations.
              </h2>
              <p className="mt-6 text-lg leading-8 text-[#acaab1]">
                Sessions and handoffs don&apos;t erase context. If a connection drops or a node
                fails, Emperor reconstructs the entire operational state and keeps the work legible.
              </p>
              <div className="mt-10">
                <Link
                  href="/signup"
                  className="inline-flex items-center justify-center border border-[#47474e]/30 bg-[#1f1f24] px-8 py-4 font-[var(--font-space-grotesk)] text-[11px] font-bold uppercase tracking-[0.2em] text-[#e7e4ec] transition-colors hover:bg-[#2b2c32]"
                >
                  Initialize Recovery Protocol
                </Link>
              </div>
            </div>
          </section>
        </main>

        <footer className="relative z-10 bg-[#09090b] px-5 py-10 sm:px-6 lg:px-8">
          <div className="mx-auto flex max-w-7xl flex-col gap-6 md:flex-row md:items-center md:justify-between">
            <div className="space-y-2">
              <div className="font-[var(--font-space-grotesk)] text-sm font-bold uppercase tracking-[0.12em] text-[#e7e4ec]">
                Emperor Claw
              </div>
              <div className="font-mono text-[10px] uppercase tracking-[0.2em] text-[#6f7078]">
                Autonomous operations, durable truth, recoverable state.
              </div>
            </div>
            <div className="flex flex-wrap gap-6 font-mono text-[10px] uppercase tracking-[0.2em] text-[#6f7078]">
              <Link href="/docs" className="transition-colors hover:text-[#c0c1ff]">
                Docs
              </Link>
              <Link href="/login" className="transition-colors hover:text-[#c0c1ff]">
                Login
              </Link>
              <Link href="/signup" className="transition-colors hover:text-[#c0c1ff]">
                Beta Access
              </Link>
            </div>
          </div>
        </footer>
      </div>
    </div>
  );
}

function AgentRow({
  letter,
  name,
  role,
  active,
}: {
  letter: string;
  name: string;
  role: string;
  active?: boolean;
}) {
  return (
    <div
      className={`flex items-center gap-4 p-4 ${
        active ? "border-l-2 border-[#c0c1ff] bg-[#c0c1ff]/6" : "opacity-55 grayscale"
      }`}
    >
      <div
        className={`flex h-10 w-10 items-center justify-center font-[var(--font-space-grotesk)] text-sm font-bold ${
          active ? "bg-[#c0c1ff]/20 text-[#c0c1ff]" : "bg-[#1f1f24] text-[#8f9098]"
        }`}
      >
        {letter}
      </div>
      <div>
        <div className="font-[var(--font-space-grotesk)] text-sm font-bold text-[#e7e4ec]">
          {name}
        </div>
        <div
          className={`font-mono text-[10px] uppercase tracking-[0.18em] ${
            active ? "text-[#c0c1ff]" : "text-[#6f7078]"
          }`}
        >
          {role}
        </div>
      </div>
    </div>
  );
}
