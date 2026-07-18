export function CustomLogo({ className = "w-6 h-6" }: { className?: string }) {
    return (
        <svg
            viewBox="0 0 100 100"
            fill="none"
            xmlns="http://www.w3.org/2000/svg"
            className={className}
        >
            <defs>
                {/* Cyan metallic gradient */}
                <linearGradient id="logoMain" x1="0" y1="0" x2="1" y2="1">
                    <stop offset="0%" stopColor="#22d3ee" />
                    <stop offset="30%" stopColor="#06b6d4" />
                    <stop offset="50%" stopColor="#cffafe" />
                    <stop offset="70%" stopColor="#0891b2" />
                    <stop offset="100%" stopColor="#155e75" />
                </linearGradient>
                {/* Dark depth gradient */}
                <linearGradient id="logoDark" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#0e7490" />
                    <stop offset="50%" stopColor="#083344" />
                    <stop offset="100%" stopColor="#042f2e" />
                </linearGradient>
                {/* Highlight sheen */}
                <linearGradient id="logoSheen" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="white" stopOpacity="0.35" />
                    <stop offset="40%" stopColor="white" stopOpacity="0" />
                </linearGradient>
                {/* Jewel glow */}
                <radialGradient id="logoJewel" cx="40%" cy="30%">
                    <stop offset="0%" stopColor="#cffafe" />
                    <stop offset="40%" stopColor="#06b6d4" />
                    <stop offset="100%" stopColor="#155e75" />
                </radialGradient>
                {/* Drop shadow */}
                <filter id="logoShadow" x="-20%" y="-20%" width="140%" height="140%">
                    <feDropShadow dx="0" dy="2" stdDeviation="3" floodColor="#000" floodOpacity="0.5" />
                </filter>
                {/* Inner glow */}
                <filter id="logoGlow">
                    <feGaussianBlur in="SourceAlpha" stdDeviation="2" result="blur" />
                    <feOffset dx="0" dy="1" result="offsetBlur" />
                    <feComposite in="SourceGraphic" in2="offsetBlur" operator="over" />
                </filter>
            </defs>

            {/* Base platform — 3D extruded bar */}
            <rect x="8" y="80" width="84" height="10" rx="3" fill="url(#logoDark)" filter="url(#logoShadow)" />
            <rect x="8" y="80" width="84" height="5" rx="3" fill="url(#logoMain)" opacity="0.5" />

            {/* Crown / Claw — back layer (depth) */}
            <path
                d="M15 75 L25 30 L40 55 L50 15 L60 55 L75 30 L85 75 Z"
                fill="url(#logoDark)"
                filter="url(#logoShadow)"
                transform="translate(0, 3)"
            />

            {/* Crown / Claw — main fill */}
            <path
                d="M15 75 L25 30 L40 55 L50 15 L60 55 L75 30 L85 75 Z"
                fill="url(#logoMain)"
                stroke="url(#logoDark)"
                strokeWidth="2"
                strokeLinejoin="round"
            />

            {/* Crown / Claw — top sheen */}
            <path
                d="M15 75 L25 30 L40 55 L50 15 L60 55 L75 30 L85 75 Z"
                fill="url(#logoSheen)"
            />

            {/* Claw ribbing */}
            <path d="M33 75 V 52" stroke="url(#logoDark)" strokeWidth="4" strokeLinecap="round" opacity="0.6" />
            <path d="M50 75 V 38" stroke="url(#logoDark)" strokeWidth="4" strokeLinecap="round" opacity="0.7" />
            <path d="M67 75 V 52" stroke="url(#logoDark)" strokeWidth="4" strokeLinecap="round" opacity="0.6" />

            {/* Rib highlights */}
            <path d="M34 74 V 53" stroke="white" strokeWidth="1.5" strokeLinecap="round" opacity="0.2" />
            <path d="M51 74 V 39" stroke="white" strokeWidth="1.5" strokeLinecap="round" opacity="0.25" />
            <path d="M68 74 V 53" stroke="white" strokeWidth="1.5" strokeLinecap="round" opacity="0.2" />

            {/* Crown jewels */}
            <circle cx="50" cy="15" r="7" fill="url(#logoJewel)" filter="url(#logoGlow)" />
            <circle cx="50" cy="14" r="3" fill="white" opacity="0.35" />

            <circle cx="25" cy="30" r="6" fill="url(#logoJewel)" filter="url(#logoGlow)" />
            <circle cx="25" cy="29" r="2.5" fill="white" opacity="0.35" />

            <circle cx="75" cy="30" r="6" fill="url(#logoJewel)" filter="url(#logoGlow)" />
            <circle cx="75" cy="29" r="2.5" fill="white" opacity="0.35" />

            {/* Side spikes */}
            <circle cx="40" cy="55" r="4" fill="url(#logoJewel)" />
            <circle cx="60" cy="55" r="4" fill="url(#logoJewel)" />
        </svg>
    );
}
