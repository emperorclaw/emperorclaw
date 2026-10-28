"use client";

import { createContext, useContext, type ReactNode } from "react";
import { ALL_MODULES_ON, type ModuleKey, type ModuleState } from "@/lib/modules";

const ModulesContext = createContext<ModuleState>(ALL_MODULES_ON);

/** The company's modules for client components (set once by the app layout). */
export function ModulesProvider({ modules, children }: { modules: ModuleState; children: ReactNode }) {
    return <ModulesContext.Provider value={modules}>{children}</ModulesContext.Provider>;
}

/** Whether a module is on; use it to hide links into a module that is off. */
export function useModuleEnabled(key: ModuleKey): boolean {
    return useContext(ModulesContext)[key];
}
