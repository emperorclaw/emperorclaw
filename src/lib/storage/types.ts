export interface StorageUploadParams {
    companyId: string;
    logicalPath: string;
    data: Buffer | Uint8Array;
    contentType?: string;
    checksum?: string;
}

export interface StorageUploadResult {
    storageKey: string;
    storageUrl: string;
    sizeBytes: number;
    contentType: string;
    checksum: string;
}

export interface StorageDeleteParams {
    companyId: string;
    logicalPath: string;
}

export interface StorageDownloadParams {
    companyId: string;
    logicalPath: string;
}

export interface StorageDownloadResult {
    buffer: Buffer;
    contentType?: string;
    sizeBytes: number;
}

export interface StorageStatResult {
    contentType?: string;
    sizeBytes: number;
}

export interface StorageAdapter {
    upload(params: StorageUploadParams): Promise<StorageUploadResult>;
    delete(params: StorageDeleteParams): Promise<void>;
    download(params: StorageDownloadParams): Promise<StorageDownloadResult>;
    stat(params: StorageDownloadParams): Promise<StorageStatResult>;
    getDownloadUrl(params: StorageDownloadParams): string;
    buildStorageKey(companyId: string, logicalPath: string): string;
}
