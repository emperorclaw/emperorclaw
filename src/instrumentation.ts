export async function register() {
    if (process.env.NEXT_RUNTIME === 'nodejs') {
        const { startWatchdog } = await import('./lib/watchdog');
        const { startLifecycleMonitor } = await import('./lib/lifecycle');
        startWatchdog();
        startLifecycleMonitor();
    }
}
