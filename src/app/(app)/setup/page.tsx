import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Settings, Link as LinkIcon, Download } from "lucide-react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

export default function SetupPage() {
    return (
        <div className="flex-1 space-y-4 p-8 pt-6 max-w-4xl">
            <div className="flex items-center justify-between space-y-2">
                <h2 className="text-3xl font-bold tracking-tight text-white mb-6">OpenClaw Integration</h2>
            </div>
            <p className="text-zinc-400 mb-8">
                Connect your OpenClaw runtime to the Emperor Claw Control Plane by installing the official skill and then running the local companion bootstrap.
                The skill provides the contract. The bootstrap and doctor flow validates the real runtime path: websocket reachability, token auth, sessions, heartbeats, threads, and checkpoints.
            </p>

            <Tabs defaultValue="install" className="space-y-4">
                <TabsList className="bg-zinc-900 border border-zinc-800">
                    <TabsTrigger value="install" className="data-[state=active]:bg-zinc-800">1. Install the Skill</TabsTrigger>
                    <TabsTrigger value="configure" className="data-[state=active]:bg-zinc-800">2. Bootstrap & Doctor</TabsTrigger>
                    <TabsTrigger value="context" className="data-[state=active]:bg-zinc-800">3. Global Context</TabsTrigger>
                </TabsList>

                <TabsContent value="install" className="space-y-4">
                    <Card className="bg-zinc-950 border-zinc-800 text-zinc-100">
                        <CardHeader>
                            <CardTitle className="flex items-center gap-2">
                                <Download className="w-5 h-5 text-indigo-400" />
                                Add the Emperor Claw OS Skill
                            </CardTitle>
                            <CardDescription className="text-zinc-400">
                                Run this command in your OpenClaw environment to install the required capabilities.
                            </CardDescription>
                        </CardHeader>
                        <CardContent className="space-y-4">
                            <div className="bg-zinc-900 p-4 rounded-md border border-zinc-800 overflow-x-auto">
                                <pre className="text-sm font-mono text-zinc-300">
                                    {`openclaw install https://emperorclaw.malecu.eu/api/skills/registry/emperor-claw-os`}
                                </pre>
                            </div>
                            <p className="text-sm text-zinc-400">
                                This downloads the <code className="text-indigo-400 px-1 py-0.5 rounded bg-indigo-500/10">SKILL.md</code> contract for Emperor Claw OS. After install, use the local bootstrap and doctor flow to wire and validate the real runtime path.
                            </p>
                        </CardContent>
                    </Card>
                </TabsContent>

                <TabsContent value="configure" className="space-y-4">
                    <Card className="bg-zinc-950 border-zinc-800 text-zinc-100">
                        <CardHeader>
                            <CardTitle className="flex items-center gap-2">
                                <Settings className="w-5 h-5 text-rose-400" />
                                Local Bootstrap, Tokens, and Validation
                            </CardTitle>
                            <CardDescription className="text-zinc-400">
                                Use a company token together with the local companion bootstrap and doctor commands.
                            </CardDescription>
                        </CardHeader>
                        <CardContent className="space-y-4">
                            <p className="text-sm text-zinc-400">
                                Export your company token, run bootstrap once, then run doctor before starting the bridge.
                            </p>
                            <div className="bg-zinc-900 p-4 rounded-md border border-zinc-800 overflow-x-auto">
                                <pre className="text-sm font-mono text-zinc-300">
                                    {`# Required: Get your Company Token from the API Access page
EMPEROR_CLAW_API_TOKEN=your_token_here
npm run control-plane:bootstrap
npm run control-plane:doctor
node clawhub/emperor-claw-os/examples/bridge.js`}
                                </pre>
                            </div>
                            <div className="bg-zinc-900 p-4 rounded-md border border-zinc-800 overflow-x-auto">
                                <pre className="text-sm font-mono text-zinc-300">
                                    {`# The companion writes a local directory under ~/.openclaw/emperor-control-plane
# with bridge launchers, a doctor wrapper, and a conservative config overlay.`}
                                </pre>
                            </div>
                            <p className="text-sm text-zinc-400 mt-4">
                                <strong>Note on Network Architecture:</strong>
                                Emperor is WebSocket-first over <code className="text-rose-400 px-1 py-0.5 rounded bg-rose-500/10">wss://.../api/mcp/ws</code>. Use <code className="text-rose-400 px-1 py-0.5 rounded bg-rose-500/10">GET /api/mcp/messages/sync</code> only as a fallback if realtime websocket connectivity is blocked.
                            </p>
                        </CardContent>
                    </Card>
                </TabsContent>

                <TabsContent value="context" className="space-y-4">
                    <Card className="bg-zinc-950 border-zinc-800 text-zinc-100">
                        <CardHeader>
                            <CardTitle className="flex items-center gap-2">
                                <LinkIcon className="w-5 h-5 text-emerald-400" />
                                Setting Global Rules
                            </CardTitle>
                            <CardDescription className="text-zinc-400">
                                Give your autonomous workforce the necessary background context.
                            </CardDescription>
                        </CardHeader>
                        <CardContent className="space-y-4">
                            <p className="text-sm text-zinc-400">
                                Before dispatching real work, navigate to the <strong>Settings</strong> page and define your <strong>Global Company Context</strong>.
                            </p>
                            <div className="bg-zinc-900 p-4 rounded-md border border-zinc-800">
                                <ul className="list-disc list-inside text-sm text-zinc-300 space-y-2">
                                    <li>Provide your company name and core objectives.</li>
                                    <li>Detail your ideal customer profile or target audience.</li>
                                    <li>Specify any strict bounds, tone guidelines, or required operational security constraints.</li>
                                </ul>
                            </div>
                            <p className="text-sm text-zinc-400 mt-4">
                                This context is available as durable company context for your runtime and agents, ensuring they represent your organization accurately without relying on fake orchestration helpers.
                            </p>
                        </CardContent>
                    </Card>
                </TabsContent>
            </Tabs>
        </div>
    );
}
