/**
 * Which image may a self-update promote?
 *
 * `/api/ops/update` used to pull `ghcr.io/emperorclaw/emperorclaw:latest` and
 * recreate the app container with it, so anyone with platform admin could move
 * production to a floating tag from the browser, past the release gate, and undo
 * the digest pin that compose holds. Production now runs a digest, so the rule
 * is simple: a floating reference may never replace a pinned one.
 *
 * Pure helpers on purpose — the route talks to the Docker socket, this file only
 * decides, so the decision is testable without a daemon.
 */

export type ParsedImageRef = {
    /** Reference as given, trimmed. */
    ref: string;
    /** Everything before the tag/digest, e.g. `ghcr.io/emperorclaw/emperorclaw`. */
    repository: string;
    /** Tag, when the reference carries one. */
    tag: string | null;
    /** `sha256:…` digest, when the reference is pinned. */
    digest: string | null;
};

const DIGEST_RE = /@(sha256:[a-f0-9]{64})$/i;
const TAG_RE = /:([A-Za-z0-9_][A-Za-z0-9_.-]{0,127})$/;

/**
 * Split an image reference into repository, tag and digest without guessing.
 * Returns null for an empty reference so callers can treat "nothing configured"
 * as its own case instead of as a repository named "".
 */
export function parseImageRef(raw: string | null | undefined): ParsedImageRef | null {
    const ref = (raw ?? "").trim();
    if (!ref) return null;

    const digestMatch = ref.match(DIGEST_RE);
    if (digestMatch) {
        const repository = ref.slice(0, digestMatch.index);
        // `repo:tag@sha256:…` is legal; the digest is what will be pulled, and the
        // tag survives only as a human hint.
        const tagOnly = repository.match(TAG_RE);
        return {
            ref,
            repository: tagOnly ? repository.slice(0, tagOnly.index) : repository,
            tag: tagOnly ? tagOnly[1] : null,
            digest: digestMatch[1].toLowerCase(),
        };
    }

    const tagMatch = ref.match(TAG_RE);
    // A colon before the last slash belongs to a registry port (`localhost:5000/app`),
    // not to a tag.
    const lastSlash = ref.lastIndexOf("/");
    if (tagMatch && tagMatch.index !== undefined && tagMatch.index > lastSlash) {
        return { ref, repository: ref.slice(0, tagMatch.index), tag: tagMatch[1], digest: null };
    }
    return { ref, repository: ref, tag: null, digest: null };
}

/**
 * `latest` and an omitted tag both mean "whatever the registry has right now".
 * Those are the two ways an un-gated build can reach production.
 */
export function isFloatingImageRef(raw: string | null | undefined): boolean {
    const parsed = parseImageRef(raw);
    if (!parsed) return false;
    if (parsed.digest) return false;
    return parsed.tag === null || parsed.tag.toLowerCase() === "latest";
}

/**
 * Pull the `image:` a compose file declares, preferring the one that belongs to
 * the same repository the app already runs. Compose files are hand-written, so
 * this reads the value the way a reader would — a line per service — and ignores
 * anything that is not a scalar reference.
 */
export function parseComposeImage(yaml: string | null | undefined, repository?: string | null): string | null {
    const text = yaml ?? "";
    const wanted = (repository ?? "").trim();
    const found: string[] = [];
    for (const line of text.split(/\r?\n/)) {
        const match = line.match(/^\s{2,}image:\s*["']?([^"'\s#]+)["']?\s*(?:#.*)?$/);
        if (match) found.push(match[1]);
    }
    if (found.length === 0) return null;
    if (!wanted) return found[0];
    return found.find(ref => parseImageRef(ref)?.repository === wanted) ?? null;
}

export type UpdateTargetSource = "env" | "compose-file" | "compose" | "default";

export type UpdateTarget =
    | { ok: true; ref: string; source: UpdateTargetSource; floating: boolean }
    | { ok: false; code: "no-target" | "floating-blocked"; message: string };

export type ResolveUpdateTargetInput = {
    /** `EMPEROR_UPDATE_IMAGE`, when the operator set it. */
    envImage?: string | null;
    /** `image:` read from the compose file on disk, when it is reachable. */
    composeFileImage?: string | null;
    /** The `image:` the container was created from (compose's value). */
    composeImage?: string | null;
    /** The reference the running container was started from, tag and digest included. */
    runningImage?: string | null;
    /** Used only when neither of the above is set. */
    defaultImage?: string | null;
};

/**
 * Does a reference promise specific bytes? A digest does, and so does an explicit
 * release tag; `latest` (or no tag at all) does not.
 */
export function isPinnedReference(raw: string | null | undefined): boolean {
    const parsed = parseImageRef(raw);
    if (!parsed) return false;
    if (parsed.digest) return true;
    return parsed.tag !== null && parsed.tag.toLowerCase() !== "latest";
}

/**
 * Decide what this update may promote.
 *
 * Order: `EMPEROR_UPDATE_IMAGE` (explicit operator intent) → the `image:` the
 * compose file declares → the reference the container was created from → the
 * built-in default. When that target
 * is floating and the container currently runs a pinned reference, it is refused:
 * keeping the pin is the whole point, and pulling `:latest` would both bypass the
 * gate and silently drop the digest.
 */
export function resolveUpdateTarget(input: ResolveUpdateTargetInput): UpdateTarget {
    const envImage = (input.envImage ?? "").trim();
    const composeFileImage = (input.composeFileImage ?? "").trim();
    const composeImage = (input.composeImage ?? "").trim();
    const defaultImage = (input.defaultImage ?? "").trim();

    let ref: string;
    let source: UpdateTargetSource;
    if (envImage) {
        ref = envImage;
        source = "env";
    } else if (composeFileImage) {
        ref = composeFileImage;
        source = "compose-file";
    } else if (composeImage) {
        ref = composeImage;
        source = "compose";
    } else if (defaultImage) {
        ref = defaultImage;
        source = "default";
    } else {
        return {
            ok: false,
            code: "no-target",
            message:
                "No image reference to promote: set EMPEROR_UPDATE_IMAGE to a release tag or a @sha256:… digest.",
        };
    }

    const floating = isFloatingImageRef(ref);
    if (floating && isPinnedReference(input.runningImage)) {
        return {
            ok: false,
            code: "floating-blocked",
            message:
                `Refusing to promote the floating reference "${ref}" (from ${source}) over a pinned ` +
                `container running "${(input.runningImage ?? "").trim()}". A release is promoted by tag or ` +
                `digest — set EMPEROR_UPDATE_IMAGE to the release tag (vX.Y.Z) or its @sha256:… digest, and ` +
                `keep the pin in docker-compose.yml.`,
        };
    }

    return { ok: true, ref, source, floating };
}

/**
 * A short, log-safe description of an image reference: a digest is truncated in
 * the middle so two digests can be told apart at a glance in the steps list.
 */
export function describeImageRef(raw: string | null | undefined): string {
    const parsed = parseImageRef(raw);
    if (!parsed) return "(none)";
    if (parsed.digest) return `${parsed.repository}@sha256:${parsed.digest.slice(7, 19)}…`;
    return parsed.tag ? `${parsed.repository}:${parsed.tag}` : parsed.repository;
}

/**
 * HTTP status for a self-update attempt: a refusal is a conflict with policy
 * (409), not a server failure, and anything else that errored stays a 500.
 */
export function updateHttpStatus(result: { refused: boolean; steps: { status: string }[] }): 200 | 409 | 500 {
    if (result.refused) return 409;
    return result.steps.every(step => step.status !== "error") ? 200 : 500;
}
