export async function register() {
    if (process.env.NEXT_RUNTIME === 'nodejs') {
        const { startWatchdog } = await import('./lib/watchdog');
        const { startLifecycleMonitor } = await import('./lib/lifecycle');
        const { ensureArtifactStorageSchema } = await import('./lib/artifact-schema');
        startWatchdog();
        startLifecycleMonitor();
        // Run storage schema setup once at startup instead of on every artifact request.
        await ensureArtifactStorageSchema();
    }
}
