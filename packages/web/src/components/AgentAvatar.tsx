// Agent avatar: a little candy with eyes. The shape and colour are picked when the agent is created; the face comes from
// its id (@owlbot/shared/avatar), so every agent, old ones too, has one and keeps it. The phone app draws the same
// (AgentAvatarView.swift). An agent at work looks around, blinks and glows in its colour; pointed at, it blinks.

import { useId, type CSSProperties } from "react";
import type { AgentAvatar as Avatar, AvatarColor, AvatarShape } from "@owlbot/shared";
import { AVATAR_EYES, AVATAR_PALETTE, avatarFace, defaultAvatar, type AvatarFace } from "@owlbot/shared/avatar";
import { cx } from "./ui";

/** Each colour's body (the bottom of the gradient): for places that need one flat colour. */
export const AVATAR_HEX: Record<AvatarColor, string> = Object.fromEntries(Object.entries(AVATAR_PALETTE).map(([k, v]) => [k, v.bottom])) as Record<AvatarColor, string>;

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

/** The shape in a 40×40 box, filled with `fill`. Polygons get a same-fill stroke to round their corners. */
export function AvatarShapeSvg({ shape, fill }: { shape: AvatarShape; fill: string }) {
  const round = { stroke: fill, strokeWidth: 3, strokeLinejoin: "round" as const };
  switch (shape) {
    case "circle":
      return <circle cx="20" cy="20" r="19" fill={fill} />;
    case "square":
      return <rect x="1.5" y="1.5" width="37" height="37" rx="11" fill={fill} />;
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

/** Where each face's pupils look, as a share of the eye's radius. */
const LOOK: Record<AvatarFace, { x: number; y: number }> = {
  look: { x: 0, y: 0.14 },
  glance: { x: 0.34, y: 0.06 },
  up: { x: 0.18, y: -0.3 },
  wide: { x: 0, y: 0.04 },
  happy: { x: 0, y: 0 },
  wink: { x: 0, y: 0.14 },
};

const INK = "#1c130b";

/** The eyes: white with an ink pupil (and a glint when big enough); "happy" and the wink are closed, smiling arcs. */
function Eyes({ shape, face, size }: { shape: AvatarShape; face: AvatarFace; size: number }) {
  const tiny = size <= 20;
  const e = AVATAR_EYES[shape];
  const r = e.r * (tiny ? 1.16 : 1) * (face === "wide" ? 1.14 : 1);
  const pr = r * (face === "wide" ? 0.44 : tiny ? 0.62 : 0.56);
  const look = LOOK[face];
  const arc = (cx: number) => (
    <path
      key={cx}
      className="owl-smile"
      d={`M${cx - r * 0.78} ${e.y + r * 0.3} Q${cx} ${e.y - r * 0.95} ${cx + r * 0.78} ${e.y + r * 0.3}`}
      fill="none"
      stroke="#fff"
      strokeWidth={r * (tiny ? 0.62 : 0.5)}
      strokeLinecap="round"
    />
  );
  const eye = (cx: number) => (
    <g key={cx} className="owl-eye">
      <circle cx={cx} cy={e.y} r={r} fill="#fff" stroke="rgb(0 0 0 / 0.07)" strokeWidth={0.5} />
      <g className="owl-pupil">
        <circle cx={cx + look.x * r} cy={e.y + look.y * r} r={pr} fill={INK} />
        {size >= 28 && <circle cx={cx + look.x * r + pr * 0.38} cy={e.y + look.y * r - pr * 0.42} r={pr * 0.3} fill="#fff" />}
      </g>
    </g>
  );
  const left = 20 - e.dx;
  const right = 20 + e.dx;
  if (face === "happy") return <g className="owl-face">{[arc(left), arc(right)]}</g>;
  if (face === "wink") return <g className="owl-face">{[eye(left), arc(right)]}</g>;
  return <g className="owl-face">{[eye(left), eye(right)]}</g>;
}

/** No letter on a face any more; kept so callers that pass it still compile. */
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
  running = false,
}: {
  avatar?: Avatar;
  /** The agent's id: its face, and a stable avatar when it has none. */
  id?: string;
  name?: string;
  size?: number;
  className?: string;
  /** Faces have no letter; ignored (kept for callers). */
  initial?: boolean;
  /** At work: it looks around, blinks and glows. */
  running?: boolean;
}) {
  const key = id ?? name ?? "agent";
  const a = avatar ?? defaultAvatar(key);
  const face = avatarFace(key);
  const pal = AVATAR_PALETTE[a.color] ?? AVATAR_PALETTE.slate;
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const fill = `url(#b${uid})`;
  const rich = size >= 22;
  const style = { "--glow": `${pal.bottom}aa`, ...(size >= 44 && !running ? { filter: `drop-shadow(0 ${size / 16}px ${size / 9}px ${pal.bottom}55)` } : {}) } as CSSProperties;
  return (
    <svg
      viewBox="0 0 40 40"
      width={size}
      height={size}
      className={cx("owl-avatar shrink-0 overflow-visible", running && "owl-alive", className)}
      style={style}
      role="img"
      aria-label={name}
    >
      {/* In the 40×40 box itself (userSpaceOnUse): a flower's petals share one light, not one each. */}
      <defs>
        <linearGradient id={`b${uid}`} gradientUnits="userSpaceOnUse" x1="10" y1="1" x2="30" y2="39">
          <stop offset="0" stopColor={pal.top} />
          <stop offset="1" stopColor={pal.bottom} />
        </linearGradient>
        {rich && (
          <radialGradient id={`g${uid}`} gradientUnits="userSpaceOnUse" cx="13" cy="7" r="24">
            <stop offset="0" stopColor="#fff" stopOpacity="0.62" />
            <stop offset="0.45" stopColor="#fff" stopOpacity="0.14" />
            <stop offset="1" stopColor="#fff" stopOpacity="0" />
          </radialGradient>
        )}
        {rich && (
          <linearGradient id={`s${uid}`} gradientUnits="userSpaceOnUse" x1="0" y1="1" x2="0" y2="39">
            <stop offset="0.55" stopColor="#000" stopOpacity="0" />
            <stop offset="1" stopColor="#000" stopOpacity="0.16" />
          </linearGradient>
        )}
        {/* The light and the shade go through the shape as one mask: overlapping petals do not add up. */}
        {rich && (
          <mask id={`m${uid}`} maskUnits="userSpaceOnUse" x="0" y="0" width="40" height="40">
            <AvatarShapeSvg shape={a.shape} fill="#fff" />
          </mask>
        )}
      </defs>
      <AvatarShapeSvg shape={a.shape} fill={fill} />
      {rich && (
        <g mask={`url(#m${uid})`}>
          <rect width="40" height="40" fill={`url(#s${uid})`} />
          <rect width="40" height="40" fill={`url(#g${uid})`} />
        </g>
      )}
      <Eyes shape={a.shape} face={face} size={size} />
    </svg>
  );
}

type AvatarAgent = { id: string; name?: string; avatar?: Avatar };

/** A group's members side by side, overlapping (the lead first); "+N" for the rest. `ring`: the background colour (ring and fill classes). */
export function AvatarStack({ agents, size = 28, max = 3, className, ring = "bg-surface ring-surface" }: { agents: AvatarAgent[]; size?: number; max?: number; className?: string; ring?: string }) {
  const shown = agents.slice(0, agents.length > max ? max - 1 : max);
  const rest = agents.length - shown.length;
  const overlap = Math.round(size * 0.3);
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
export function AvatarPair({ agents, size = 36, className, ring = "bg-surface ring-surface", running }: { agents: AvatarAgent[]; size?: number; className?: string; ring?: string; running?: boolean }) {
  const [a, b] = agents;
  if (!b) return <AgentAvatar avatar={a?.avatar} id={a?.id} name={a?.name} size={size} className={className} running={running} />;
  const inner = Math.round(size * 0.7);
  return (
    <span className={cx("relative block shrink-0", className)} style={{ width: size, height: size }} aria-hidden="true">
      <span className="absolute top-0 left-0 flex">
        <AgentAvatar avatar={a.avatar} id={a.id} name={a.name} size={inner} running={running} />
      </span>
      <span className={cx("absolute right-0 bottom-0 flex rounded-full ring-2", ring)}>
        <AgentAvatar avatar={b.avatar} id={b.id} name={b.name} size={inner} running={running} />
      </span>
    </span>
  );
}
