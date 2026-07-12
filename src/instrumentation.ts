/**
 * Fail fast on a misconfigured install with one readable message instead of
 * a stack trace from whichever module happens to touch the missing var first.
 */
function assertEnv() {
    const required = ["POSTGRES_CONNECTION_STRING", "NEXTAUTH_SECRET"];
    const missing = required.filter((name) => !process.env[name]);
    if (missing.length > 0) {
        throw new Error(
            `Missing required environment variable(s): ${missing.join(", ")}. ` +
            `Copy .env.example to .env and fill in the values (see README Quick Start).`
        );
    }
    if (!process.env.EMPEROR_CLAW_MASTER_KEY) {
        console.warn(
            "[startup] EMPEROR_CLAW_MASTER_KEY is not set — integration secrets will not be " +
            "encrypted at rest. Generate one with: openssl rand -hex 32"
        );
    }
}

export async function register() {
    if (process.env.NEXT_RUNTIME === 'nodejs') {
        assertEnv();
        const { startWatchdog } = await import('./lib/watchdog');
        const { startLifecycleMonitor } = await import('./lib/lifecycle');
        const { ensureArtifactStorageSchema } = await import('./lib/artifact-schema');
        startWatchdog();
        startLifecycleMonitor();
        // Run storage schema setup once at startup instead of on every artifact request.
        await ensureArtifactStorageSchema();
    }
}
