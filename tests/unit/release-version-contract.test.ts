import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * The deployed version must come from the release tag, end to end:
 * tag → build arg → image env → src/lib/app-version.ts → /api/health.
 *
 * Reading the wiring as text is deliberate. The bug (v0.31.1 reporting 0.31.0)
 * was not a wrong value at runtime, it was a missing link in the pipeline that
 * silently degraded to a stale package.json. A unit test over the app code
 * cannot see that; this one fails as soon as a link is removed.
 */
const ROOT = path.resolve(process.cwd());
const read = (rel: string): string => readFileSync(path.join(ROOT, rel), "utf8");

test("the image declares APP_VERSION in both stages and exports it to the runtime", () => {
    const dockerfile = read("Dockerfile");
    const argCount = dockerfile.match(/^ARG APP_VERSION="?"?$/gm)?.length ?? 0;
    const envCount = dockerfile.match(/^ENV APP_VERSION=\$APP_VERSION$/gm)?.length ?? 0;
    assert.ok(argCount >= 2, "Dockerfile must declare ARG APP_VERSION in the builder and runner stages");
    assert.ok(envCount >= 2, "Dockerfile must export APP_VERSION in the builder and runner stages");
});

test("Docker Publish resolves the tag and passes it as the APP_VERSION build arg", () => {
    const workflow = read(".github/workflows/docker-publish.yml");
    assert.match(workflow, /id: version/, "a step must resolve the version once");
    assert.match(workflow, /GITHUB_REF_NAME/, "the version must come from the pushed tag");
    assert.match(workflow, /tag '\$tag' is not a semver release tag/, "non-semver tags must fail the release");
    assert.match(
        workflow,
        /build-args:\s*\|\s*\n\s*APP_VERSION=\$\{\{ steps\.version\.outputs\.version \}\}/,
        "the build must receive APP_VERSION from the resolved tag",
    );
});

test("no self-reporting route falls back to the stale package.json version", () => {
    for (const rel of ["src/app/api/health/route.ts", "src/app/api/version/route.ts", "src/app/api/updates/check/route.ts"]) {
        const source = read(rel);
        assert.match(source, /appVersion\(\)/, `${rel} must report appVersion()`);
        assert.doesNotMatch(source, /pkg\.version/, `${rel} must not report the package.json version directly`);
    }
});

test("the managed runtime image follows the release the server itself runs", () => {
    // The bridge and the runtime speak one protocol version, so provisioning the
    // previous release's image is the same drift as reporting it: v0.31.1
    // provisioned emperorclaw-hermes:v0.31.0 because this read package.json.
    const source = read("src/lib/hermes-provisioning.ts");
    assert.match(
        source,
        /export const HERMES_IMAGE = HERMES_IMAGE_OVERRIDE \|\| hermesImageForVersion\(appVersion\(\)\)/,
        "HERMES_IMAGE must be tagged with appVersion(), not package.json",
    );
    assert.doesNotMatch(source, /pkg\.version/, "hermes-provisioning must not read the package.json version");
    assert.match(source, /from "@\/lib\/app-version"/, "the release version comes from app-version.ts");
});

test("the build inlines the release tag for client components (login footer)", () => {
    // A client component cannot read APP_VERSION at runtime, so the login footer
    // needs the value inlined by next.config.ts — otherwise it is the one
    // surface left reporting the stale package.json version.
    const config = read("next.config.ts");
    assert.match(
        config,
        /env:\s*\{\s*NEXT_PUBLIC_APP_VERSION:\s*process\.env\.APP_VERSION/,
        "next.config.ts must inline APP_VERSION as NEXT_PUBLIC_APP_VERSION",
    );
    const login = read("src/app/(auth)/login/page.tsx");
    assert.match(login, /process\.env\.NEXT_PUBLIC_APP_VERSION/, "the login footer must prefer the inlined tag");
    assert.match(login, /v\{BUILD_VERSION\}/, "the login footer must render BUILD_VERSION, not pkg.version");
    assert.doesNotMatch(login, /v\{pkg\.version\}/, "no surface renders the raw package.json version");
});

test("app-version keeps package.json as the documented fallback", () => {
    const source = read("src/lib/app-version.ts");
    assert.match(source, /process\.env\.APP_VERSION/, "the build version must be read from the environment");
    assert.match(source, /FALLBACK_VERSION[^=]*=\s*pkg\.version/, "package.json stays the local-dev fallback");
});

test("the release checklist documents where the reported version comes from", () => {
    const docs = read("docs/RELEASE.md");
    assert.match(docs, /APP_VERSION/);
    assert.match(docs, /\/api\/health/);
});
