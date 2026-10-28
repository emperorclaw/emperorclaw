import { NextRequest, NextResponse } from "next/server";
import { AuthError, requireRole } from "@/lib/roles";
import { isCompanyTemplateId, isModuleKey, templateModules, type ModuleState } from "@/lib/modules";
import { loadCompanyModules, updateCompanyModules } from "@/lib/modules-server";

export const dynamic = "force-dynamic";

function failure(error: unknown) {
    if (error instanceof AuthError) return NextResponse.json({ error: error.message }, { status: error.statusCode });
    console.error("[settings/modules]", error);
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
}

/** The company's modules: { modules: { customers: true, views: false, … } }. */
export async function GET() {
    try {
        const { companyId } = await requireRole("viewer")();
        return NextResponse.json({ modules: await loadCompanyModules(companyId) });
    } catch (error) {
        return failure(error);
    }
}

/**
 * Owners/admins switch modules: { modules: { views: false } } changes the keys
 * given; { template: "agency" | "product" | "operations" } sets every module to
 * that template's starting state and changes nothing else. A module's data is
 * never touched. Audited (company.settings_changed, setting "modules").
 */
export async function PUT(req: NextRequest) {
    try {
        const { companyId, userId } = await requireRole("admin")();
        const body = await req.json().catch(() => null) as { modules?: unknown; template?: unknown } | null;
        if (!body || typeof body !== "object") return NextResponse.json({ error: "A JSON object body is required" }, { status: 400 });

        if (body.template !== undefined) {
            if (!isCompanyTemplateId(body.template)) return NextResponse.json({ error: "template must be agency, product or operations" }, { status: 400 });
            const result = await updateCompanyModules({ companyId, userId, changes: templateModules(body.template), template: body.template });
            return NextResponse.json({ ok: true, modules: result.after, changed: result.changed });
        }

        const raw = body.modules;
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) return NextResponse.json({ error: "Pass modules ({ key: true | false }) or template" }, { status: 400 });
        const changes: Partial<ModuleState> = {};
        for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
            if (!isModuleKey(key)) return NextResponse.json({ error: `Unknown module: ${key}` }, { status: 400 });
            if (typeof value !== "boolean") return NextResponse.json({ error: `${key} must be true or false` }, { status: 400 });
            changes[key] = value;
        }
        const result = await updateCompanyModules({ companyId, userId, changes });
        return NextResponse.json({ ok: true, modules: result.after, changed: result.changed });
    } catch (error) {
        return failure(error);
    }
}
