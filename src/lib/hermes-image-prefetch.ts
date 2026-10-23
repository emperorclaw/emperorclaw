/**
 * One shared pull of the Hermes runtime image per process.
 *
 * The runtime image is ~3.8 GB, so a fresh install used to block its first
 * hire on that download. The server now starts the pull in the background on
 * boot, and provisioning joins the in-flight pull instead of starting a second
 * one. Progress is aggregated from Docker's pull stream so the setup wizard can
 * show a real progress bar.
 *
 * State lives on globalThis: Next.js bundles instrumentation and route handlers
 * separately, so a plain module-level variable would not be shared between the
 * boot hook that starts the pull and the route that reports it.
 */

export type HermesImagePullStatus = "idle" | "pulling" | "ready" | "error";

export type HermesImagePullState = {
    status: HermesImagePullStatus;
    /** 0-100, never decreases during one pull. Absent until anything is known. */
    percent?: number;
    downloadedBytes?: number;
    /** Only set once every layer still to download has reported its size. */
    totalBytes?: number;
    error?: string;
};

/** One NDJSON record from Docker's `POST /images/create` stream. */
export type DockerPullRecord = {
    id?: string;
    status?: string;
    progressDetail?: { current?: number; total?: number };
    error?: string;
};

type LayerProgress = { current: number; total: number | null; done: boolean; cached: boolean };

/**
 * Folds Docker pull records into one progress figure. Layer sizes arrive only
 * when a layer starts downloading (Docker downloads a few at a time), so the
 * byte total is reported only once every layer has a size; until then percent
 * is the per-layer average, which does not jump backwards when a new large
 * layer appears.
 */
export class PullProgress {
    private layers = new Map<string, LayerProgress>();

    push(record: DockerPullRecord): void {
        const id = record.id;
        const status = record.status ?? "";
        // Records without a layer id ("Pulling from ...", "Digest: ...") carry no progress.
        if (!id || /^Pulling from /.test(status) || /^(Digest|Status):/.test(status)) return;
        const layer = this.layers.get(id) ?? { current: 0, total: null, done: false, cached: false };
        if (status === "Already exists") {
            layer.done = true;
            layer.cached = true;
        } else if (status === "Downloading") {
            const total = record.progressDetail?.total;
            const current = record.progressDetail?.current;
            if (typeof total === "number" && total > 0) layer.total = total;
            if (typeof current === "number" && current >= 0) layer.current = layer.total ? Math.min(current, layer.total) : current;
        } else if (/^(Download complete|Verifying Checksum|Extracting|Pull complete)$/.test(status)) {
            layer.done = true;
            if (layer.total) layer.current = layer.total;
        }
        this.layers.set(id, layer);
    }

    snapshot(): Pick<HermesImagePullState, "percent" | "downloadedBytes" | "totalBytes"> {
        const pending = [...this.layers.values()].filter((layer) => !layer.cached);
        if (pending.length === 0) return {};
        const downloadedBytes = pending.reduce((sum, layer) => sum + layer.current, 0);
        const allSized = pending.every((layer) => layer.total !== null);
        const totalBytes = allSized ? pending.reduce((sum, layer) => sum + (layer.total ?? 0), 0) : undefined;
        const fraction = totalBytes
            ? downloadedBytes / totalBytes
            : pending.reduce((sum, layer) => sum + (layer.done ? 1 : layer.total ? layer.current / layer.total : 0), 0) / pending.length;
        return {
            percent: Math.max(0, Math.min(100, Math.floor(fraction * 100))),
            downloadedBytes,
            ...(totalBytes ? { totalBytes } : {}),
        };
    }
}

export type PullFn = (image: string, platform: string | undefined, onRecord: (record: DockerPullRecord) => void) => Promise<string>;

type ImageEntry = { state: HermesImagePullState; inflight: Promise<string> | null };
type Registry = { images: Map<string, ImageEntry> };

const GLOBAL_KEY = "__emperorHermesImagePrefetch";

function registry(): Registry {
    const holder = globalThis as unknown as Record<string, Registry | undefined>;
    if (!holder[GLOBAL_KEY]) holder[GLOBAL_KEY] = { images: new Map() };
    return holder[GLOBAL_KEY]!;
}

function entry(image: string): ImageEntry {
    const images = registry().images;
    let found = images.get(image);
    if (!found) {
        found = { state: { status: "idle" }, inflight: null };
        images.set(image, found);
    }
    return found;
}

export function getHermesImagePullState(image: string): HermesImagePullState {
    return { ...entry(image).state };
}

/** Marks an image already present locally, without pulling it. */
export function markHermesImageReady(image: string): void {
    const current = entry(image);
    if (!current.inflight) current.state = { status: "ready", percent: 100 };
}

/**
 * Pull `image`, or join the pull already running for it. The returned promise
 * settles with Docker's final status line, or rejects with the pull error. A
 * settled pull is not cached: the next call pulls again, which is how a newer
 * registry digest for the same tag is picked up (cheap once layers are local).
 */
export function pullHermesImage(image: string, platform: string | undefined, pull: PullFn): Promise<string> {
    const current = entry(image);
    if (current.inflight) return current.inflight;
    const progress = new PullProgress();
    current.state = { status: "pulling" };
    const run = (async () => {
        try {
            const message = await pull(image, platform, (record) => {
                progress.push(record);
                const snapshot = progress.snapshot();
                const next: HermesImagePullState = { status: "pulling", ...snapshot };
                if (snapshot.percent !== undefined) next.percent = Math.max(current.state.percent ?? 0, snapshot.percent);
                current.state = next;
            });
            current.state = { ...current.state, status: "ready", percent: 100, error: undefined };
            return message;
        } catch (err) {
            current.state = { ...current.state, status: "error", error: err instanceof Error ? err.message : String(err) };
            throw err;
        } finally {
            current.inflight = null;
        }
    })();
    current.inflight = run;
    return run;
}

export type PrefetchDeps = {
    image: string;
    platform?: string;
    pull: PullFn;
    imageExists: (image: string) => Promise<boolean>;
    log?: (message: string) => void;
};

/**
 * Boot-time prefetch: pull the image in the background when it is not already
 * local. Never throws; logs once on start, finish, and error.
 */
export async function prefetchHermesImage(deps: PrefetchDeps): Promise<void> {
    const log = deps.log ?? ((message: string) => console.log(`[hermes-prefetch] ${message}`));
    try {
        if (await deps.imageExists(deps.image)) {
            markHermesImageReady(deps.image);
            return;
        }
        log(`pulling ${deps.image} in the background`);
        const started = Date.now();
        await pullHermesImage(deps.image, deps.platform, deps.pull);
        log(`${deps.image} ready after ${Math.round((Date.now() - started) / 1000)}s`);
    } catch (err) {
        log(`pull of ${deps.image} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
}

/** Test hook: forget all pull state. */
export function resetHermesImagePrefetchForTests(): void {
    const holder = globalThis as unknown as Record<string, Registry | undefined>;
    delete holder[GLOBAL_KEY];
}
