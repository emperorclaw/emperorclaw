export function CustomLogo({ className = "w-6 h-6" }: { className?: string }) {
    return (
        <svg
            viewBox="0 0 100 100"
            fill="none"
            xmlns="http://www.w3.org/2000/svg"
            className={className}
        >
            {/* Base line */}
            <path
                d="M10 85 h 80"
                stroke="#06b6d4"
                strokeWidth="5"
                strokeLinecap="round"
            />

            {/* Main Crown / Claw silhouette */}
            <path
                d="M15 75 L25 30 L40 55 L50 15 L60 55 L75 30 L85 75 Z"
                stroke="#06b6d4"
                strokeWidth="5"
                strokeLinejoin="round"
                fill="#06b6d4"
                fillOpacity="0.1"
            />

            {/* Inner details (Claw marks / ribbing) */}
            <path
                d="M32.5 75 V 50 M50 75 V 35 M67.5 75 V 50"
                stroke="#06b6d4"
                strokeWidth="4"
                strokeLinecap="round"
                strokeLinejoin="round"
            />

            {/* Emblem Jewels / Spikes */}
            <circle cx="50" cy="15" r="4.5" fill="#06b6d4" />
            <circle cx="25" cy="30" r="3.5" fill="#06b6d4" />
            <circle cx="75" cy="30" r="3.5" fill="#06b6d4" />
        </svg>
    );
}
