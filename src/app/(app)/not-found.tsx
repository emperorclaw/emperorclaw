import Link from "next/link";

export default function NotFound() {
    return (
        <div className="flex h-screen items-center justify-center">
            <div className="emperor-panel max-w-md text-center space-y-4">
                <h1 className="text-4xl font-bold text-cyan-400">404</h1>
                <p className="text-lg font-semibold text-white">Page not found</p>
                <p className="text-sm text-white/60">
                    The page you&apos;re looking for doesn&apos;t exist or has been moved.
                </p>
                <Link
                    href="/"
                    className="inline-block rounded-full border border-cyan-400/40 px-4 py-2 text-sm text-cyan-300 hover:bg-cyan-400/10 transition-colors"
                >
                    Go home
                </Link>
            </div>
        </div>
    );
}
