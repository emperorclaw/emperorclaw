"use client";

import { createContext, useContext } from "react";

/**
 * What a rich block may ask of the chat it is rendered in. Today that is one
 * thing: an interactive widget sending a follow-up prompt as the operator
 * (`data-emperor-send` / `emperor.send()`). Surfaces that can't send — docs,
 * artifacts, read-only history — simply don't provide it and widget buttons
 * become inert.
 */
export interface RichMessageActions {
    sendPrompt?: (prompt: string) => void | Promise<void>;
}

export const RichMessageActionsContext = createContext<RichMessageActions>({});

export function useRichMessageActions(): RichMessageActions {
    return useContext(RichMessageActionsContext);
}
