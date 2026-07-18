/* eslint-disable @next/next/no-img-element */
export function CustomLogo({ className = "w-6 h-6" }: { className?: string }) {
    return (
        <img
            src="/emperor-claw-os/assets/branding/emblem.png"
            alt="Emperor Claw"
            className={className}
        />
    );
}
