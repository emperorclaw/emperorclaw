import fs from "fs";
import path from "path";
import { NextResponse } from "next/server";

const headers = {
    "Content-Type": "text/markdown",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

export async function GET() {
    try {
        const filePath = path.join(process.cwd(), "clawhub", "emperor-claw-os", "SKILL.md");
        const fileContent = fs.readFileSync(filePath, "utf-8");

        return new NextResponse(fileContent, {
            status: 200,
            headers,
        });
    } catch (error) {
        console.error("Failed to read SKILL.md:", error);
        return new NextResponse("Skill definition not found", { status: 404 });
    }
}

export async function OPTIONS() {
    return new NextResponse(null, {
        status: 204,
        headers,
    });
}
