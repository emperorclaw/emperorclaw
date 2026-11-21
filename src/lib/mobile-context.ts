import { AsyncLocalStorage } from "node:async_hooks";
import type { GuardContext } from "@/lib/roles";

/** Set only after native-token verification, inside the explicit mobile route
 * allow-list. Never populated from headers/cookies or a browser request. */
export const mobileRequestContext = new AsyncLocalStorage<{ ctx: GuardContext; sessionId: string }>();
