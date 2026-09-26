import fs from "fs";
import http from "http";
import { parseDockerPullResponse } from "./docker-pull-response";

// ---- Docker Engine API over Unix socket ----
// Shared primitives for talking to the Docker daemon from inside a sibling
// container (the app container has /var/run/docker.sock mounted). Extracted
// from src/app/api/ops/update/route.ts so both the self-update flow and the
// Hermes sibling-container provisioning flow share one implementation.

export const DOCKER_SOCKET = "/var/run/docker.sock";

// The Hermes runtime image is ~2.8 GB. A 5-minute ceiling made the first-ever
// hire fail on ordinary connections — the pull timed out mid-download, leaving
// a half-created, permanently "offline" agent behind, while a second attempt
// succeeded instantly from the now-cached layers. 30 minutes is the ceiling for
// that one-time download, not the steady-state cost.
const IMAGE_PULL_TIMEOUT_MS = 30 * 60 * 1000;

export function isDocker(): boolean {
    try { return fs.existsSync("/.dockerenv"); } catch { return false; }
}

export function dockerCall(method: string, path: string, body?: unknown): Promise<{ code: number; data: unknown }> {
    return new Promise((resolve, reject) => {
        const opts: http.RequestOptions = {
            socketPath: DOCKER_SOCKET,
            method,
            path,
            headers: { "Content-Type": "application/json" },
            // A first container creation can unpack a large runtime image.
            timeout: method === "POST" && path.includes("/images/create") ? IMAGE_PULL_TIMEOUT_MS
                : method === "POST" && path.startsWith("/containers/create") ? 300_000
                : 30_000,
        };
        if (method === "POST" && path.includes("/images/create")) {
            (opts as Record<string, unknown>).agent = false;
        }
        const req = http.request(opts, (res) => {
            const chunks: Buffer[] = [];
            res.on("data", (c: Buffer) => chunks.push(c));
            res.on("end", () => {
                const raw = Buffer.concat(chunks).toString("utf-8");
                try { resolve({ code: res.statusCode ?? 500, data: JSON.parse(raw) }); }
                catch { resolve({ code: res.statusCode ?? 500, data: raw }); }
            });
            res.on("error", reject);
        });
        req.on("error", reject);
        req.on("timeout", () => req.destroy(new Error("Docker request timed out")));
        if (body !== undefined) req.write(JSON.stringify(body));
        req.end();
    });
}

export async function dockerPull(image: string, platform?: string): Promise<string> {
    return new Promise((resolve, reject) => {
        const req = http.request({
            socketPath: DOCKER_SOCKET,
            method: "POST",
            path: `/images/create?fromImage=${encodeURIComponent(image)}${platform ? `&platform=${encodeURIComponent(platform)}` : ""}`,
            timeout: IMAGE_PULL_TIMEOUT_MS,
            agent: false,
        }, (res) => {
            const chunks: Buffer[] = [];
            res.on("data", (c: Buffer) => chunks.push(c));
            res.on("end", () => {
                try {
                    resolve(parseDockerPullResponse(res.statusCode ?? 500, Buffer.concat(chunks).toString("utf-8")));
                } catch (error) { reject(error); }
            });
            res.on("error", reject);
        });
        req.on("error", reject);
        req.on("timeout", () => req.destroy(new Error("Docker request timed out")));
        req.end();
    });
}

export async function imageExists(image: string): Promise<boolean> {
    const { code } = await dockerCall("GET", `/images/${encodeURIComponent(image)}/json`);
    return code === 200;
}

export async function getOwnContainerId(): Promise<string> {
    try {
        const cgroup = fs.readFileSync("/proc/self/cgroup", "utf-8");
        const match = cgroup.match(/[0-9a-f]{64}/);
        if (match) return match[0];
    } catch { /* fall through */ }
    try {
        const h = fs.readFileSync("/etc/hostname", "utf-8").trim();
        if (h.length === 12) return h;
    } catch { /* fall through */ }
    throw new Error("Cannot determine container ID");
}

export async function inspectContainer(id: string): Promise<Record<string, unknown>> {
    const { code, data } = await dockerCall("GET", `/containers/${id}/json`);
    if (code !== 200) {
        throw new Error(`inspectContainer HTTP ${code}: ${JSON.stringify(data).slice(0, 200)}`);
    }
    return data as Record<string, unknown>;
}

export type ContainerMount = {
    type: "volume" | "bind";
    source: string;
    target: string;
    readOnly?: boolean;
};

export type CreateContainerOpts = {
    image: string;
    name: string;
    env: string[];
    networkMode: string;
    restartPolicy?: { Name: string };
    labels?: Record<string, string>;
    memoryBytes?: number;
    nanoCpus?: number;
    mounts?: ContainerMount[];
};

export async function createContainer(opts: CreateContainerOpts): Promise<string> {
    const createBody = {
        Image: opts.image,
        Env: opts.env,
        Labels: opts.labels,
        HostConfig: {
            RestartPolicy: opts.restartPolicy,
            NetworkMode: opts.networkMode,
            Memory: opts.memoryBytes,
            NanoCpus: opts.nanoCpus,
            Mounts: opts.mounts?.map((mount) => ({
                Type: mount.type,
                Source: mount.source,
                Target: mount.target,
                ReadOnly: mount.readOnly ?? false,
            })),
        },
    };
    const { code, data } = await dockerCall(
        "POST",
        `/containers/create?name=${encodeURIComponent(opts.name)}`,
        createBody,
    );
    if (code !== 201) {
        throw new Error(`createContainer HTTP ${code}: ${JSON.stringify(data).slice(0, 200)}`);
    }
    return (data as { Id: string }).Id;
}

/**
 * Ensure a named Docker volume exists. Idempotent: Docker returns 409 when
 * the name is already taken, which we treat as success (we only need the
 * volume to exist). Named volumes survive container removal, which is what
 * lets a Hermes agent's profile/session/bridge state persist across
 * recreate-runtime and image updates.
 */
export async function dockerVolumeCreate(name: string): Promise<void> {
    const { code, data } = await dockerCall("POST", "/volumes/create", { Name: name });
    if (code !== 201 && code !== 200 && code !== 409) {
        throw new Error(`dockerVolumeCreate HTTP ${code}: ${JSON.stringify(data).slice(0, 200)}`);
    }
}

/**
 * Remove a named Docker volume. Idempotent: a 404 (already gone) is success.
 * Used when an agent is deleted so its Hermes profile/session/bridge state does
 * not linger as an orphan volume. `force` lets Docker remove a volume that a
 * stale container still references.
 */
export async function dockerVolumeRemove(name: string, force = true): Promise<void> {
    const { code, data } = await dockerCall("DELETE", `/volumes/${encodeURIComponent(name)}?force=${force}`);
    if (code !== 204 && code !== 404) {
        throw new Error(`dockerVolumeRemove HTTP ${code}: ${JSON.stringify(data).slice(0, 200)}`);
    }
}

export async function startContainer(id: string): Promise<void> {
    const { code, data } = await dockerCall("POST", `/containers/${id}/start`);
    if (code !== 204 && code !== 304) {
        throw new Error(`startContainer HTTP ${code}: ${JSON.stringify(data).slice(0, 200)}`);
    }
}

export async function stopContainer(id: string, timeoutSec = 10): Promise<void> {
    const { code, data } = await dockerCall("POST", `/containers/${id}/stop?t=${timeoutSec}`);
    if (code !== 204 && code !== 304) {
        throw new Error(`stopContainer HTTP ${code}: ${JSON.stringify(data).slice(0, 200)}`);
    }
}

export async function removeContainer(id: string, force = true): Promise<void> {
    const { code, data } = await dockerCall("DELETE", `/containers/${id}?force=${force}`);
    if (code !== 204 && code !== 404) {
        throw new Error(`removeContainer HTTP ${code}: ${JSON.stringify(data).slice(0, 200)}`);
    }
}

export type OwnNetworkAndAppHostname = {
    networkMode: string;
    appHostname: string;
    appPort: number;
};

/**
 * Mirrors the network-detection logic already used in dockerUpdateSelf():
 * inspect our own container, pull the first Docker network name (falling
 * back to "bridge"), and derive our own container name (stripping the
 * leading "/" Docker prefixes names with) to use as the hostname other
 * sibling containers reach us on.
 */
export async function getOwnNetworkAndAppHostname(): Promise<OwnNetworkAndAppHostname> {
    const ownId = await getOwnContainerId();
    const info = await inspectContainer(ownId);
    const ns = (info.NetworkSettings ?? {}) as Record<string, unknown>;
    const nets = (ns.Networks ?? {}) as Record<string, unknown>;
    const netNames = Object.keys(nets);
    const networkMode = netNames[0] ?? "bridge";
    const appHostname = ((info.Name as string) ?? "").replace(/^\//, "");
    return { networkMode, appHostname, appPort: 3000 };
}
