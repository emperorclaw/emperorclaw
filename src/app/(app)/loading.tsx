export default function Loading() {
    return (
        <div className="min-h-screen w-full bg-gradient-to-br from-zinc-950 via-zinc-900 to-zinc-950 text-zinc-200">
            <div className="max-w-6xl mx-auto px-8 py-10">
                <div className="flex items-center justify-between mb-10">
                    <div className="space-y-2">
                        <div className="h-6 w-56 bg-zinc-800/70 rounded animate-pulse" />
                        <div className="h-4 w-80 bg-zinc-900/70 rounded animate-pulse" />
                    </div>
                    <div className="h-9 w-40 bg-zinc-900/70 rounded animate-pulse" />
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-6">
                    {Array.from({ length: 6 }).map((_, i) => (
                        <div key={i} className="rounded-xl border border-zinc-800/70 bg-zinc-900/40 p-5">
                            <div className="h-4 w-24 bg-zinc-800/70 rounded animate-pulse mb-4" />
                            <div className="h-5 w-2/3 bg-zinc-800/70 rounded animate-pulse mb-3" />
                            <div className="h-3 w-5/6 bg-zinc-900/70 rounded animate-pulse mb-2" />
                            <div className="h-3 w-4/6 bg-zinc-900/70 rounded animate-pulse" />
                        </div>
                    ))}
                </div>

                <div className="mt-10 flex items-center space-x-3 text-sm text-zinc-400">
                    <div className="h-2.5 w-2.5 rounded-full bg-indigo-400 animate-pulse" />
                    <span>Loading workspace...</span>
                </div>
            </div>
        </div>
    );
}
