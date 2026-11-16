/**
 * Paste-to-attach for the chat composers: pulls image files out of a
 * clipboard paste so they go through the same /api/chat/attachments upload
 * as files picked with the attach button.
 */

/** The minimal slice of DataTransfer we read; keeps this testable without a DOM. */
export interface ClipboardLike {
    items?: ArrayLike<{ kind: string; type: string; getAsFile(): File | null }> | null;
    files?: ArrayLike<File> | null;
    getData?(format: string): string;
}

const EXTENSION_BY_TYPE: Record<string, string> = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/gif": "gif",
    "image/webp": "webp",
    "image/bmp": "bmp",
    "image/svg+xml": "svg",
    "image/avif": "avif",
    "image/heic": "heic",
    "image/tiff": "tiff",
};

/**
 * Browsers name clipboard screenshots generically ("image.png" in Chrome,
 * empty in some others). Those get a unique, timestamped name instead so
 * several pasted screenshots stay distinguishable in "My uploads".
 */
function needsGeneratedName(name: string): boolean {
    return !name.trim() || /^image\.[a-z0-9]+$/i.test(name.trim());
}

function timestamp(now: Date): string {
    const pad = (n: number, width = 2) => String(n).padStart(width, "0");
    return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

export function pastedImageName(contentType: string, now: Date, index: number, total: number): string {
    const ext = EXTENSION_BY_TYPE[contentType.toLowerCase()] ?? "png";
    const suffix = total > 1 ? `-${index + 1}` : "";
    return `pasted-image-${timestamp(now)}${suffix}.${ext}`;
}

/**
 * Image files carried by a paste, renamed when the browser gave them no
 * meaningful name. Returns [] for a text paste, so the caller can let the
 * browser handle it normally. Office apps (Excel, Word, PowerPoint) put a
 * bitmap rendition next to the text of copied cells or paragraphs; when
 * there is real text the person meant the text, so it wins.
 */
export function imageFilesFromClipboard(data: ClipboardLike | null | undefined, now: Date = new Date()): File[] {
    if (!data) return [];
    if (data.getData?.("text/plain")?.trim()) return [];
    let images: File[] = [];
    for (const item of Array.from(data.items ?? [])) {
        if (item.kind !== "file" || !item.type.startsWith("image/")) continue;
        const file = item.getAsFile();
        if (file) images.push(file);
    }
    // Some browsers only expose pasted files through `files`.
    if (images.length === 0) {
        images = Array.from(data.files ?? []).filter((file) => file.type.startsWith("image/"));
    }
    const total = images.length;
    return images.map((file, index) =>
        needsGeneratedName(file.name)
            ? new File([file], pastedImageName(file.type, now, index, total), { type: file.type, lastModified: file.lastModified })
            : file
    );
}
