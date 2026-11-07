import pkg from "@/../package.json" assert { type: "json" };

/**
 * Version of the build that is actually running.
 *
 * The release workflow (`.github/workflows/docker-publish.yml`) passes the git
 * tag as the `APP_VERSION` build arg and the Dockerfile exports it into the
 * image environment. That makes the tag the source of truth for a released
 * image, so `/api/health`, `/api/version` and the update banner report the
 * version that was deployed even when `package.json` was not bumped before
 * tagging — which is exactly how v0.31.1 shipped while `package.json` still
 * said 0.31.0.
 *
 * Without `APP_VERSION` (local dev, unit tests, a plain `npm start`) the
 * `package.json` version is the best available answer.
 *
 * `process.env` is read on every call, not at module load: the answer must come
 * from the running process, and tests set the variable per case.
 */
const FALLBACK_VERSION: string = pkg.version;

/**
 * `v1.2.3` → `1.2.3`. Every consumer (semver comparison, UI, health probes)
 * expects a bare version. Only a leading `v` followed by a digit is stripped, so
 * `v1.2.3-rc.1` keeps working and a value that does not look like a version is
 * left untouched instead of being silently mangled.
 */
export function normalizeVersion(raw: string): string {
    return raw.trim().replace(/^v(?=\d)/i, "");
}

/** The version of the running build: the release tag, else `package.json`. */
export function appVersion(): string {
    const fromBuild = (process.env.APP_VERSION ?? "").trim();
    return normalizeVersion(fromBuild.length > 0 ? fromBuild : FALLBACK_VERSION);
}
