import { NextRequest } from "next/server";
import { mobileWork } from "@/lib/mobile-work";

export const dynamic = "force-dynamic";
async function dispatch(request: NextRequest, context: { params: Promise<{ companyId: string; path: string[] }> }) {
    const { companyId, path } = await context.params;
    return mobileWork(request, companyId, path);
}
export { dispatch as GET, dispatch as POST, dispatch as PATCH };
