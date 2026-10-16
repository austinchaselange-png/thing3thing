import type { SVGProps } from "react";

type P = SVGProps<SVGSVGElement> & { size?: number };

function Svg({ size = 16, children, ...rest }: P) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true" {...rest}>
      {children}
    </svg>
  );
}

export const InboxIcon = (p: P) => (
  <Svg {...p}>
    <path d="M2 9.5 3.6 3.4A1.2 1.2 0 0 1 4.8 2.5h6.4a1.2 1.2 0 0 1 1.2.9L14 9.5v3a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1v-3Z" fill="currentColor" opacity=".18" />
    <path d="M2 9.5 3.6 3.4A1.2 1.2 0 0 1 4.8 2.5h6.4a1.2 1.2 0 0 1 1.2.9L14 9.5m-12 0v3a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1v-3m-12 0h3.2l.8 1.6h4l.8-1.6H14" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
  </Svg>
);

export const StarIcon = (p: P) => (
  <Svg {...p}>
    <path d="m8 1.6 1.9 4 4.4.5-3.3 3 .9 4.3L8 11.2l-3.9 2.2.9-4.3-3.3-3 4.4-.5L8 1.6Z" fill="currentColor" />
  </Svg>
);

export const CalendarIcon = (p: P) => (
  <Svg {...p}>
    <rect x="2" y="3" width="12" height="11" rx="2" fill="currentColor" />
    <rect x="3.3" y="6.2" width="9.4" height="6.5" rx="1" fill="var(--bg, #fff)" />
    <path d="M5 1.8v2.4M11 1.8v2.4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    <rect x="5" y="8" width="2" height="2" rx=".4" fill="currentColor" />
  </Svg>
);

export const LayersIcon = (p: P) => (
  <Svg {...p}>
    <path d="M8 2 14 5 8 8 2 5l6-3Z" fill="currentColor" />
    <path d="m2.5 8 5.5 2.8L13.5 8M2.5 11 8 13.8l5.5-2.8" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
  </Svg>
);

export const BoxIcon = (p: P) => (
  <Svg {...p}>
    <rect x="1.8" y="2.5" width="12.4" height="3.6" rx="1" fill="currentColor" />
    <path d="M2.8 6.1h10.4V12a1.5 1.5 0 0 1-1.5 1.5H4.3A1.5 1.5 0 0 1 2.8 12V6.1Z" fill="currentColor" opacity=".55" />
    <path d="M6.3 8.5h3.4" stroke="var(--bg, #fff)" strokeWidth="1.3" strokeLinecap="round" />
  </Svg>
);

export const LogbookIcon = (p: P) => (
  <Svg {...p}>
    <rect x="2" y="2" width="12" height="12" rx="2.5" fill="currentColor" />
    <path d="m5 8.2 2 2 4-4.4" stroke="var(--bg, #fff)" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
  </Svg>
);

export const TrashIcon = (p: P) => (
  <Svg {...p}>
    <path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.3 4.5l.6 8.3a1 1 0 0 0 1 .9h4.2a1 1 0 0 0 1-.9l.6-8.3" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
  </Svg>
);

export const AreaIcon = (p: P) => (
  <Svg {...p}>
    <path d="M8 1.8 13.5 4.8v6.4L8 14.2l-5.5-3V4.8L8 1.8Z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
    <path d="M2.7 4.9 8 7.9l5.3-3M8 7.9v6.1" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
  </Svg>
);

export function ProgressPie({ done, total, size = 16, color = "currentColor" }: { done: number; total: number; size?: number; color?: string }) {
  const frac = total ? done / total : 0;
  const r = 4.2;
  const angle = frac * 2 * Math.PI;
  const x = 8 + r * Math.sin(angle);
  const y = 8 - r * Math.cos(angle);
  const large = frac > 0.5 ? 1 : 0;
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden="true">
      <circle cx="8" cy="8" r="6.3" fill="none" stroke={color} strokeWidth="1.4" />
      {frac >= 1 ? (
        <circle cx="8" cy="8" r={r} fill={color} />
      ) : frac > 0 ? (
        <path d={`M8 8 L8 ${8 - r} A${r} ${r} 0 ${large} 1 ${x} ${y} Z`} fill={color} />
      ) : null}
    </svg>
  );
}

export const TagIcon = (p: P) => (
  <Svg {...p}>
    <path d="M2.5 3.5v3.6c0 .3.1.5.3.7l5.6 5.6a1 1 0 0 0 1.4 0l3.4-3.4a1 1 0 0 0 0-1.4L7.6 3a1 1 0 0 0-.7-.3H3.3a.8.8 0 0 0-.8.8Z" stroke="currentColor" strokeWidth="1.3" />
    <circle cx="5.3" cy="5.5" r="1" fill="currentColor" />
  </Svg>
);

export const FlagIcon = (p: P) => (
  <Svg {...p}>
    <path d="M3.5 14V2.5M3.5 2.8h8l-1.8 3 1.8 3h-8" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
  </Svg>
);

export const RepeatIcon = (p: P) => (
  <Svg {...p}>
    <path d="M3 7V6a2 2 0 0 1 2-2h7.5M10.5 2l2 2-2 2M13 9v1a2 2 0 0 1-2 2H3.5M5.5 14l-2-2 2-2" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
  </Svg>
);

export const BellIcon = (p: P) => (
  <Svg {...p}>
    <path d="M4 11V7a4 4 0 0 1 8 0v4l1 1.3H3L4 11ZM6.6 14h2.8" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
  </Svg>
);

export const NotesIcon = (p: P) => (
  <Svg {...p}>
    <path d="M3 4h10M3 7h10M3 10h7" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
  </Svg>
);

export const ChecklistIcon = (p: P) => (
  <Svg {...p}>
    <path d="m2.5 4.2 1 1 1.8-2M2.5 9.7l1 1 1.8-2M7.5 4.5H13.5M7.5 10H13.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
  </Svg>
);

export const PlusIcon = (p: P) => (
  <Svg {...p}>
    <path d="M8 3v10M3 8h10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
  </Svg>
);

export const GearIcon = (p: P) => (
  <Svg {...p}>
    <circle cx="8" cy="8" r="2" stroke="currentColor" strokeWidth="1.3" />
    <path
      d="M8 1.8v1.6M8 12.6v1.6M14.2 8h-1.6M3.4 8H1.8M12.4 3.6l-1.1 1.1M4.7 11.3l-1.1 1.1M12.4 12.4l-1.1-1.1M4.7 4.7 3.6 3.6"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinecap="round"
    />
  </Svg>
);

export const SearchIcon = (p: P) => (
  <Svg {...p}>
    <circle cx="7" cy="7" r="4.3" stroke="currentColor" strokeWidth="1.4" />
    <path d="m10.3 10.3 3.2 3.2" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
  </Svg>
);

export const CloudIcon = (p: P) => (
  <Svg {...p}>
    <path d="M4.5 12.5a3 3 0 0 1-.3-6 4 4 0 0 1 7.7 1A2.5 2.5 0 0 1 11.5 12.5h-7Z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
  </Svg>
);

export const LockIcon = (p: P) => (
  <Svg {...p}>
    <rect x="3.5" y="7" width="9" height="6.5" rx="1.5" stroke="currentColor" strokeWidth="1.3" />
    <path d="M5.5 7V5.3a2.5 2.5 0 0 1 5 0V7" stroke="currentColor" strokeWidth="1.3" />
  </Svg>
);

export const MoonIcon = (p: P) => (
  <Svg {...p}>
    <path d="M13 9.6A5.5 5.5 0 1 1 6.4 3a4.4 4.4 0 0 0 6.6 6.6Z" fill="currentColor" />
  </Svg>
);

export const ArrowRightIcon = (p: P) => (
  <Svg {...p}>
    <path d="M3 8h9.5M9 4.5 12.5 8 9 11.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
  </Svg>
);

export const WarningIcon = (p: P) => (
  <Svg {...p}>
    <path d="M8 2.2 14.3 13H1.7L8 2.2Z" fill="currentColor" opacity=".2" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
    <path d="M8 6.5v3M8 11.3v.1" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
  </Svg>
);

export const CloseIcon = (p: P) => (
  <Svg {...p}>
    <path d="m4 4 8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
  </Svg>
);

export const ChevronIcon = (p: P) => (
  <Svg {...p}>
    <path d="m6 3.5 4.5 4.5L6 12.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
  </Svg>
);

export const HeadingIcon = (p: P) => (
  <Svg {...p}>
    <path d="M2.5 4.5h11M2.5 8h7M2.5 11.5h9" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
  </Svg>
);

export const LIST_META = {
  inbox: { title: "Inbox", Icon: InboxIcon, color: "var(--c-inbox)" },
  today: { title: "Today", Icon: StarIcon, color: "var(--c-today)" },
  upcoming: { title: "Upcoming", Icon: CalendarIcon, color: "var(--c-upcoming)" },
  anytime: { title: "Anytime", Icon: LayersIcon, color: "var(--c-anytime)" },
  someday: { title: "Someday", Icon: BoxIcon, color: "var(--c-someday)" },
  logbook: { title: "Logbook", Icon: LogbookIcon, color: "var(--c-logbook)" },
  trash: { title: "Trash", Icon: TrashIcon, color: "var(--c-trash)" },
} as const;
