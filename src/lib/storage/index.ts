import { StorageAdapter } from "./types";
import { BunnyStorageAdapter } from "./bunny";

let cachedAdapter: StorageAdapter | null = null;

export function getStorageAdapter(): StorageAdapter {
    if (!cachedAdapter) {
        cachedAdapter = new BunnyStorageAdapter();
    }
    return cachedAdapter;
}

export const storageAdapter = getStorageAdapter();
