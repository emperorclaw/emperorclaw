import { NextRequest, NextResponse } from "next/server";
import { verifyMcpToken } from "@/lib/mcp";
import {
  EMPEROR_MANUAL,
  EMPEROR_MANUAL_VERSION,
  getEmperorManualSection,
  listEmperorManualSections,
} from "@/lib/emperor-manual";

/**
 * The single Emperor manual. No `section` returns the whole manual plus the
 * section list; `?section=<id>` returns just that section.
 */
export async function GET(req: NextRequest) {
  const auth = await verifyMcpToken(req);
  if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const sectionId = new URL(req.url).searchParams.get("section");
  if (sectionId) {
    const section = getEmperorManualSection(sectionId);
    if (!section) {
      return NextResponse.json(
        { error: `Unknown section: ${sectionId}`, sections: listEmperorManualSections() },
        { status: 404 },
      );
    }
    return NextResponse.json({ version: EMPEROR_MANUAL_VERSION, section });
  }

  return NextResponse.json({
    version: EMPEROR_MANUAL_VERSION,
    sections: listEmperorManualSections(),
    manual: EMPEROR_MANUAL,
  });
}
