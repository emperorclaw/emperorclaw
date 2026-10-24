// Bundle server.ts (the custom HTTP + WebSocket server) into the Next.js
// standalone output, so the production image runs our server instead of the
// stock .next/standalone/server.js (which has no /api/mcp/ws, /api/ws or
// Postgres LISTEN fan-out).
//
// Runs after `next build`. Packages already traced into
// .next/standalone/node_modules (next, react, pg, drizzle-orm, argon2, ...)
// stay external so the server shares them with Next; everything else
// (ws, next-auth, dotenv, ...) is bundled in.
import { build } from "esbuild";
import { existsSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const standaloneDir = join(root, ".next", "standalone");
const standaloneModules = join(standaloneDir, "node_modules");

if (!existsSync(join(standaloneDir, ".next", "required-server-files.json"))) {
    console.error("build-server: .next/standalone is missing. Run `next build` first (output: \"standalone\").");
    process.exit(1);
}

/** Top-level package names present in the standalone node_modules. */
function tracedPackages() {
    const names = [];
    for (const entry of readdirSync(standaloneModules, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
        if (entry.name.startsWith("@")) {
            for (const scoped of readdirSync(join(standaloneModules, entry.name), { withFileTypes: true })) {
                if (scoped.isDirectory()) names.push(`${entry.name}/${scoped.name}`);
            }
        } else {
            names.push(entry.name);
        }
    }
    return names;
}

const external = [
    ...tracedPackages(),
    // Never bundle Next itself, even if tracing changes shape.
    "next",
    // Optional native accelerators that ws / pg probe for with try/require.
    "bufferutil",
    "utf-8-validate",
    "pg-native",
].flatMap((name) => [name, `${name}/*`]);

// Runs before any module in the bundle: the same setup Next's generated
// standalone server.js does, so next({ dev: false }) loads the serialized
// build config instead of looking for next.config.ts.
const banner = `
process.env.NODE_ENV = "production";
process.chdir(__dirname);
if (!process.env.__NEXT_PRIVATE_STANDALONE_CONFIG) {
  process.env.__NEXT_PRIVATE_STANDALONE_CONFIG = JSON.stringify(
    require(require("path").join(__dirname, ".next", "required-server-files.json")).config
  );
}
`;

const outfile = join(standaloneDir, "emperor-server.js");

await build({
    entryPoints: [join(root, "server.ts")],
    outfile,
    bundle: true,
    platform: "node",
    target: "node20",
    format: "cjs",
    tsconfig: join(root, "tsconfig.json"),
    external,
    banner: { js: banner },
    legalComments: "none",
    logLevel: "warning",
});

console.log(`build-server: wrote ${outfile.slice(root.length + 1)}`);
