"use client";

import { createContext, useContext } from "react";

/**
 * What a rich block may ask of the chat it is rendered in: sending a
 * follow-up prompt as the operator (a widget's `data-emperor-send`, a
 * ```choices button) and knowing what the operator already replied. Surfaces
 * that can't send (docs, artifacts, read-only history) simply don't provide
 * it, and those buttons become inert.
 */
export interface RichMessageActions {
    /** Resolves `false` when the message could not be sent. */
    sendPrompt?: (prompt: string) => void | boolean | Promise<void | boolean>;
    /** Operator messages sent after this one (mentions stripped), so a
     *  ```choices block can show which option was already picked. */
    laterReplies?: string[];
}

export const RichMessageActionsContext = createContext<RichMessageActions>({});

export function useRichMessageActions(): RichMessageActions {
    return useContext(RichMessageActionsContext);
}
