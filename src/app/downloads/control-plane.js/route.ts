import fs from "node:fs/promises";
import path from "node:path";

export async function GET() {
    const filePath = path.join(process.cwd(), "scripts", "control-plane.js");
    const body = await fs.readFile(filePath, "utf8");
    return new Response(body, {
        headers: {
            "content-type": "application/javascript; charset=utf-8",
            "content-disposition": 'inline; filename="control-plane.js"',
            "cache-control": "public, max-age=300",
        },
    });
}
