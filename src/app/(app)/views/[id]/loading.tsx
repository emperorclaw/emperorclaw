import { SkeletonCard, SkeletonHeader, SkeletonPage } from "@/components/ui/skeleton";

/** A detail page: header, then its main card and a side card. */
export default function Loading() {
    return (
        <SkeletonPage>
            <SkeletonHeader />
            <div aria-hidden className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
                <SkeletonCard lines={6} />
                <SkeletonCard lines={3} />
            </div>
        </SkeletonPage>
    );
}
