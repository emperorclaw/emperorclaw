import { redirect } from "next/navigation";

/** /budgets became Costs (roadmap 11.2); the budget controls live on its Budgets tab. */
export default function BudgetsPage() {
    redirect("/costs?tab=budgets");
}
