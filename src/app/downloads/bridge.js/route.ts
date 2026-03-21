import fs from "node:fs/promises";
import path from "node:path";

export async function GET() {
    const filePath = path.join(process.cwd(), "clawhub", "emperor-claw-os", "examples", "bridge.js");
    const body = await fs.readFile(filePath, "utf8");
    return new Response(body, {
        headers: {
            "content-type": "application/javascript; charset=utf-8",
            "content-disposition": 'inline; filename="bridge.js"',
            "cache-control": "public, max-age=300",
        },
    });
}
