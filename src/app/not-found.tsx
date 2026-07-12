import Link from "next/link";
import { FileQuestion } from "lucide-react";

export default function NotFound() {
    return (
        <div className="flex h-screen items-center justify-center bg-zinc-950">
            <div className="emperor-panel max-w-md space-y-4 rounded-2xl p-8 text-center">
                <FileQuestion className="mx-auto h-10 w-10 text-cyan-400" />
                <h1 className="text-lg font-semibold text-white">Page not found</h1>
                <p className="text-sm text-white/60">
                    The page you&apos;re looking for doesn&apos;t exist or has been moved.
                </p>
                <Link
                    href="/"
                    className="inline-block rounded-full border border-cyan-400/40 px-4 py-2 text-sm text-cyan-300 transition-colors hover:bg-cyan-400/10"
                >
                    Back to dashboard
                </Link>
            </div>
        </div>
    );
}
