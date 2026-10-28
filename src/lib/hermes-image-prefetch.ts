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
    /** Downloading layers, then unpacking them (Docker extracts after the download). */
    phase?: "downloading" | "extracting";
    /** 0-100 of the current phase, never decreasing within it. Absent while the total is unknown. */
    percent?: number;
    downloadedBytes?: number;
    /** Set once every layer still downloading has reported its size. */
    totalBytes?: number;
    /** While extracting: bytes unpacked so far, of totalBytes. */
    extractedBytes?: number;
    error?: string;
};

/** One NDJSON record from Docker's `POST /images/create` stream. */
export type DockerPullRecord = {
    id?: string;
    status?: string;
    progressDetail?: { current?: number; total?: number };
    error?: string;
};

type LayerProgress = { current: number; total: number | null; downloaded: boolean; extracted: number; complete: boolean; cached: boolean };

/**
 * Folds Docker pull records into one byte-based progress figure. Layer sizes
 * arrive only when a layer starts downloading (Docker downloads a few at a
 * time), so the byte total is known once every layer still downloading has a
 * size; until then there is no percent (the bar is indeterminate) and the
 * downloaded bytes are shown instead. A layer that finished without ever
 * reporting a size (small layers jump straight to "Download complete") counts
 * as complete. Once everything is downloaded the phase becomes extracting,
 * measured the same way, instead of sitting at 95-100% while Docker unpacks.
 */
export class PullProgress {
    private layers = new Map<string, LayerProgress>();

    push(record: DockerPullRecord): void {
        const id = record.id;
        const status = record.status ?? "";
        // Records without a layer id ("Pulling from ...", "Digest: ...") carry no progress.
        if (!id || /^Pulling from /.test(status) || /^(Digest|Status):/.test(status)) return;
        const layer = this.layers.get(id) ?? { current: 0, total: null, downloaded: false, extracted: 0, complete: false, cached: false };
        const detailTotal = record.progressDetail?.total;
        const detailCurrent = record.progressDetail?.current;
        if (status === "Already exists") {
            layer.cached = true;
        } else if (status === "Downloading") {
            if (typeof detailTotal === "number" && detailTotal > 0) layer.total = detailTotal;
            if (typeof detailCurrent === "number" && detailCurrent >= 0) layer.current = layer.total ? Math.min(detailCurrent, layer.total) : detailCurrent;
        } else if (status === "Verifying Checksum" || status === "Download complete") {
            layer.downloaded = true;
            if (layer.total) layer.current = layer.total;
        } else if (status === "Extracting") {
            layer.downloaded = true;
            if (layer.total === null && typeof detailTotal === "number" && detailTotal > 0) layer.total = detailTotal;
            if (layer.total) layer.current = layer.total;
            if (typeof detailCurrent === "number" && detailCurrent >= 0) layer.extracted = layer.total ? Math.min(detailCurrent, layer.total) : detailCurrent;
        } else if (status === "Pull complete") {
            layer.downloaded = true;
            layer.complete = true;
            if (layer.total) layer.current = layer.extracted = layer.total;
        }
        this.layers.set(id, layer);
    }

    snapshot(): Pick<HermesImagePullState, "phase" | "percent" | "downloadedBytes" | "totalBytes" | "extractedBytes"> {
        const pending = [...this.layers.values()].filter((layer) => !layer.cached);
        if (pending.length === 0) return {};
        const size = (layer: LayerProgress) => layer.total ?? layer.current;
        const downloadedBytes = pending.reduce((sum, layer) => sum + (layer.downloaded ? size(layer) : layer.current), 0);
        const sizeKnown = pending.every((layer) => layer.downloaded || layer.total !== null);
        const totalBytes = sizeKnown ? pending.reduce((sum, layer) => sum + size(layer), 0) : undefined;
        const pct = (part: number, whole: number) => Math.max(0, Math.min(100, Math.floor((part / whole) * 100)));
        if (pending.some((layer) => !layer.downloaded)) {
            return { phase: "downloading", downloadedBytes, ...(totalBytes ? { totalBytes, percent: pct(downloadedBytes, totalBytes) } : {}) };
        }
        const extractedBytes = pending.reduce((sum, layer) => sum + (layer.complete ? size(layer) : layer.extracted), 0);
        return { phase: "extracting", downloadedBytes, extractedBytes, ...(totalBytes ? { totalBytes, percent: pct(extractedBytes, totalBytes) } : {}) };
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
    let best: { phase: HermesImagePullState["phase"]; percent: number } = { phase: undefined, percent: 0 };
    current.state = { status: "pulling" };
    const run = (async () => {
        try {
            const message = await pull(image, platform, (record) => {
                progress.push(record);
                const snapshot = progress.snapshot();
                const next: HermesImagePullState = { status: "pulling", ...snapshot };
                // Never backwards within a phase (a late layer size grows the total); unpacking starts its own bar.
                if (snapshot.phase !== best.phase) best = { phase: snapshot.phase, percent: 0 };
                if (snapshot.percent !== undefined) next.percent = best.percent = Math.max(best.percent, snapshot.percent);
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

/**
 * Delay before the next attempt when this release's runtime image is not
 * available yet. On a release the app image is published before the Hermes
 * image (which waits on the bridge contract), so an auto-updated server boots
 * first and has to come back for the runtime: 5, 10, 20, 40 then every 60
 * minutes, for up to a day. Returns null once it should stop.
 */
export function imageRetryDelayMs(attempt: number): number | null {
    if (attempt < 1 || attempt > 27) return null;
    return Math.min(5 * 2 ** (attempt - 1), 60) * 60_000;
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
 * local. Never throws; logs once on start, finish, and error. Resolves true
 * when the image is local afterwards, so the caller can retry later.
 */
export async function prefetchHermesImage(deps: PrefetchDeps): Promise<boolean> {
    const log = deps.log ?? ((message: string) => console.log(`[hermes-prefetch] ${message}`));
    try {
        if (await deps.imageExists(deps.image)) {
            markHermesImageReady(deps.image);
            return true;
        }
        log(`pulling ${deps.image} in the background`);
        const started = Date.now();
        await pullHermesImage(deps.image, deps.platform, deps.pull);
        log(`${deps.image} ready after ${Math.round((Date.now() - started) / 1000)}s`);
        return true;
    } catch (err) {
        log(`pull of ${deps.image} failed: ${err instanceof Error ? err.message : String(err)}`);
        return false;
    }
}

/** Test hook: forget all pull state. */
export function resetHermesImagePrefetchForTests(): void {
    const holder = globalThis as unknown as Record<string, Registry | undefined>;
    delete holder[GLOBAL_KEY];
}
