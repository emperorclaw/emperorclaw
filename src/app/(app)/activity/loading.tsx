import { useTranslations } from "next-intl";
import { Skeleton, SkeletonHeader, SkeletonPage, SkeletonTable } from "@/components/ui/skeleton";

/** /activity: filters, then the log. */
export default function Loading() {
    const t = useTranslations("activity");
    return (
        <SkeletonPage label={t("loading")}>
            <SkeletonHeader action={false} />
            <div aria-hidden className="flex flex-wrap gap-2">
                {Array.from({ length: 3 }, (_, i) => <Skeleton key={i} className="h-9 w-40 rounded-xl" />)}
            </div>
            <SkeletonTable rows={8} columns={4} />
        </SkeletonPage>
    );
}
