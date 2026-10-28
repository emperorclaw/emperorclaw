import { Skeleton, SkeletonHeader, SkeletonPage } from "@/components/ui/skeleton";

/** /timeline: header, then rows of bars across the week. */
export default function Loading() {
    return (
        <SkeletonPage label="Loading timeline">
            <SkeletonHeader />
            <div aria-hidden className="space-y-3 rounded-2xl border border-border bg-card p-4">
                {Array.from({ length: 7 }, (_, i) => (
                    <div key={i} className="flex items-center gap-4">
                        <Skeleton className="h-3.5 w-32 shrink-0" />
                        <Skeleton className="h-6 rounded-lg" />
                    </div>
                ))}
            </div>
        </SkeletonPage>
    );
}
