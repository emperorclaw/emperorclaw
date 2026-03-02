import { db } from "@/db";
import { customers } from "@/db/schema";
import { eq, and, isNull } from "drizzle-orm";
import { getCompanyId } from "@/lib/auth";
import { redirect } from "next/navigation";
import CustomersClient from "./customers-client";

export const dynamic = "force-dynamic";

export default async function CustomersPage() {
    const companyId = await getCompanyId();
    if (!companyId) redirect("/login");

    const allCustomers = await db.select().from(customers).where(and(eq(customers.companyId, companyId), isNull(customers.deletedAt)));

    return <CustomersClient initialData={allCustomers} />;
}
