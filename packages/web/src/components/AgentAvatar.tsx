// Agent avatar: a coloured shape with the agent's initial. Colour and shape are picked when the agent is created.

import type { AgentAvatar as Avatar, AvatarColor, AvatarShape } from "@owlbot/shared";
import { defaultAvatar } from "@owlbot/shared/avatar";
import { cx } from "./ui";

export const AVATAR_HEX: Record<AvatarColor, string> = {
  teal: "#0d9488",
  blue: "#2563eb",
  indigo: "#4f46e5",
  violet: "#7c3aed",
  pink: "#db2777",
  red: "#dc2626",
  orange: "#ea580c",
  amber: "#d97706",
  green: "#16a34a",
  slate: "#475569",
};

function starPoints(points: number, outer: number, inner: number): string {
  const out: string[] = [];
  for (let i = 0; i < points * 2; i++) {
    const r = i % 2 ? inner : outer;
    const a = (Math.PI / points) * i - Math.PI / 2;
    out.push(`${(20 + r * Math.cos(a)).toFixed(2)},${(21 + r * Math.sin(a)).toFixed(2)}`);
  }
  return out.join(" ");
}

const STAR = starPoints(5, 19.5, 9.5);
const PETALS = Array.from({ length: 8 }, (_, i) => {
  const a = (Math.PI / 4) * i;
  return { cx: 20 + 11 * Math.cos(a), cy: 20 + 11 * Math.sin(a) };
});

/** The shape in a 40×40 box, filled with `fill`. Polygons get a same-colour stroke to round their corners. */
export function AvatarShapeSvg({ shape, fill }: { shape: AvatarShape; fill: string }) {
  const round = { stroke: fill, strokeWidth: 3, strokeLinejoin: "round" as const };
  switch (shape) {
    case "circle":
      return <circle cx="20" cy="20" r="19" fill={fill} />;
    case "square":
      return <rect x="1.5" y="1.5" width="37" height="37" rx="10" fill={fill} />;
    case "hexagon":
      return <polygon points="20,2.5 35.5,11.25 35.5,28.75 20,37.5 4.5,28.75 4.5,11.25" fill={fill} {...round} />;
    case "diamond":
      return <polygon points="20,2.5 37.5,20 20,37.5 2.5,20" fill={fill} {...round} />;
    case "triangle":
      return <polygon points="20,3.5 37,35 3,35" fill={fill} {...round} />;
    case "star":
      return <polygon points={STAR} fill={fill} {...round} />;
    case "flower":
      return (
        <g fill={fill}>
          {PETALS.map((p, i) => (
            <circle key={i} cx={p.cx} cy={p.cy} r="8" />
          ))}
          <circle cx="20" cy="20" r="12" />
        </g>
      );
    case "drop":
      return <path d="M20 2 C26 10 34 17 34 25 A14 14 0 0 1 6 25 C6 17 14 10 20 2 Z" fill={fill} />;
  }
}

/** Where the initial sits inside each shape (visual centre). */
const TEXT_Y: Partial<Record<AvatarShape, number>> = { triangle: 25.5, drop: 25, star: 22 };

export function initialOf(name: string | undefined): string {
  const first = [...(name ?? "").trim()][0];
  return first ? first.toLocaleUpperCase() : "";
}

export function AgentAvatar({
  avatar,
  id,
  name,
  size = 28,
  className,
  initial = true,
}: {
  avatar?: Avatar;
  /** Used to derive a stable avatar when the agent has none. */
  id?: string;
  name?: string;
  size?: number;
  className?: string;
  initial?: boolean;
}) {
  const a = avatar ?? defaultAvatar(id ?? name ?? "agent");
  const letter = initial ? initialOf(name) : "";
  const small = a.shape === "star" || a.shape === "triangle" || a.shape === "diamond";
  return (
    <svg viewBox="0 0 40 40" width={size} height={size} className={cx("shrink-0", className)} role="img" aria-label={name}>
      <AvatarShapeSvg shape={a.shape} fill={AVATAR_HEX[a.color]} />
      {letter && (
        <text
          x="20"
          y={TEXT_Y[a.shape] ?? 20.5}
          textAnchor="middle"
          dominantBaseline="central"
          fill="#fff"
          fontSize={small ? 13 : 17}
          fontWeight={600}
          fontFamily="inherit"
        >
          {letter}
        </text>
      )}
    </svg>
  );
}
