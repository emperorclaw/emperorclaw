"use client";

import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";

/**
 * The app's own "are you sure?" step, in place of window.confirm: same dialog
 * as the rest of the UI, translated buttons, and the confirm button says what
 * it does. Rendered only while open; closing it (Cancel, Esc, overlay) cancels.
 * `extraAction`: a third way out (e.g. "Choose a maintainer first"), shown
 * between Cancel and the confirm button; it neither confirms nor cancels.
 */
export function ConfirmDialog({ open, title, description, confirmLabel, destructive = false, onConfirm, onCancel, extraAction }: {
    open: boolean;
    title: string;
    description: string;
    confirmLabel: string;
    destructive?: boolean;
    onConfirm: () => void;
    onCancel: () => void;
    extraAction?: { label: string; onClick: () => void };
}) {
    const tc = useTranslations("common");
    return (
        <Dialog open={open} onOpenChange={(next) => { if (!next) onCancel(); }}>
            <DialogContent className="sm:max-w-md">
                <DialogHeader>
                    <DialogTitle>{title}</DialogTitle>
                    <DialogDescription>{description}</DialogDescription>
                </DialogHeader>
                <DialogFooter>
                    <Button type="button" variant="outline" onClick={onCancel}>{tc("cancel")}</Button>
                    {extraAction && <Button type="button" variant="outline" onClick={extraAction.onClick}>{extraAction.label}</Button>}
                    <Button type="button" variant={destructive ? "destructive" : "default"} onClick={onConfirm} autoFocus>{confirmLabel}</Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
