import { NextRequest, NextResponse } from "next/server";
import { getCompanyId, getUserId } from "@/lib/auth";
import { updateDirectMessageQueueItem } from "@/lib/direct-message-queue";

async function update(req: NextRequest, params: Promise<{ id: string }>, action: "cancel" | "retry") {
    const companyId = await getCompanyId();
    const userId = await getUserId();
    if (!companyId || !userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    try {
        const { id } = await params;
        const message = await updateDirectMessageQueueItem({ companyId, userId, messageId: id, action });
        return NextResponse.json({ message });
    } catch (error) {
        const message = error instanceof Error ? error.message : "Could not update message";
        return NextResponse.json({ error: message }, { status: 409 });
    }
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    return update(req, params, "cancel");
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    return update(req, params, "retry");
}
