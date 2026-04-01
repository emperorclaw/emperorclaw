import type { EmperorPluginPaths } from "../state/paths.js";
import { runDoctor, formatDoctorReport } from "../install/health.js";

export function registerDoctorCommand(api: any, paths: EmperorPluginPaths): void {
  api.registerCommand({
    name: "emperor-doctor",
    description: "Run an Emperor Claw OS local health check",
    async execute() {
      const report = await runDoctor(paths);
      return {
        content: [{
          type: "text",
          text: formatDoctorReport(report)
        }]
      };
    }
  });
}
