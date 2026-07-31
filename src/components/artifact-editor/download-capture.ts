const CAPTURE_URL_PREFIX = "blob:emperor-office-save-";

/**
 * Extend's public Office export APIs intentionally download a file. Emperor
 * needs those exact exported bytes so it can replace the existing artifact.
 * The packages are pinned, and this small adapter captures that one download
 * without allowing a second browser download to start.
 */
export function captureExportedBlob(
    exportFile: () => void,
    expectedType: string,
    timeoutMs = 20_000,
): Promise<Blob> {
    return new Promise((resolve, reject) => {
        const originalCreateObjectURL = URL.createObjectURL.bind(URL);
        const originalClick = HTMLAnchorElement.prototype.click;
        let settled = false;

        const restore = () => {
            URL.createObjectURL = originalCreateObjectURL;
            HTMLAnchorElement.prototype.click = originalClick;
            window.clearTimeout(timeoutId);
        };

        const finish = (blob: Blob) => {
            if (settled) return;
            settled = true;
            restore();
            resolve(blob);
        };

        URL.createObjectURL = ((value: Blob | MediaSource) => {
            if (value instanceof Blob && (!expectedType || value.type === expectedType)) {
                const captureUrl = `${CAPTURE_URL_PREFIX}${crypto.randomUUID()}`;
                window.queueMicrotask(() => finish(value));
                return captureUrl;
            }
            return originalCreateObjectURL(value);
        }) as typeof URL.createObjectURL;

        HTMLAnchorElement.prototype.click = function click() {
            if (this.href.startsWith(CAPTURE_URL_PREFIX)) return;
            return originalClick.call(this);
        };

        const timeoutId = window.setTimeout(() => {
            if (settled) return;
            settled = true;
            restore();
            reject(new Error("The editor did not finish exporting the file. Please try again."));
        }, timeoutMs);

        try {
            exportFile();
        } catch (error) {
            settled = true;
            restore();
            reject(error);
        }
    });
}
