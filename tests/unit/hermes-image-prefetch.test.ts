import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import {
    PullProgress,
    getHermesImagePullState,
    imageRetryDelayMs,
    prefetchHermesImage,
    pullHermesImage,
    resetHermesImagePrefetchForTests,
    type DockerPullRecord,
    type PullFn,
} from "../../src/lib/hermes-image-prefetch";
import { hermesImageProgressLabel } from "../../src/components/hermes-image-progress";

const IMAGE = "ghcr.io/emperorclaw/emperorclaw-hermes:v0.9.0";

beforeEach(() => resetHermesImagePrefetchForTests());

function deferredPull() {
    let emit: (record: DockerPullRecord) => void = () => {};
    let finish: (message: string) => void = () => {};
    let fail: (error: Error) => void = () => {};
    let calls = 0;
    const pull: PullFn = (_image, _platform, onRecord) => {
        calls += 1;
        emit = onRecord;
        return new Promise((resolve, reject) => { finish = resolve; fail = reject; });
    };
    return { pull, emit: (r: DockerPullRecord) => emit(r), finish: (m: string) => finish(m), fail: (e: Error) => fail(e), calls: () => calls };
}

test("concurrent callers share one pull and one result", async () => {
    const fake = deferredPull();
    const first = pullHermesImage(IMAGE, "linux/amd64", fake.pull);
    const second = pullHermesImage(IMAGE, "linux/amd64", fake.pull);
    assert.equal(first, second);
    assert.equal(fake.calls(), 1);
    assert.equal(getHermesImagePullState(IMAGE).status, "pulling");
    fake.finish("Downloaded newer image");
    assert.equal(await second, "Downloaded newer image");
    assert.deepEqual(getHermesImagePullState(IMAGE), { status: "ready", percent: 100, error: undefined });
});

test("a settled pull is not reused, so the next caller pulls again", async () => {
    const fake = deferredPull();
    const first = pullHermesImage(IMAGE, undefined, fake.pull);
    fake.finish("done");
    await first;
    void pullHermesImage(IMAGE, undefined, fake.pull);
    assert.equal(fake.calls(), 2);
});

test("a failed pull reports error to joiners and the status endpoint", async () => {
    const fake = deferredPull();
    const joined = pullHermesImage(IMAGE, undefined, fake.pull);
    fake.fail(new Error("Pull failed: HTTP 404 — manifest unknown"));
    await assert.rejects(joined, /manifest unknown/);
    const state = getHermesImagePullState(IMAGE);
    assert.equal(state.status, "error");
    assert.match(state.error ?? "", /manifest unknown/);
});

test("progress is byte-based: no percent until every downloading layer has a size", () => {
    const progress = new PullProgress();
    progress.push({ status: "Pulling from emperorclaw/emperorclaw-hermes", id: "v0.9.0" });
    progress.push({ status: "Already exists", id: "base" });
    progress.push({ status: "Pulling fs layer", id: "a" });
    progress.push({ status: "Pulling fs layer", id: "b" });
    progress.push({ status: "Downloading", id: "a", progressDetail: { current: 500, total: 1000 } });
    // Layer b has no size yet: no total and no percent (an indeterminate bar), bytes so far.
    assert.deepEqual(progress.snapshot(), { phase: "downloading", downloadedBytes: 500 });
    progress.push({ status: "Downloading", id: "b", progressDetail: { current: 1000, total: 3000 } });
    assert.deepEqual(progress.snapshot(), { phase: "downloading", percent: 37, downloadedBytes: 1500, totalBytes: 4000 });
    progress.push({ status: "Download complete", id: "a" });
    progress.push({ status: "Download complete", id: "b" });
    // Everything downloaded: the bar now measures unpacking, from zero.
    assert.deepEqual(progress.snapshot(), { phase: "extracting", percent: 0, downloadedBytes: 4000, totalBytes: 4000, extractedBytes: 0 });
    progress.push({ status: "Extracting", id: "a", progressDetail: { current: 1000, total: 1000 } });
    progress.push({ status: "Pull complete", id: "a" });
    progress.push({ status: "Extracting", id: "b", progressDetail: { current: 1500, total: 3000 } });
    assert.deepEqual(progress.snapshot(), { phase: "extracting", percent: 62, downloadedBytes: 4000, totalBytes: 4000, extractedBytes: 2500 });
    progress.push({ status: "Pull complete", id: "b" });
    assert.deepEqual(progress.snapshot(), { phase: "extracting", percent: 100, downloadedBytes: 4000, totalBytes: 4000, extractedBytes: 4000 });
});

test("small layers that finish without a size count as complete, not as 0% or 100% of the pull", () => {
    // The audit's case: many tiny layers done, one big layer at 0.25 of 1.46 GB. The old per-layer
    // average said 88%; bytes say 17%.
    const progress = new PullProgress();
    for (let i = 0; i < 12; i++) {
        progress.push({ status: "Pulling fs layer", id: `small${i}` });
        progress.push({ status: "Download complete", id: `small${i}` });
    }
    progress.push({ status: "Pulling fs layer", id: "big" });
    progress.push({ status: "Downloading", id: "big", progressDetail: { current: 250_000_000, total: 1_460_000_000 } });
    assert.deepEqual(progress.snapshot(), { phase: "downloading", percent: 17, downloadedBytes: 250_000_000, totalBytes: 1_460_000_000 });
});

test("a fully cached image reports no download progress", () => {
    const progress = new PullProgress();
    progress.push({ status: "Already exists", id: "a" });
    progress.push({ status: "Digest: sha256:abc" });
    assert.deepEqual(progress.snapshot(), {});
});

test("reported percent never moves backwards during one pull", async () => {
    const fake = deferredPull();
    const run = pullHermesImage(IMAGE, undefined, fake.pull);
    fake.emit({ status: "Pulling fs layer", id: "a" });
    fake.emit({ status: "Downloading", id: "a", progressDetail: { current: 900, total: 1000 } });
    assert.equal(getHermesImagePullState(IMAGE).percent, 90);
    // A bigger total (layer b reports its size) lowers the fraction; the reported value holds.
    fake.emit({ status: "Pulling fs layer", id: "b" });
    fake.emit({ status: "Downloading", id: "b", progressDetail: { current: 0, total: 1000 } });
    assert.equal(getHermesImagePullState(IMAGE).percent, 90);
    assert.equal(getHermesImagePullState(IMAGE).downloadedBytes, 900);
    // Unpacking is its own phase and starts its own bar.
    fake.emit({ status: "Download complete", id: "a" });
    fake.emit({ status: "Download complete", id: "b" });
    assert.equal(getHermesImagePullState(IMAGE).phase, "extracting");
    assert.equal(getHermesImagePullState(IMAGE).percent, 0);
    fake.finish("ok");
    await run;
});

test("boot prefetch skips images already local and never throws", async () => {
    const fake = deferredPull();
    const logs: string[] = [];
    await prefetchHermesImage({ image: IMAGE, pull: fake.pull, imageExists: async () => true, log: (m) => logs.push(m) });
    assert.equal(fake.calls(), 0);
    assert.equal(getHermesImagePullState(IMAGE).status, "ready");

    resetHermesImagePrefetchForTests();
    await prefetchHermesImage({
        image: IMAGE,
        pull: async () => { throw new Error("registry down"); },
        imageExists: async () => false,
        log: (m) => logs.push(m),
    });
    assert.equal(getHermesImagePullState(IMAGE).status, "error");
    assert.ok(logs.some((line) => /failed: registry down/.test(line)));

    resetHermesImagePrefetchForTests();
    await prefetchHermesImage({ image: IMAGE, pull: fake.pull, imageExists: async () => { throw new Error("socket gone"); }, log: (m) => logs.push(m) });
    assert.equal(fake.calls(), 0);
});

test("a hire during the boot prefetch joins it instead of pulling twice", async () => {
    const fake = deferredPull();
    const boot = prefetchHermesImage({ image: IMAGE, pull: fake.pull, imageExists: async () => false, log: () => {} });
    await new Promise((resolve) => setImmediate(resolve));
    const hire = pullHermesImage(IMAGE, "linux/amd64", fake.pull);
    assert.equal(fake.calls(), 1);
    fake.finish("Downloaded newer image");
    assert.equal(await hire, "Downloaded newer image");
    await boot;
});

test("progress label shows gigabytes of the total when known, else what has arrived", () => {
    assert.equal(hermesImageProgressLabel({ downloadedBytes: 250_000_000, totalBytes: 1_460_000_000 }), "Downloading the agent runtime (one time) — 0.25 of 1.46 GB");
    assert.equal(hermesImageProgressLabel({ downloadedBytes: 600_000_000 }), "Downloading the agent runtime (one time) — 600 MB so far");
    assert.equal(hermesImageProgressLabel({ downloadedBytes: 1_200_000_000 }), "Downloading the agent runtime (one time) — 1.20 GB so far");
    assert.equal(hermesImageProgressLabel({ phase: "extracting", extractedBytes: 700_000_000, totalBytes: 1_460_000_000 }), "Unpacking the agent runtime (one time) — 0.70 of 1.46 GB");
    assert.equal(hermesImageProgressLabel({}), "Downloading the agent runtime (one time)…");
});

test("prefetch reports whether the image is local afterwards", async () => {
    assert.equal(await prefetchHermesImage({ image: IMAGE, pull: async () => "ok", imageExists: async () => true, log: () => {} }), true);
    resetHermesImagePrefetchForTests();
    assert.equal(await prefetchHermesImage({
        image: IMAGE, pull: async () => { throw new Error("HTTP 404 not found"); }, imageExists: async () => false, log: () => {},
    }), false);
});

test("a missing runtime image is retried with backoff for about a day, then given up", () => {
    assert.equal(imageRetryDelayMs(0), null);
    assert.deepEqual([1, 2, 3, 4, 5, 6].map(imageRetryDelayMs), [5, 10, 20, 40, 60, 60].map((m) => m * 60_000));
    let total = 0;
    for (let attempt = 1; imageRetryDelayMs(attempt) !== null; attempt++) total += imageRetryDelayMs(attempt)!;
    assert.ok(total >= 24 * 3_600_000 && total <= 26 * 3_600_000, `retries span ${total / 3_600_000} h`);
});
