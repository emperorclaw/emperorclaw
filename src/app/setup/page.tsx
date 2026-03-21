import Link from "next/link";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Download, ExternalLink, Settings, Terminal } from "lucide-react";

export default function SetupPage() {
    return (
        <div className="min-h-screen bg-zinc-950 text-zinc-100">
            <div className="mx-auto flex max-w-5xl flex-col gap-8 px-6 py-12">
                <div className="flex flex-wrap items-start justify-between gap-4">
                    <div className="space-y-3">
                        <div className="inline-flex items-center gap-2 rounded-full border border-zinc-800 bg-zinc-900 px-3 py-1 text-xs font-semibold uppercase tracking-[0.18em] text-zinc-400">
                            <Terminal className="h-3.5 w-3.5" />
                            OpenClaw Setup
                        </div>
                        <h1 className="text-4xl font-semibold tracking-tight text-white">Install Emperor Control Plane</h1>
                        <p className="max-w-3xl text-sm leading-6 text-zinc-400">
                            Install the published skill, run the local installer, validate with doctor, and start the generated bridge launcher.
                            This is the supported path for connecting OpenClaw to Emperor without taking over local OpenClaw ownership.
                        </p>
                    </div>
                    <div className="flex items-center gap-3">
                        <Link href="/login" className="rounded-lg border border-zinc-800 bg-zinc-900 px-4 py-2 text-sm font-medium text-zinc-300 transition-colors hover:bg-zinc-800 hover:text-white">
                            Login
                        </Link>
                    </div>
                </div>

                <div className="grid gap-6 lg:grid-cols-3">
                    <Card className="border-zinc-800 bg-zinc-950 lg:col-span-3">
                        <CardHeader>
                            <CardTitle className="flex items-center gap-2 text-zinc-100">
                                <ExternalLink className="h-5 w-5 text-indigo-400" />
                                1. Install the Skill in OpenClaw
                            </CardTitle>
                            <CardDescription className="text-zinc-400">
                                Install the published ClawHub skill first. The local installer comes after this.
                            </CardDescription>
                        </CardHeader>
                        <CardContent>
                            <div className="overflow-x-auto rounded-md border border-zinc-800 bg-zinc-900 p-4">
                                <pre className="text-sm text-zinc-200">{`openclaw install https://emperorclaw.malecu.eu/api/skills/registry/emperor-claw-os`}</pre>
                            </div>
                        </CardContent>
                    </Card>

                    <Card className="border-zinc-800 bg-zinc-950">
                        <CardHeader>
                            <CardTitle className="flex items-center gap-2 text-zinc-100">
                                <Download className="h-5 w-5 text-emerald-400" />
                                2. Download Installer
                            </CardTitle>
                            <CardDescription className="text-zinc-400">
                                Use the platform installer. It asks only for the Emperor URL and company MCP token.
                            </CardDescription>
                        </CardHeader>
                        <CardContent className="space-y-3">
                            <a href="/install.sh" className="flex items-center justify-between rounded-lg border border-zinc-800 bg-zinc-900 px-4 py-3 text-sm font-medium text-zinc-200 transition-colors hover:bg-zinc-800">
                                <span>macOS / Linux</span>
                                <span className="font-mono text-xs text-zinc-500">install.sh</span>
                            </a>
                            <a href="/install.ps1" className="flex items-center justify-between rounded-lg border border-zinc-800 bg-zinc-900 px-4 py-3 text-sm font-medium text-zinc-200 transition-colors hover:bg-zinc-800">
                                <span>Windows PowerShell</span>
                                <span className="font-mono text-xs text-zinc-500">install.ps1</span>
                            </a>
                        </CardContent>
                    </Card>

                    <Card className="border-zinc-800 bg-zinc-950 lg:col-span-2">
                        <CardHeader>
                            <CardTitle className="flex items-center gap-2 text-zinc-100">
                                <Settings className="h-5 w-5 text-rose-400" />
                                3. Run the Installer
                            </CardTitle>
                            <CardDescription className="text-zinc-400">
                                The installer writes the companion files under <code className="rounded bg-zinc-900 px-1 py-0.5 text-zinc-300">~/.openclaw/emperor-control-plane</code>,
                                runs bootstrap, and offers to run doctor immediately.
                            </CardDescription>
                        </CardHeader>
                        <CardContent className="space-y-4">
                            <div className="grid gap-4 md:grid-cols-2">
                                <div className="overflow-x-auto rounded-md border border-zinc-800 bg-zinc-900 p-4">
                                    <div className="mb-2 text-xs font-semibold uppercase tracking-[0.18em] text-zinc-500">macOS / Linux</div>
                                    <pre className="text-sm text-zinc-200">{`chmod +x ./install.sh\n./install.sh`}</pre>
                                </div>
                                <div className="overflow-x-auto rounded-md border border-zinc-800 bg-zinc-900 p-4">
                                    <div className="mb-2 text-xs font-semibold uppercase tracking-[0.18em] text-zinc-500">Windows PowerShell</div>
                                    <pre className="text-sm text-zinc-200">{`./install.ps1`}</pre>
                                </div>
                            </div>
                            <div className="rounded-md border border-zinc-800 bg-zinc-900 p-4 text-sm text-zinc-400">
                                The installer does not take over full OpenClaw config ownership. It writes a conservative overlay and local launchers only.
                            </div>
                        </CardContent>
                    </Card>

                    <Card className="border-zinc-800 bg-zinc-950 lg:col-span-3">
                        <CardHeader>
                            <CardTitle className="text-zinc-100">What Gets Created</CardTitle>
                            <CardDescription className="text-zinc-400">
                                After install, use these generated local launchers instead of memorizing the repo commands.
                            </CardDescription>
                        </CardHeader>
                        <CardContent>
                            <div className="overflow-x-auto rounded-md border border-zinc-800 bg-zinc-900 p-4">
                                <pre className="text-sm text-zinc-200">{`~/.openclaw/emperor-control-plane/
  bridge.config.json
  run-bridge.sh / run-bridge.cmd
  doctor.sh / doctor.cmd
  sync.sh / sync.cmd
  repair.sh / repair.cmd
  session-inspect.sh / session-inspect.cmd
  openclaw.control-plane.json`}</pre>
                            </div>
                        </CardContent>
                    </Card>
                </div>
            </div>
        </div>
    );
}
