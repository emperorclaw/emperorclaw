import fs from "node:fs";
import path from "node:path";
function manifestPath(paths, slug) {
    return path.join(paths.manifestRoot, `${slug}.json`);
}
export function slugifyManifestId(value) {
    return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}
export function loadManifests(paths) {
    if (!fs.existsSync(paths.manifestRoot))
        return [];
    return fs.readdirSync(paths.manifestRoot)
        .filter((name) => name.endsWith(".json"))
        .map((name) => path.join(paths.manifestRoot, name))
        .map((filePath) => JSON.parse(fs.readFileSync(filePath, "utf8")));
}
export function writeManifest(paths, slug, manifest) {
    const filePath = manifestPath(paths, slug);
    fs.writeFileSync(filePath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    return filePath;
}
export function resolveManifestPath(paths, localBrainAgentId) {
    return manifestPath(paths, slugifyManifestId(localBrainAgentId));
}
