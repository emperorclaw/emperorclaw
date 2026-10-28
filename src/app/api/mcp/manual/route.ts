import { NextRequest, NextResponse } from "next/server";
import { verifyMcpToken } from "@/lib/mcp";
import {
  EMPEROR_MANUAL_VERSION,
  emperorManualSectionsFor,
  formatEmperorManual,
  getEmperorManualSection,
  listEmperorManualSections,
} from "@/lib/emperor-manual";
import { loadCompanyModules } from "@/lib/modules-server";

/**
 * The single Emperor manual. No `section` returns the whole manual plus the
 * section list; `?section=<id>` returns just that section. Lines about a
 * module the company has switched off are left out.
 */
export async function GET(req: NextRequest) {
  const auth = await verifyMcpToken(req);
  if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const sections = emperorManualSectionsFor(await loadCompanyModules(auth.companyToken!.companyId));
  const sectionId = new URL(req.url).searchParams.get("section");
  if (sectionId) {
    const section = getEmperorManualSection(sectionId, sections);
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
    manual: formatEmperorManual(sections),
  });
}
