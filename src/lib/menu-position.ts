/**
 * Where a floating menu goes relative to its trigger, in viewport (position:
 * fixed) coordinates. Pure so it can be unit-tested without a DOM.
 *
 * The menu opens below the trigger when its natural height fits there, or
 * when there is at least as much room below as above; otherwise it flips
 * above. It matches the trigger's width, stays inside the viewport margins,
 * and `maxHeight` caps it to the room on the chosen side.
 */
export type MenuRect = { top: number; bottom: number; left: number; width: number };
export type MenuViewport = { width: number; height: number };

export type MenuPosition = {
    placement: "below" | "above";
    left: number;
    width: number;
    maxHeight: number;
    /** Set when placed below: distance from the viewport top. */
    top?: number;
    /** Set when placed above: distance from the viewport bottom, so the menu grows upward. */
    bottom?: number;
};

export function placeMenu({ trigger, menuHeight, viewport, gap = 8, margin = 8 }: {
    trigger: MenuRect;
    menuHeight: number;
    viewport: MenuViewport;
    gap?: number;
    margin?: number;
}): MenuPosition {
    const spaceBelow = Math.max(0, viewport.height - trigger.bottom - gap - margin);
    const spaceAbove = Math.max(0, trigger.top - gap - margin);
    const placement = menuHeight <= spaceBelow || spaceBelow >= spaceAbove ? "below" : "above";

    const width = Math.max(0, Math.min(trigger.width, viewport.width - margin * 2));
    const left = Math.min(Math.max(trigger.left, margin), Math.max(margin, viewport.width - margin - width));

    if (placement === "below") {
        return { placement, left, width, maxHeight: spaceBelow, top: trigger.bottom + gap };
    }
    return { placement, left, width, maxHeight: spaceAbove, bottom: viewport.height - trigger.top + gap };
}
