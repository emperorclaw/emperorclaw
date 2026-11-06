"use client";

import { forwardRef, useState, type ReactNode } from "react";
import {
    AnimatePresence,
    motion,
    useIsPresent,
    useReducedMotion,
    type HTMLMotionProps,
    type Transition,
    type Variant,
    type Variants,
} from "framer-motion";
import { SPRING } from "@/components/motion-provider";
import { cn } from "@/lib/utils";

// Shared enter/exit motion for the app. Everything rides the same critically
// damped spring as the CSS tokens (--ease-spring / --ease-spring-snappy); exits
// are about 65% of the entrance and leave the way they came. Under reduced
// motion every helper falls back to a short opacity-only fade (<= 160 ms).

export { SPRING };
/** 0.3 s spring for small things: badges, pills, buttons, indicators. */
export const SPRING_SNAPPY: Transition = { type: "spring", bounce: 0, duration: 0.3 };

const EXIT: Transition = { type: "spring", bounce: 0, duration: 0.26 };
const EXIT_SNAPPY: Transition = { type: "spring", bounce: 0, duration: 0.2 };
const REDUCED_IN: Transition = { duration: 0.16, ease: "easeOut" };
const REDUCED_OUT: Transition = { duration: 0.12, ease: "easeIn" };

type Motion = { initial: Variant; animate: Variant; exit: Variant };

/** Variant props (`initial`/`animate`/`exit` labels plus `variants`) for a motion element. */
function useMotion(full: Motion, snappy: boolean) {
    const reduced = useReducedMotion();
    const variants: Variants = reduced
        ? {
              initial: { opacity: 0 },
              animate: { opacity: 1, transition: REDUCED_IN },
              exit: { opacity: 0, transition: REDUCED_OUT },
          }
        : {
              initial: full.initial,
              animate: { ...full.animate, transition: snappy ? SPRING_SNAPPY : SPRING },
              exit: { ...full.exit, transition: snappy ? EXIT_SNAPPY : EXIT },
          };
    return { variants, initial: "initial", animate: "animate", exit: "exit" } as const;
}

/** Leaving content is inert, so nothing inside stays focusable while it animates out. */
function useExitInert() {
    return !useIsPresent();
}

type DivProps = Omit<HTMLMotionProps<"div">, "initial" | "animate" | "exit" | "children"> & { children?: ReactNode };

/**
 * A block that fades and rises 6 px in, and sinks back out. Use it as the
 * direct child of an AnimatePresence (give it a `key`), or through `Presence`.
 */
export const FadeRise = forwardRef<HTMLDivElement, DivProps & { snappy?: boolean; y?: number; scale?: boolean }>(
    function FadeRise({ snappy = false, y = 6, scale = false, className, children, ...props }, ref) {
        const m = useMotion(
            {
                initial: { opacity: 0, y, ...(scale ? { scale: 0.96 } : {}) },
                animate: { opacity: 1, y: 0, ...(scale ? { scale: 1 } : {}) },
                exit: { opacity: 0, y, ...(scale ? { scale: 0.96 } : {}) },
            },
            snappy,
        );
        const inert = useExitInert();
        return (
            <motion.div ref={ref} {...m} inert={inert || undefined} data-motion="" className={className} {...props}>
                {children}
            </motion.div>
        );
    },
);

/**
 * Conditional block (banner, inline error, inline form, "jump to latest",
 * typing indicator) that fades/rises in and out. Already-visible content does
 * not animate on first paint.
 */
export function Presence({
    show,
    children,
    className,
    snappy,
    y,
    scale,
    initial = false,
}: {
    show: boolean;
    children: ReactNode;
    className?: string;
    snappy?: boolean;
    y?: number;
    scale?: boolean;
    /** Animate on first mount too (default false). */
    initial?: boolean;
}) {
    return (
        <AnimatePresence initial={initial}>
            {show && (
                <FadeRise key="presence" className={className} snappy={snappy} y={y} scale={scale}>
                    {children}
                </FadeRise>
            )}
        </AnimatePresence>
    );
}

/** Small inline status element (count badge, receipt, pill) that scales in and out. */
export function PopPresence({ show, children, className, as = "span" }: { show: boolean; children: ReactNode; className?: string; as?: "span" | "div" }) {
    const m = useMotion(
        { initial: { opacity: 0, scale: 0.6 }, animate: { opacity: 1, scale: 1 }, exit: { opacity: 0, scale: 0.6 } },
        true,
    );
    const Tag = as === "div" ? motion.div : motion.span;
    return (
        <AnimatePresence initial={false}>
            {show && (
                <Tag key="pop" {...m} className={className}>
                    {children}
                </Tag>
            )}
        </AnimatePresence>
    );
}

function CollapseBody({ className, children, snappy, settledOnMount }: { className?: string; children: ReactNode; snappy?: boolean; settledOnMount: boolean }) {
    const m = useMotion(
        { initial: { height: 0, opacity: 0 }, animate: { height: "auto", opacity: 1 }, exit: { height: 0, opacity: 0 } },
        !!snappy,
    );
    const reduced = useReducedMotion();
    const inert = useExitInert();
    // Clip only while the height moves: once open it stays unclipped, so
    // focus rings and shadows inside are not cut off.
    // Open on first paint never animates, so it starts settled.
    const [settled, setSettled] = useState(settledOnMount);
    // Reduced motion keeps the height jump instant and only fades.
    void reduced;
    return (
        <motion.div
            {...m}
            inert={inert || undefined}
            style={{ overflow: settled ? "visible" : "hidden" }}
            onAnimationStart={() => setSettled(false)}
            onAnimationComplete={(definition) => setSettled(definition === "animate")}
        >
            <div className={className}>{children}</div>
        </motion.div>
    );
}

/**
 * Expandable content: height + opacity in, the same back out. The padding
 * belongs on `className` (an inner wrapper), so the collapse reaches zero.
 */
export function Collapse({ open, children, className, snappy, id }: { open: boolean; children: ReactNode; className?: string; snappy?: boolean; id?: string }) {
    // True only while the body that was open on first paint is still mounted.
    const [openOnMount, setOpenOnMount] = useState(open);
    if (openOnMount && !open) setOpenOnMount(false);
    return (
        <AnimatePresence initial={false}>
            {open && (
                <CollapseBody key="collapse" className={className} snappy={snappy} settledOnMount={openOnMount}>
                    {id ? <div id={id}>{children}</div> : children}
                </CollapseBody>
            )}
        </AnimatePresence>
    );
}

/**
 * Wrapper for a list whose items come and go. Items already on screen (first
 * paint, background refresh) do not animate; a leaving item is popped out of
 * the flow so its siblings slide into place on the spring.
 */
export function MotionList({ children }: { children: ReactNode }) {
    return (
        <AnimatePresence initial={false} mode="popLayout">
            {children}
        </AnimatePresence>
    );
}

type ItemTag = "div" | "li" | "article" | "button";

/** One keyed item inside `MotionList`. */
export const MotionItem = forwardRef<HTMLElement, Omit<HTMLMotionProps<"div">, "initial" | "animate" | "exit" | "children"> & { as?: ItemTag; type?: "button"; children?: ReactNode }>(
    function MotionItem({ as = "div", className, children, ...props }, ref) {
        const m = useMotion(
            { initial: { opacity: 0, y: 6 }, animate: { opacity: 1, y: 0 }, exit: { opacity: 0, scale: 0.98 } },
            false,
        );
        const inert = useExitInert();
        const Tag = (as === "li" ? motion.li : as === "article" ? motion.article : as === "button" ? motion.button : motion.div) as typeof motion.div;
        return (
            <Tag
                ref={ref as React.Ref<HTMLDivElement>}
                layout="position"
                {...m}
                inert={inert || undefined}
                data-motion=""
                className={className}
                {...props}
            >
                {children}
            </Tag>
        );
    },
);

/**
 * Crossfade between keyed views (tab panels, threads, agent details). The new
 * view comes in at once (the old one is popped out of the flow while it
 * fades), sliding 12 px in the direction of travel: `direction` 1 moves
 * forward (in from the right), -1 back, 0 just fades.
 */
export function Swap({ id, direction = 0, children, className, panelClassName, distance = 12 }: { id: string; direction?: number; children: ReactNode; className?: string; panelClassName?: string; distance?: number }) {
    const reduced = !!useReducedMotion();
    // Exiting panels read AnimatePresence's `custom`, so they leave in the latest direction.
    const custom: SwapCustom = { dir: Math.sign(direction), d: distance, reduced };
    return (
        <div className={cn("relative", className)}>
            <AnimatePresence initial={false} mode="popLayout" custom={custom}>
                <SwapPanel key={id} custom={custom} className={panelClassName}>
                    {children}
                </SwapPanel>
            </AnimatePresence>
        </div>
    );
}

type SwapCustom = { dir: number; d: number; reduced: boolean };

const swapVariants = {
    enter: ({ dir, d, reduced }: SwapCustom) => (reduced ? { opacity: 0 } : { opacity: 0, x: dir * d }),
    center: ({ reduced }: SwapCustom) => ({ opacity: 1, x: 0, transition: reduced ? REDUCED_IN : SPRING }),
    exit: ({ dir, d, reduced }: SwapCustom) =>
        reduced ? { opacity: 0, transition: REDUCED_OUT } : { opacity: 0, x: dir * -d, transition: EXIT },
};

const SwapPanel = forwardRef<HTMLDivElement, { custom: SwapCustom; className?: string; children: ReactNode }>(function SwapPanel({ custom, className, children }, ref) {
    const inert = useExitInert();
    return (
        <motion.div ref={ref} custom={custom} variants={swapVariants} initial="enter" animate="center" exit="exit" inert={inert || undefined} className={className}>
            {children}
        </motion.div>
    );
});

/** Direction of travel between two tab values, by their position in `order`. */
export function tabDirection<T>(order: readonly T[], from: T, to: T): number {
    return Math.sign(order.indexOf(to) - order.indexOf(from));
}

/**
 * Remembers which way the last tab change went (1 forward, -1 back), using
 * React's previous-value-in-state pattern so it is right in the same render.
 */
export function useTabDirection<T>(value: T, order: readonly T[]): number {
    const [state, setState] = useState({ value, direction: 0 });
    if (state.value !== value) {
        const next = { value, direction: tabDirection(order, state.value, value) };
        setState(next);
        return next.direction;
    }
    return state.direction;
}

/**
 * The active segment's fill: one element per group (same `layoutId`) that
 * glides to whichever segment is active, like the sidebar pill. Put it
 * inside the active segment, which needs `relative isolate`.
 */
export function SegmentPill({ layoutId, className, radius = 10 }: { layoutId: string; className?: string; radius?: number }) {
    return (
        <motion.span
            layoutId={layoutId}
            aria-hidden
            transition={SPRING_SNAPPY}
            className={cn("absolute inset-0 -z-10", className)}
            style={{ borderRadius: radius }}
        />
    );
}

/**
 * Props for a presence-driven overlay part: once it starts leaving it is inert
 * and lets clicks through, so nothing in it can be focused or hit while it
 * animates out. Call it in the component that is AnimatePresence's direct child.
 */
function useExitOverlay(m: ReturnType<typeof useMotion>) {
    const exiting = useExitInert();
    return {
        ...m,
        "data-motion": "",
        inert: exiting || undefined,
        style: exiting ? { pointerEvents: "none" as const } : undefined,
    };
}

/** Variant props for a right-edge drawer: slides in from the edge and back out (fades under reduced motion). */
export function useDrawerMotion() {
    return useExitOverlay(useMotion({ initial: { x: "100%" }, animate: { x: 0 }, exit: { x: "100%" } }, false));
}

/** Variant props for a scrim behind a drawer or sheet. */
export function useScrimMotion() {
    return useExitOverlay(useMotion({ initial: { opacity: 0 }, animate: { opacity: 1 }, exit: { opacity: 0 } }, false));
}

/**
 * Inline text/pill that crossfades when its `id` changes (Sent -> Read,
 * Queued -> Being handled, Pending -> Approved). No animation on mount, so a
 * virtualized row scrolling back into view stays still.
 */
export function TextSwap({ id, children, className }: { id: string; children: ReactNode; className?: string }) {
    const m = useMotion({ initial: { opacity: 0, y: 3 }, animate: { opacity: 1, y: 0 }, exit: { opacity: 0, y: -3 } }, true);
    return (
        <AnimatePresence initial={false} mode="popLayout">
            <motion.span key={id} {...m} className={cn("inline-flex", className)}>
                {children}
            </motion.span>
        </AnimatePresence>
    );
}
