"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { DocxEditorViewer, useDocxEditor } from "@extend-ai/react-docx";
import { unzipSync, zipSync } from "fflate";
import {
    IconAlignCenter,
    IconAlignJustified,
    IconAlignLeft,
    IconAlignRight,
    IconArrowBackUp,
    IconArrowForwardUp,
    IconBold,
    IconHighlight,
    IconItalic,
    IconList,
    IconListNumbers,
    IconMinus,
    IconPhotoPlus,
    IconPlus,
    IconTablePlus,
    IconUnderline,
} from "@tabler/icons-react";
import { Button } from "@/components/ui/button";
import { captureExportedBlob } from "./download-capture";
import type { OfficeEditorProps } from "./types";

const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const ZOOM_LEVELS = [60, 75, 90, 100, 110, 125, 150, 175, 200];

export default function DocxArtifactEditor(props: OfficeEditorProps) {
    const { bytes, fileName, onDirtyChange, onHandleChange } = props;
    const editor = useDocxEditor({ initialDocumentTheme: "light", initialFileName: fileName });
    const stableFile = useMemo(() => new File([bytes.slice(0)], fileName, { type: DOCX_MIME }), [bytes, fileName]);
    const baselineModelRef = useRef(editor.model);
    const hasImportedRef = useRef(false);
    const imageInputRef = useRef<HTMLInputElement | null>(null);
    const [importReady, setImportReady] = useState(false);
    const [zoom, setZoom] = useState(100);

    useEffect(() => {
        let active = true;
        void editor.importDocxFile(stableFile).then(() => {
            if (!active) return;
            setImportReady(true);
        });
        return () => { active = false; };
        // The controller is intentionally stable; importing again would reset edits.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [onDirtyChange, stableFile]);

    useEffect(() => {
        if (importReady && !editor.isImporting && !hasImportedRef.current) {
            hasImportedRef.current = true;
            baselineModelRef.current = editor.model;
            onDirtyChange(false);
            return;
        }
        if (hasImportedRef.current) onDirtyChange(editor.model !== baselineModelRef.current);
    }, [editor.isImporting, editor.model, importReady, onDirtyChange]);

    const exportBlob = useCallback(async () => {
        const exported = await captureExportedBlob(() => editor.exportDocx(), DOCX_MIME, 30_000);
        const entries = unzipSync(new Uint8Array(await exported.arrayBuffer()));
        const compressed = zipSync(entries, { level: 6 });
        return new Blob([compressed], { type: DOCX_MIME });
    }, [editor]);

    useEffect(() => {
        onHandleChange({
            exportBlob,
            markSaved: () => {
                baselineModelRef.current = editor.model;
                onDirtyChange(false);
            },
        });
        return () => onHandleChange(null);
    }, [editor.model, exportBlob, onDirtyChange, onHandleChange]);

    const adjustZoom = (direction: -1 | 1) => {
        const current = ZOOM_LEVELS.indexOf(zoom);
        const next = Math.min(Math.max(current + direction, 0), ZOOM_LEVELS.length - 1);
        setZoom(ZOOM_LEVELS[next] ?? zoom);
    };

    return (
        <div className="flex h-full min-h-0 flex-col bg-[#25262b]">
            <div className="flex min-h-12 flex-wrap items-center gap-1 border-b border-white/10 bg-[#17181c] px-3 py-2">
                <ToolbarButton label="Undo" disabled={!editor.canUndo} onClick={editor.undo}><IconArrowBackUp /></ToolbarButton>
                <ToolbarButton label="Redo" disabled={!editor.canRedo} onClick={editor.redo}><IconArrowForwardUp /></ToolbarButton>
                <Divider />
                <select aria-label="Paragraph style" className="h-8 rounded-md border border-white/10 bg-black/20 px-2 text-xs text-zinc-200" value={editor.selectedParagraphStyleId || "Normal"} onChange={(event) => editor.setParagraphStyle(event.target.value)}>
                    <option value="Normal">Body</option>
                    <option value="Heading1">Heading 1</option>
                    <option value="Heading2">Heading 2</option>
                    <option value="Heading3">Heading 3</option>
                </select>
                <select aria-label="Font family" className="h-8 w-32 rounded-md border border-white/10 bg-black/20 px-2 text-xs text-zinc-200" value={editor.selectedRunStyle?.fontFamily || "Calibri"} onChange={(event) => editor.setFontFamily(event.target.value)}>
                    {['Calibri', 'Arial', 'Times New Roman', 'Georgia', 'Courier New'].map((font) => <option key={font} value={font}>{font}</option>)}
                </select>
                <select aria-label="Font size" className="h-8 w-16 rounded-md border border-white/10 bg-black/20 px-2 text-xs text-zinc-200" value={String(editor.selectedRunStyle?.fontSizePt || 11)} onChange={(event) => editor.setFontSize(Number(event.target.value))}>
                    {[8, 9, 10, 11, 12, 14, 16, 18, 20, 24, 28, 32, 36, 48].map((size) => <option key={size} value={size}>{size}</option>)}
                </select>
                <ToolbarButton label="Bold" onClick={editor.toggleBold}><IconBold /></ToolbarButton>
                <ToolbarButton label="Italic" onClick={editor.toggleItalic}><IconItalic /></ToolbarButton>
                <ToolbarButton label="Underline" onClick={editor.toggleUnderline}><IconUnderline /></ToolbarButton>
                <label className="relative flex size-8 cursor-pointer items-center justify-center rounded-md text-zinc-300 hover:bg-white/10" title="Text color">
                    <span className="h-4 w-4 rounded-full border border-white/40" style={{ backgroundColor: editor.selectedRunStyle?.color || '#f4f4f5' }} />
                    <input type="color" aria-label="Text color" className="absolute inset-0 opacity-0" value={editor.selectedRunStyle?.color || '#f4f4f5'} onChange={(event) => editor.setTextColor(event.target.value)} />
                </label>
                <ToolbarButton label="Highlight" onClick={() => editor.setHighlight(editor.selectedRunStyle?.highlight ? undefined : "yellow")}><IconHighlight /></ToolbarButton>
                <Divider />
                <ToolbarButton label="Align left" onClick={() => editor.setAlignment("left")}><IconAlignLeft /></ToolbarButton>
                <ToolbarButton label="Align center" onClick={() => editor.setAlignment("center")}><IconAlignCenter /></ToolbarButton>
                <ToolbarButton label="Align right" onClick={() => editor.setAlignment("right")}><IconAlignRight /></ToolbarButton>
                <ToolbarButton label="Justify" onClick={() => editor.setAlignment("justify")}><IconAlignJustified /></ToolbarButton>
                <ToolbarButton label="Bulleted list" onClick={() => editor.toggleList("unordered")}><IconList /></ToolbarButton>
                <ToolbarButton label="Numbered list" onClick={() => editor.toggleList("ordered")}><IconListNumbers /></ToolbarButton>
                <Divider />
                <ToolbarButton label="Insert table" onClick={editor.insertTable}><IconTablePlus /></ToolbarButton>
                <ToolbarButton label="Insert image" onClick={() => imageInputRef.current?.click()}><IconPhotoPlus /></ToolbarButton>
                <div className="ml-auto flex items-center gap-1">
                    <ToolbarButton label="Zoom out" disabled={zoom === ZOOM_LEVELS[0]} onClick={() => adjustZoom(-1)}><IconMinus /></ToolbarButton>
                    <span className="w-12 text-center text-xs tabular-nums text-zinc-400">{zoom}%</span>
                    <ToolbarButton label="Zoom in" disabled={zoom === ZOOM_LEVELS.at(-1)} onClick={() => adjustZoom(1)}><IconPlus /></ToolbarButton>
                </div>
            </div>
            <div className="min-h-0 flex-1 overflow-auto px-5 py-6" style={{ background: "radial-gradient(circle at 50% 0%, #35363d, #24252a 55%)" }}>
                <div className="mx-auto origin-top" style={{ zoom: zoom / 100 }}>
                    <DocxEditorViewer
                        editor={editor}
                        mode="edit"
                        pageBackgroundColor="#ffffff"
                        pageGapBackgroundColor="transparent"
                        pageVirtualization={{ zoomScale: zoom / 100, overscan: 2 }}
                        loadingState={<div className="py-20 text-center text-sm text-zinc-400">Opening document…</div>}
                    />
                </div>
            </div>
            <input ref={imageInputRef} type="file" accept="image/png,image/jpeg,image/gif,image/webp" className="hidden" onChange={(event) => { const file = event.target.files?.[0]; if (file) void editor.insertImageFile(file); event.currentTarget.value = ""; }} />
        </div>
    );
}

function Divider() {
    return <div className="mx-1 h-6 w-px bg-white/10" />;
}

function ToolbarButton(props: { label: string; disabled?: boolean; onClick: () => void; children: React.ReactElement }) {
    return (
        <Button type="button" variant="ghost" size="icon-sm" aria-label={props.label} title={props.label} disabled={props.disabled} onMouseDown={(event) => event.preventDefault()} onClick={props.onClick} className="text-zinc-300 hover:bg-white/10 hover:text-white [&_svg]:size-4">
            {props.children}
        </Button>
    );
}
