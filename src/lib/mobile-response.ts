import { NextResponse } from "next/server";
import { AuthError } from "@/lib/roles";

export function mobileJson(body: unknown, status = 200) {
    return NextResponse.json(body, { status, headers: { "Cache-Control": "no-store", "Pragma": "no-cache" } });
}

export function mobileError(error: unknown) {
    if (error instanceof AuthError) return mobileJson({ error: error.message }, error.statusCode);
    if (error instanceof SyntaxError) return mobileJson({ error: "Invalid JSON" }, 400);
    console.error("Mobile API error", error instanceof Error ? error.message : "Unknown error");
    return mobileJson({ error: "Mobile service unavailable" }, 503);
}
