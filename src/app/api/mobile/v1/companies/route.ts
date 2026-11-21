import { mobileIdentity, mobileCompanies } from "@/lib/mobile-auth";
import { mobileJson, mobileError } from "@/lib/mobile-response";

export async function GET(request: Request) {
    try { return mobileJson({ companies: await mobileCompanies(await mobileIdentity(request)) }); }
    catch (error) { return mobileError(error); }
}
