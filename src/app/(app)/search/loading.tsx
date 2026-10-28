import { Skeleton, SkeletonHeader, SkeletonPage } from "@/components/ui/skeleton";

/** /search: the query box and a few result groups. */
export default function Loading() {
    return (
        <SkeletonPage label="Loading search">
            <SkeletonHeader action={false} />
            <Skeleton className="h-11 w-full rounded-xl" />
            <div aria-hidden className="space-y-3">
                {Array.from({ length: 6 }, (_, i) => (
                    <div key={i} className="space-y-2 rounded-xl border border-border bg-card p-4">
                        <Skeleton className="h-3.5 w-1/3" />
                        <Skeleton className="h-3 w-5/6" />
                    </div>
                ))}
            </div>
        </SkeletonPage>
    );
}
