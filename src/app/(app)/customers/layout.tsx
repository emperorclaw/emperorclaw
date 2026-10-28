import type { ReactNode } from "react";
import { ModuleGate } from "@/components/module-gate";

export default function Layout({ children }: { children: ReactNode }) {
    return <ModuleGate module="customers">{children}</ModuleGate>;
}
