import { useTranslations } from "next-intl";
import { Skeleton, SkeletonCard, SkeletonHeader, SkeletonPage } from "@/components/ui/skeleton";

/** /agents: the roster on the left, the selected agent on the right. */
export default function Loading() {
    const t = useTranslations("agents.list");
    return (
        <SkeletonPage label={t("loading")}>
            <SkeletonHeader />
            <div aria-hidden className="grid grid-cols-1 gap-6 lg:grid-cols-[320px_minmax(0,1fr)]">
                <div className="space-y-2 rounded-2xl border border-border bg-card p-3 sm:p-4">
                    <Skeleton className="h-10 w-full rounded-xl" />
                    {Array.from({ length: 5 }, (_, i) => (
                        <div key={i} className="flex items-center gap-3 rounded-xl border border-border p-3">
                            <Skeleton className="h-9 w-9 shrink-0 rounded-full" />
                            <div className="flex-1 space-y-2">
                                <Skeleton className="h-3.5 w-1/2" />
                                <Skeleton className="h-3 w-3/4" />
                            </div>
                        </div>
                    ))}
                </div>
                <div className="space-y-4">
                    <SkeletonCard lines={2} />
                    <SkeletonCard lines={5} />
                </div>
            </div>
        </SkeletonPage>
    );
}
