/* eslint-disable @next/next/no-img-element */
/** The product name: never translated. */
const PRODUCT_NAME = "Emperor Claw";

export function CustomLogo({ className = "w-6 h-6" }: { className?: string }) {
    return (
        <img
            src="/emperor-claw-os/assets/branding/emblem.png"
            alt={PRODUCT_NAME}
            className={className}
        />
    );
}
