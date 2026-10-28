import { Skeleton, SkeletonHeader, SkeletonPage } from "@/components/ui/skeleton";

/** /projects: header, filter bar and the board's lanes. */
export default function Loading() {
    return (
        <SkeletonPage label="Loading projects">
            <SkeletonHeader />
            <div aria-hidden className="flex flex-wrap gap-2">
                {Array.from({ length: 5 }, (_, i) => <Skeleton key={i} className="h-8 w-24 rounded-full" />)}
            </div>
            <div aria-hidden className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
                {Array.from({ length: 4 }, (_, lane) => (
                    <div key={lane} className="space-y-3 rounded-2xl border border-border bg-card p-3">
                        <Skeleton className="h-4 w-24" />
                        {Array.from({ length: 3 - (lane % 2) }, (_, card) => (
                            <div key={card} className="space-y-2 rounded-xl border border-border bg-background p-3">
                                <Skeleton className="h-3.5 w-4/5" />
                                <Skeleton className="h-3 w-1/2" />
                            </div>
                        ))}
                    </div>
                ))}
            </div>
        </SkeletonPage>
    );
}
