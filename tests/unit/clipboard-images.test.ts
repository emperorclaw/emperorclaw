import { test } from "node:test";
import assert from "node:assert/strict";
import { imageFilesFromClipboard, pastedImageName } from "../../src/lib/clipboard-images";

const now = new Date(2026, 10, 16, 9, 5, 7);
const fileItem = (file: File) => ({ kind: "file", type: file.type, getAsFile: () => file });
const stringItem = (type: string) => ({ kind: "string", type, getAsFile: () => null });

test("a plain-text paste yields no files, so the browser keeps handling it", () => {
    assert.deepEqual(imageFilesFromClipboard({ items: [stringItem("text/plain"), stringItem("text/html")], files: [] }, now), []);
    assert.deepEqual(imageFilesFromClipboard(null, now), []);
});

test("a nameless screenshot gets a timestamped name and keeps its bytes and type", async () => {
    const shot = new File([new Uint8Array([1, 2, 3])], "image.png", { type: "image/png" });
    const [file] = imageFilesFromClipboard({ items: [fileItem(shot)] }, now);
    assert.equal(file.name, "pasted-image-20261116-090507.png");
    assert.equal(file.type, "image/png");
    assert.deepEqual(new Uint8Array(await file.arrayBuffer()), new Uint8Array([1, 2, 3]));
});

test("several images in one paste each become an attachment with a distinct name", () => {
    const a = new File(["a"], "", { type: "image/png" });
    const b = new File(["b"], "", { type: "image/jpeg" });
    const files = imageFilesFromClipboard({ items: [fileItem(a), stringItem("text/html"), fileItem(b)] }, now);
    assert.deepEqual(files.map((f) => f.name), ["pasted-image-20261116-090507-1.png", "pasted-image-20261116-090507-2.jpg"]);
});

test("a copied image file keeps its real name; non-image files are ignored", () => {
    const photo = new File(["p"], "holiday.jpg", { type: "image/jpeg" });
    const pdf = new File(["d"], "report.pdf", { type: "application/pdf" });
    const files = imageFilesFromClipboard({ items: [fileItem(photo), fileItem(pdf)] }, now);
    assert.deepEqual(files.map((f) => f.name), ["holiday.jpg"]);
});

test("falls back to clipboard.files when items carry nothing", () => {
    const shot = new File(["s"], "", { type: "image/webp" });
    const files = imageFilesFromClipboard({ items: [], files: [shot] }, now);
    assert.deepEqual(files.map((f) => f.name), ["pasted-image-20261116-090507.webp"]);
});

test("text copied from Office comes with a bitmap; the text wins", () => {
    const bitmap = new File(["x"], "image.png", { type: "image/png" });
    const getData = (format: string) => (format === "text/plain" ? "Q3\t1200\n" : "");
    assert.deepEqual(imageFilesFromClipboard({ items: [stringItem("text/plain"), fileItem(bitmap)], getData }, now), []);
});

test("a browser 'Copy image' (image plus <img> HTML, no plain text) still attaches", () => {
    const img = new File(["x"], "image.png", { type: "image/png" });
    const getData = (format: string) => (format === "text/html" ? '<img src="https://example.com/a.png">' : "");
    assert.equal(imageFilesFromClipboard({ items: [stringItem("text/html"), fileItem(img)], getData }, now).length, 1);
});

test("unknown image types fall back to .png", () => {
    assert.equal(pastedImageName("image/x-weird", now, 0, 1), "pasted-image-20261116-090507.png");
});
