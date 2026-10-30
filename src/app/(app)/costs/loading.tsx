import { useTranslations } from "next-intl";
import { SkeletonCard, SkeletonHeader, SkeletonPage, SkeletonTable } from "@/components/ui/skeleton";

/** /costs: the summary tiles and the per-agent table. */
export default function Loading() {
    const t = useTranslations("costs");
    return (
        <SkeletonPage label={t("loading")}>
            <SkeletonHeader action={false} />
            <div aria-hidden className="grid grid-cols-2 gap-4 sm:grid-cols-4">
                {Array.from({ length: 4 }, (_, i) => <SkeletonCard key={i} lines={1} />)}
            </div>
            <SkeletonTable rows={6} columns={5} />
        </SkeletonPage>
    );
}
