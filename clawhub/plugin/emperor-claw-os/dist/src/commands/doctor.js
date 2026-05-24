import { ensurePluginLayout } from "../state/paths.js";
import { runDoctor, formatDoctorReport } from "../install/health.js";
import { loadLocalConfig } from "../install/config.js";
export function registerDoctorCommand(api, paths) {
    api.registerCommand({
        name: "emperor-doctor",
        description: "Run an Emperor Claw OS local health check",
        handler: async () => {
            ensurePluginLayout(paths);
            const localConfig = loadLocalConfig(paths);
            const report = await runDoctor(paths);
            const prefix = localConfig
                ? `Local config: ${JSON.stringify(localConfig)}\n\n`
                : "Local config: missing\n\n";
            return { text: prefix + formatDoctorReport(report) };
        }
    });
}
