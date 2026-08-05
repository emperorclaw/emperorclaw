/**
 * Renders a list of command/stdout/stderr/exitCode entries — extracted from
 * `SetupBanner`'s existing auto-setup output block (`agent-detail-panel.tsx`)
 * so it can be reused by the recreate-runtime action and the Easy Setup
 * wizard's "done" step. Visual styling is unchanged from the original.
 */
export type SetupOutputEntry = {
    command: string;
    stdout: string;
    stderr: string;
    exitCode: number | null;
};

export function SetupOutputLog({ outputs }: { outputs: SetupOutputEntry[] }) {
    if (!outputs || outputs.length === 0) return null;

    return (
        <div className="space-y-1.5 max-h-[180px] overflow-y-auto">
            {outputs.map((o, i) => (
                <div key={i} className={`rounded px-2 py-1 font-mono text-[10px] ${o.exitCode === 0 ? "bg-black/30 text-emerald-100/60" : "bg-black/30 text-rose-100/60"}`}>
                    <div className="text-zinc-500 mb-0.5">$ {o.command}</div>
                    {o.stdout && <div className="text-zinc-300">{o.stdout}</div>}
                    {o.stderr && <div className="text-rose-300/70">{o.stderr}</div>}
                </div>
            ))}
        </div>
    );
}
