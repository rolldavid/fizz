/**
 * Tiny inline SVG icons. Stroke-based so they re-color with currentColor.
 */

type Props = { size?: number; className?: string; strokeWidth?: number };

function Svg({
    children,
    size = 16,
    className,
    strokeWidth = 1.8,
}: Props & { children: React.ReactNode }) {
    return (
        <svg
            width={size}
            height={size}
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={strokeWidth}
            strokeLinecap="round"
            strokeLinejoin="round"
            className={className}
            aria-hidden="true"
        >
            {children}
        </svg>
    );
}

export const SunIcon = (p: Props) => (
    <Svg {...p}>
        <circle cx="12" cy="12" r="4" />
        <path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
    </Svg>
);

export const MoonIcon = (p: Props) => (
    <Svg {...p}>
        <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
    </Svg>
);

export const CopyIcon = (p: Props) => (
    <Svg {...p}>
        <rect x="9" y="9" width="13" height="13" rx="2" />
        <path d="M5 15V5a2 2 0 0 1 2-2h10" />
    </Svg>
);

export const CheckIcon = (p: Props) => (
    <Svg {...p}>
        <polyline points="20 6 9 17 4 12" />
    </Svg>
);

export const ShareIcon = (p: Props) => (
    <Svg {...p}>
        <path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8" />
        <polyline points="16 6 12 2 8 6" />
        <line x1="12" y1="2" x2="12" y2="15" />
    </Svg>
);

export const DownloadIcon = (p: Props) => (
    <Svg {...p}>
        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
        <polyline points="7 10 12 15 17 10" />
        <line x1="12" y1="15" x2="12" y2="3" />
    </Svg>
);

export const QrIcon = (p: Props) => (
    <Svg {...p}>
        <rect x="3" y="3" width="7" height="7" />
        <rect x="14" y="3" width="7" height="7" />
        <rect x="3" y="14" width="7" height="7" />
        <line x1="14" y1="14" x2="14" y2="17" />
        <line x1="17" y1="14" x2="17" y2="14.01" />
        <line x1="20" y1="14" x2="20" y2="17" />
        <line x1="14" y1="20" x2="14" y2="20.01" />
        <line x1="17" y1="17" x2="20" y2="17" />
        <line x1="20" y1="20" x2="20" y2="20.01" />
    </Svg>
);

export const LockIcon = (p: Props) => (
    <Svg {...p}>
        <rect x="3" y="11" width="18" height="11" rx="2" />
        <path d="M7 11V7a5 5 0 0 1 10 0v4" />
    </Svg>
);

export const ArrowLeftIcon = (p: Props) => (
    <Svg {...p}>
        <line x1="19" y1="12" x2="5" y2="12" />
        <polyline points="12 19 5 12 12 5" />
    </Svg>
);

export const EyeIcon = (p: Props) => (
    <Svg {...p}>
        <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
        <circle cx="12" cy="12" r="3" />
    </Svg>
);

export const EyeOffIcon = (p: Props) => (
    <Svg {...p}>
        <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" />
        <line x1="1" y1="1" x2="23" y2="23" />
    </Svg>
);

export const PeopleIcon = (p: Props) => (
    <Svg {...p}>
        <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
        <circle cx="9" cy="7" r="4" />
        <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
        <path d="M16 3.13a4 4 0 0 1 0 7.75" />
    </Svg>
);

export const PlusIcon = (p: Props) => (
    <Svg {...p}>
        <line x1="12" y1="5" x2="12" y2="19" />
        <line x1="5" y1="12" x2="19" y2="12" />
    </Svg>
);

export const TrashIcon = (p: Props) => (
    <Svg {...p}>
        <polyline points="3 6 5 6 21 6" />
        <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
        <path d="M10 11v6M14 11v6" />
    </Svg>
);

export const BookmarkIcon = (p: Props) => (
    <Svg {...p}>
        <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" />
    </Svg>
);

export const KeyIcon = (p: Props) => (
    <Svg {...p}>
        <circle cx="7.5" cy="15.5" r="4.5" />
        <path d="M10.5 12.5 21 2M16 7l3 3M14 9l2 2" />
    </Svg>
);
