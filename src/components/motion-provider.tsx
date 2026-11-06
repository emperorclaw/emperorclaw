"use client";

import { MotionConfig, type Transition } from "framer-motion";
import type { ReactNode } from "react";

/** Critically damped (no bounce): settles quickly without overshoot, like the CSS --ease-spring-snappy. */
export const SPRING: Transition = { type: "spring", bounce: 0, duration: 0.4 };

/**
 * Motion defaults for the app shell: framer-motion follows the OS
 * reduced-motion setting (transforms and layout moves are skipped, opacity
 * stays) and every animation uses the same critically damped spring.
 */
export function MotionProvider({ children }: { children: ReactNode }) {
    return (
        <MotionConfig reducedMotion="user" transition={SPRING}>
            {children}
        </MotionConfig>
    );
}
