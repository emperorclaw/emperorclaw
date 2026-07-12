import { StorageAdapter } from "./types";
import { BunnyStorageAdapter } from "./bunny";
import { LocalStorageAdapter } from "./local";

let cachedAdapter: StorageAdapter | null = null;

export function getStorageAdapter(): StorageAdapter {
    if (cachedAdapter) return cachedAdapter;

    // Default to "local" so a fresh install works with zero external services.
    // Deployments using Bunny CDN must set STORAGE_BACKEND=bunny explicitly.
    const backend = (process.env.STORAGE_BACKEND || "local").toLowerCase();

    if (backend === "bunny") {
        cachedAdapter = new BunnyStorageAdapter();
    } else if (backend === "local") {
        cachedAdapter = new LocalStorageAdapter();
    } else {
        throw new Error(`Unknown STORAGE_BACKEND: "${backend}". Supported: local, bunny`);
    }

    return cachedAdapter;
}

export const storageAdapter = getStorageAdapter();

/** Returns the active storage backend name (e.g. "bunny", "local"). */
export function getStorageProviderName(): string {
    return (process.env.STORAGE_BACKEND || "local").toLowerCase();
}
