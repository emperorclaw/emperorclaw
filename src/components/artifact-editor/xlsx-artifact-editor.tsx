"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
    XlsxViewer,
    useXlsxViewerController,
} from "@extend-ai/react-xlsx";
import {
    IconArrowBackUp,
    IconArrowForwardUp,
    IconFilePlus,
    IconMinus,
    IconPlus,
} from "@tabler/icons-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { captureExportedBlob } from "./download-capture";
import type { OfficeEditorProps } from "./types";

const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const MAX_WORKBOOK_BYTES = 25 * 1024 * 1024;

export default function XlsxArtifactEditor(props: OfficeEditorProps) {
    const { bytes, fileName, onDirtyChange, onHandleChange } = props;
    const stableBytes = useMemo(() => bytes.slice(0), [bytes]);
    const controller = useXlsxViewerController({
        file: stableBytes,
        fileName,
        maxFileSizeBytes: MAX_WORKBOOK_BYTES,
        useWorker: true,
    });
    const baselineRevisionRef = useRef<number | null>(null);

    useEffect(() => {
        if (!controller.isLoading && controller.workbook && baselineRevisionRef.current === null) {
            baselineRevisionRef.current = controller.revision;
        }
        const dirty = baselineRevisionRef.current !== null && controller.revision !== baselineRevisionRef.current;
        onDirtyChange(dirty);
    }, [controller.isLoading, controller.revision, controller.workbook, onDirtyChange]);

    const exportBlob = useCallback(
        () => captureExportedBlob(() => controller.exportXlsx(), XLSX_MIME),
        [controller],
    );

    useEffect(() => {
        onHandleChange({
            exportBlob,
            markSaved: () => {
                baselineRevisionRef.current = controller.revision;
                onDirtyChange(false);
            },
        });
        return () => onHandleChange(null);
    }, [controller.revision, exportBlob, onDirtyChange, onHandleChange]);

    if (controller.error) {
        return (
            <div className="flex h-full items-center justify-center p-8 text-center">
                <div className="max-w-md rounded-2xl border border-rose-500/25 bg-rose-500/10 p-6">
                    <p className="font-medium text-rose-100">This workbook could not be opened.</p>
                    <p className="mt-2 text-sm text-rose-200/70">{controller.error.message}</p>
                </div>
            </div>
        );
    }

    return (
        <div className="flex h-full min-h-0 flex-col bg-[#101114]">
            <div className="flex min-h-12 flex-wrap items-center gap-1.5 border-b border-white/10 bg-[#17181c] px-3 py-2">
                <ToolbarButton label="Undo" disabled={!controller.canUndo} onClick={controller.undo}><IconArrowBackUp /></ToolbarButton>
                <ToolbarButton label="Redo" disabled={!controller.canRedo} onClick={controller.redo}><IconArrowForwardUp /></ToolbarButton>
                <div className="mx-1 h-6 w-px bg-white/10" />
                <ToolbarButton label="Zoom out" disabled={!controller.canZoomOut} onClick={controller.zoomOut}><IconMinus /></ToolbarButton>
                <span className="min-w-12 text-center text-xs tabular-nums text-zinc-400">{Math.round(controller.zoomScale)}%</span>
                <ToolbarButton label="Zoom in" disabled={!controller.canZoomIn} onClick={controller.zoomIn}><IconPlus /></ToolbarButton>
                <div className="mx-1 h-6 w-px bg-white/10" />
                <ToolbarButton label="Add worksheet" onClick={() => controller.addSheet()}><IconFilePlus /></ToolbarButton>
                <div className="ml-1 flex min-w-[280px] flex-1 items-center gap-2">
                    <span className="w-12 truncate rounded-md border border-white/10 bg-black/20 px-2 py-1.5 text-center text-xs font-medium text-zinc-300">
                        {controller.activeCellAddress || "—"}
                    </span>
                    <FormulaInput
                        key={`${controller.activeCellAddress}:${controller.selectedFormula}:${controller.selectedValue}`}
                        initialValue={controller.selectedFormula || controller.selectedValue || ""}
                        disabled={!controller.activeCell || controller.readOnly}
                        onApply={(value) => {
                            if (!controller.activeCell) return;
                            if (value.trim().startsWith("=")) controller.setSelectedCellFormula(value.trim().slice(1));
                            else controller.setSelectedCellValue(value);
                        }}
                    />
                </div>
            </div>
            <div className="min-h-0 flex-1">
                <XlsxViewer
                    controller={controller}
                    height="100%"
                    isDark
                    rounded={false}
                    showDefaultToolbar={false}
                    selectionColor="#22d3ee"
                    loadingState={<EditorLoading label="Opening workbook…" />}
                />
            </div>
        </div>
    );
}

function FormulaInput(props: { initialValue: string; disabled: boolean; onApply: (value: string) => void }) {
    const [value, setValue] = useState(props.initialValue);
    return (
        <Input
            aria-label="Cell value or formula"
            value={value}
            onChange={(event) => setValue(event.target.value)}
            onKeyDown={(event) => { if (event.key === "Enter") props.onApply(value); }}
            onBlur={() => props.onApply(value)}
            disabled={props.disabled}
            placeholder="Select a cell to edit its value or formula"
            className="h-8 border-white/10 bg-black/20 font-mono text-xs"
        />
    );
}

function ToolbarButton(props: { label: string; disabled?: boolean; onClick: () => void; children: React.ReactElement }) {
    return (
        <Button type="button" variant="ghost" size="icon-sm" aria-label={props.label} title={props.label} disabled={props.disabled} onClick={props.onClick} className="text-zinc-300 hover:bg-white/10 hover:text-white [&_svg]:size-4">
            {props.children}
        </Button>
    );
}

function EditorLoading({ label }: { label: string }) {
    return <div className="flex h-full items-center justify-center text-sm text-zinc-400">{label}</div>;
}
