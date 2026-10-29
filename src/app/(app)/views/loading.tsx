import { useTranslations } from "next-intl";
import { SkeletonCard, SkeletonHeader, SkeletonPage } from "@/components/ui/skeleton";

/** /views: a grid of view cards. */
export default function Loading() {
    const t = useTranslations("views.list");
    return (
        <SkeletonPage label={t("loading")}>
            <SkeletonHeader />
            <div aria-hidden className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
                {Array.from({ length: 6 }, (_, i) => <SkeletonCard key={i} lines={2} />)}
            </div>
        </SkeletonPage>
    );
}
