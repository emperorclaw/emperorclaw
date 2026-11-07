"use client";

import type { ReactNode } from "react";
import { IconX } from "@tabler/icons-react";
import { motion, useDragControls, type PanInfo } from "framer-motion";
import { useTranslations } from "next-intl";
import { DialogClose, DialogContent } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

/** Pulled down this far, or flicked down this fast, the sheet closes; less springs it back. */
const DISMISS_OFFSET_PX = 120;
const DISMISS_VELOCITY = 600;

/**
 * Phone bottom sheet for a Radix Dialog: it rises from the bottom edge
 * (`.ec-sheet`) and can be dragged down from its handle to dismiss, with
 * rubber-banding upward and a velocity-based flick. The surface is the inner
 * element, so the drag never fights the enter/exit animation on the content.
 */
export function BottomSheetContent({
    header,
    children,
    onDismiss,
    className,
}: {
    /** Title row (put the DialogTitle here); it doubles as the drag handle. */
    header: ReactNode;
    children: ReactNode;
    onDismiss: () => void;
    className?: string;
}) {
    const tc = useTranslations("common");
    const controls = useDragControls();
    const onDragEnd = (_event: PointerEvent | MouseEvent | TouchEvent, info: PanInfo) => {
        if (info.offset.y > DISMISS_OFFSET_PX || info.velocity.y > DISMISS_VELOCITY) onDismiss();
    };

    return (
        <DialogContent
            showCloseButton={false}
            className={cn("ec-sheet top-auto bottom-0 left-0 max-w-none translate-x-0 translate-y-0 gap-0 rounded-none border-0 bg-transparent p-0 shadow-none sm:max-w-none", className)}
        >
            <motion.div
                drag="y"
                dragListener={false}
                dragControls={controls}
                dragConstraints={{ top: 0, bottom: 0 }}
                dragElastic={{ top: 0.05, bottom: 1 }}
                dragTransition={{ bounceStiffness: 500, bounceDamping: 45 }}
                onDragEnd={onDragEnd}
                className="relative max-h-[85dvh] overflow-y-auto rounded-t-2xl border border-b-0 border-border bg-popover px-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] text-popover-foreground shadow-(--shadow-pop)"
            >
                <div onPointerDown={(event) => controls.start(event)} className="-mx-5 cursor-grab touch-none px-5 pb-3 pt-2.5 active:cursor-grabbing">
                    <div aria-hidden className="mx-auto mb-3 h-1 w-10 rounded-full bg-muted-foreground/30" />
                    <div className="pr-8">{header}</div>
                </div>
                <DialogClose className="absolute right-3 top-4 rounded-lg p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                    <IconX className="size-4" />
                    <span className="sr-only">{tc("close")}</span>
                </DialogClose>
                {children}
            </motion.div>
        </DialogContent>
    );
}
