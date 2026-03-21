/* eslint-disable @typescript-eslint/no-require-imports */
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const repoRoot = path.resolve(__dirname, "..");
const skillDir = path.join(repoRoot, "clawhub", "emperor-claw-os");
const publicDir = path.join(repoRoot, "public", "emperor-claw-os");
const skillPackagePath = path.join(skillDir, "package.json");
const skillPackage = JSON.parse(fs.readFileSync(skillPackagePath, "utf8"));
const copyOnly = process.argv.includes("--copy-only");

fs.mkdirSync(publicDir, { recursive: true });
fs.cpSync(skillDir, publicDir, { recursive: true, force: true });

if (copyOnly) {
    console.log(`Copied emperor-claw-os@${skillPackage.version} to public/emperor-claw-os`);
    process.exit(0);
}

const args = [
    "clawhub",
    "publish",
    ".",
    "--slug",
    "emperor-claw-os",
    "--name",
    "control-plane",
    "--version",
    skillPackage.version,
    "--tags",
    "latest",
];

const result = process.platform === "win32"
    ? spawnSync(process.env.ComSpec || "cmd.exe", [
        "/d",
        "/s",
        "/c",
        `npx ${args.map((arg) => arg.includes(" ") ? `"${arg}"` : arg).join(" ")}`,
    ], {
        cwd: skillDir,
        stdio: "inherit",
        shell: false,
    })
    : spawnSync("npx", args, {
        cwd: skillDir,
        stdio: "inherit",
        shell: false,
    });

if (result.error) {
    throw result.error;
}

process.exit(result.status ?? 1);
