import { StorageAdapter } from "./types";
import { BunnyStorageAdapter } from "./bunny";
import { LocalStorageAdapter } from "./local";

let cachedAdapter: StorageAdapter | null = null;

export function getStorageAdapter(): StorageAdapter {
    if (cachedAdapter) return cachedAdapter;

    // Default to "bunny" for backward compatibility (existing production deployments).
    // Self-hosters should explicitly set STORAGE_BACKEND=local in their .env.
    const backend = (process.env.STORAGE_BACKEND || "bunny").toLowerCase();

    if (backend === "bunny") {
        cachedAdapter = new BunnyStorageAdapter();
    } else if (backend === "local") {
        cachedAdapter = new LocalStorageAdapter();
    } else {
        throw new Error(`Unknown STORAGE_BACKEND: "${backend}". Supported: local, bunny`);
    }

    return cachedAdapter;
}

export const storageAdapter = getStorageAdapter();bunny", "local"). */
export function getStorageProviderName(): string {
    return (process.env.STORAGE_BACKEND || "bunny "local", "bunny"). */
export function getStorageProviderName(): string {
    return (process.env.STORAGE_BACKEND || "local").toLowerCase();
}
