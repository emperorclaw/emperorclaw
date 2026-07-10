import { createHash } from "crypto";
import type {
    StorageAdapter,
    StorageDeleteParams,
    StorageDownloadParams,
    StorageDownloadResult,
    StorageStatResult,
    StorageUploadParams,
    StorageUploadResult,
} from "./types";
import { sanitizeLogicalPath } from "./path-sanitizer";
import { optionalEnv, requireEnv } from "../env";

const REGION_HOSTS: Record<string, string> = {
    frankfurt: "storage.bunnycdn.com",
    germany: "storage.bunnycdn.com",
    de: "storage.bunnycdn.com",
    europe: "storage.bunnycdn.com",
    london: "uk.storage.bunnycdn.com",
    uk: "uk.storage.bunnycdn.com",
    "united kingdom": "uk.storage.bunnycdn.com",
    "new york": "ny.storage.bunnycdn.com",
    ny: "ny.storage.bunnycdn.com",
    usa: "ny.storage.bunnycdn.com",
    "us east": "ny.storage.bunnycdn.com",
    "los angeles": "la.storage.bunnycdn.com",
    la: "la.storage.bunnycdn.com",
    "los angeles, us": "la.storage.bunnycdn.com",
    losangeles: "la.storage.bunnycdn.com",
    singapore: "sg.storage.bunnycdn.com",
    sg: "sg.storage.bunnycdn.com",
    stockholm: "se.storage.bunnycdn.com",
    se: "se.storage.bunnycdn.com",
    sweden: "se.storage.bunnycdn.com",
    "são paulo": "br.storage.bunnycdn.com",
    "sao paulo": "br.storage.bunnycdn.com",
    brazil: "br.storage.bunnycdn.com",
    "south africa": "jh.storage.bunnycdn.com",
    johannesburg: "jh.storage.bunnycdn.com",
    "johannesburg, sa": "jh.storage.bunnycdn.com",
    syd: "syd.storage.bunnycdn.com",
    sydney: "syd.storage.bunnycdn.com",
};

const DEFAULT_CONTENT_TYPE = "application/octet-stream";

export interface BunnyStorageConfig {
    zoneName: string;
    accessKey: string;
    host: string;
    protocol: "https" | "http";
    pullZoneBase?: string;
}

export class BunnyStorageAdapter implements StorageAdapter {
    private readonly config: BunnyStorageConfig;

    constructor(config: Partial<BunnyStorageConfig> = {}) {
        const zoneName = config.zoneName ?? requireEnv("BUNNY_STORAGE_ZONE");
        const accessKey = config.accessKey ?? requireEnv("BUNNY_STORAGE_ACCESS_KEY");
        const hostSource =
            config.host ?? optionalEnv("BUNNY_STORAGE_HOST") ?? optionalEnv("BUNNY_STORAGE_REGION");
        const host = resolveHost(hostSource);
        const protocol = config.protocol ?? "https";
        const pullZoneBase = config.pullZoneBase ?? optionalEnv("BUNNY_STORAGE_PULL_ZONE_URL");
        this.config = {
            zoneName,
            accessKey,
            host,
            protocol: protocol === "http" ? "http" : "https",
            pullZoneBase: pullZoneBase ? normalizeBaseUrl(pullZoneBase) : undefined,
        };
    }

    buildStorageKey(companyId: string, logicalPath: string): string {
        const normalizedPath = this.normalizeLogicalPath(logicalPath);
        return `companies/${companyId}/artifacts/${normalizedPath}`;
    }

    getDownloadUrl(params: StorageDownloadParams): string {
        const storageKey = this.buildStorageKey(params.companyId, params.logicalPath);
        if (this.config.pullZoneBase) {
            return this.joinWithBase(this.config.pullZoneBase, storageKey);
        }
        return this.buildObjectUrl(storageKey);
    }

    async upload(params: StorageUploadParams): Promise<StorageUploadResult> {
        const storageKey = this.buildStorageKey(params.companyId, params.logicalPath);
        const url = this.buildObjectUrl(storageKey);
        const buffer = Buffer.from(params.data);
        const checksum = (params.checksum || this.computeChecksum(buffer)).toUpperCase();
        const headers = new Headers({
            AccessKey: this.config.accessKey,
            "Content-Type": params.contentType?.trim() || DEFAULT_CONTENT_TYPE,
            Checksum: checksum,
        });

        const response = await fetch(url, {
            method: "PUT",
            headers,
            body: buffer,
        });

        await this.ensureSuccess(response, "upload");

        return {
            storageKey,
            storageUrl: url,
            sizeBytes: buffer.length,
            contentType: headers.get("Content-Type") ?? DEFAULT_CONTENT_TYPE,
            checksum,
        };
    }

    async delete(params: StorageDeleteParams): Promise<void> {
        const storageKey = this.buildStorageKey(params.companyId, params.logicalPath);
        const response = await fetch(this.buildObjectUrl(storageKey), {
            method: "DELETE",
            headers: {
                AccessKey: this.config.accessKey,
            },
        });
        await this.ensureSuccess(response, "delete");
    }

    async download(params: StorageDownloadParams): Promise<StorageDownloadResult> {
        const storageKey = this.buildStorageKey(params.companyId, params.logicalPath);
        const response = await fetch(this.buildObjectUrl(storageKey), {
            method: "GET",
            headers: {
                AccessKey: this.config.accessKey,
            },
        });

        await this.ensureSuccess(response, "download");

        const arrayBuffer = await response.arrayBuffer();
        const buffer = Buffer.from(arrayBuffer);
        return {
            buffer,
            contentType: response.headers.get("Content-Type") ?? undefined,
            sizeBytes: buffer.length,
        };
    }

    async stat(params: StorageDownloadParams): Promise<StorageStatResult> {
        const storageKey = this.buildStorageKey(params.companyId, params.logicalPath);
        const response = await fetch(this.buildObjectUrl(storageKey), {
            method: "HEAD",
            headers: {
                AccessKey: this.config.accessKey,
            },
        });

        await this.ensureSuccess(response, "stat");

        const contentLength = response.headers.get("Content-Length");
        const parsedLength = contentLength ? Number.parseInt(contentLength, 10) : NaN;

        return {
            contentType: response.headers.get("Content-Type") ?? undefined,
            sizeBytes: Number.isFinite(parsedLength) && parsedLength >= 0 ? parsedLength : 0,
        };
    }

    private buildObjectUrl(storageKey: string): string {
        return `${this.config.protocol}://${this.config.host}/${this.config.zoneName}/${storageKey}`;
    }

    private normalizeLogicalPath(logicalPath: string): string {
        return sanitizeLogicalPath(logicalPath);
    }

    private joinWithBase(base: string, storageKey: string): string {
        const trimmedBase = base.endsWith("/") ? base.slice(0, -1) : base;
        const merged = `${trimmedBase}/${storageKey}`;
        return merged.replace(/([^:]\/)\/+/g, "$1");
    }

    private computeChecksum(buffer: Buffer): string {
        return createHash("sha256").update(buffer).digest("hex");
    }

    private async ensureSuccess(response: Response, action: string): Promise<void> {
        if (response.ok) {
            return;
        }
        const body = await response.text().catch(() => "");
        throw new Error(
            `Bunny storage ${action} failed (${response.status} ${response.statusText}): ${body || "no message"}`
        );
    }
}

function resolveHost(candidate?: string): string {
    if (!candidate) {
        return "storage.bunnycdn.com";
    }
    const trimmed = candidate.trim().toLowerCase();
    if (trimmed in REGION_HOSTS) {
        return REGION_HOSTS[trimmed];
    }
    if (trimmed.startsWith("https://") || trimmed.startsWith("http://")) {
        return trimmed.replace(/^https?:\/\//, "").replace(/\/+$/, "");
    }
    return trimmed.replace(/\/+$/, "");
}

function normalizeBaseUrl(base: string): string {
    const trimmed = base.trim();
    if (!trimmed) {
        throw new Error("pull zone base URL cannot be empty");
    }
    return trimmed;
}
