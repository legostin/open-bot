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

type AvatarAgent = { id: string; name?: string; avatar?: Avatar };

/** A group's members side by side, overlapping (the lead first); "+N" for the rest. `ring`: the background colour (ring and fill classes). */
export function AvatarStack({ agents, size = 28, max = 3, className, ring = "bg-surface ring-surface" }: { agents: AvatarAgent[]; size?: number; max?: number; className?: string; ring?: string }) {
  const shown = agents.slice(0, agents.length > max ? max - 1 : max);
  const rest = agents.length - shown.length;
  const overlap = Math.round(size * 0.34);
  return (
    <span className={cx("flex shrink-0 items-center", className)} aria-hidden="true">
      {shown.map((a, i) => (
        <span key={a.id} className={cx("flex rounded-full ring-2", ring)} style={{ marginLeft: i ? -overlap : 0, zIndex: shown.length - i }}>
          <AgentAvatar avatar={a.avatar} id={a.id} name={a.name} size={size} />
        </span>
      ))}
      {rest > 0 && (
        <span className={cx("flex rounded-full ring-2", ring)} style={{ marginLeft: -overlap }}>
          <span
            className="flex items-center justify-center rounded-full bg-surface-3 font-semibold text-muted"
            style={{ width: size, height: size, fontSize: Math.max(9, Math.round(size * 0.36)) }}
          >
            +{rest}
          </span>
        </span>
      )}
    </span>
  );
}

/** A group's picture in a square of `size`: the first two members, one behind the other. `ring`: the background colour (ring and fill classes). */
export function AvatarPair({ agents, size = 36, className, ring = "bg-surface ring-surface" }: { agents: AvatarAgent[]; size?: number; className?: string; ring?: string }) {
  const [a, b] = agents;
  if (!b) return <AgentAvatar avatar={a?.avatar} id={a?.id} name={a?.name} size={size} className={className} />;
  const inner = Math.round(size * 0.68);
  return (
    <span className={cx("relative block shrink-0", className)} style={{ width: size, height: size }} aria-hidden="true">
      <span className="absolute top-0 left-0 flex">
        <AgentAvatar avatar={a.avatar} id={a.id} name={a.name} size={inner} />
      </span>
      <span className={cx("absolute right-0 bottom-0 flex rounded-full ring-2", ring)}>
        <AgentAvatar avatar={b.avatar} id={b.id} name={b.name} size={inner} />
      </span>
    </span>
  );
}
