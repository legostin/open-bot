// Agent avatars: a colour and a shape. The web UI draws them; the hub only stores the pair.

export const AVATAR_COLORS = ["teal", "blue", "indigo", "violet", "pink", "red", "orange", "amber", "green", "slate"] as const;
export const AVATAR_SHAPES = ["circle", "square", "hexagon", "diamond", "triangle", "star", "flower", "drop"] as const;

export type AvatarColor = (typeof AVATAR_COLORS)[number];
export type AvatarShape = (typeof AVATAR_SHAPES)[number];

export interface AgentAvatar {
  color: AvatarColor;
  shape: AvatarShape;
}

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

/** A stable avatar for agents that never picked one. */
export function defaultAvatar(id: string): AgentAvatar {
  const h = hash(id);
  return { color: AVATAR_COLORS[h % AVATAR_COLORS.length], shape: AVATAR_SHAPES[(h >>> 8) % AVATAR_SHAPES.length] };
}

// ---------- how the web UI and the phone app draw it (the same geometry on both) ----------

/**
 * Each agent is a little candy with eyes: its shape, filled with its colour as a gradient (the light at the top, the
 * body at the bottom), and a face. The face is not stored: it comes from the agent's id, so it never changes and every
 * agent, old ones included, has one.
 */
export const AVATAR_FACES = ["look", "glance", "up", "wide", "happy", "wink"] as const;
export type AvatarFace = (typeof AVATAR_FACES)[number];

/** The agent's face, from its id (the phone app computes the same: AgentAvatar.face(for:)). */
export function avatarFace(id: string): AvatarFace {
  return AVATAR_FACES[(hash(id) >>> 16) % AVATAR_FACES.length];
}

/** The candy palette: the colour at the top of the shape and at its bottom. */
export const AVATAR_PALETTE: Record<AvatarColor, { top: string; bottom: string }> = {
  teal: { top: "#4fd8c4", bottom: "#0e9384" },
  blue: { top: "#6aa8ff", bottom: "#2563eb" },
  indigo: { top: "#8f97ff", bottom: "#4f46e5" },
  violet: { top: "#c08bff", bottom: "#7c3aed" },
  pink: { top: "#ff8fc8", bottom: "#db2777" },
  red: { top: "#ff8a80", bottom: "#dc2626" },
  orange: { top: "#ffb067", bottom: "#ea580c" },
  amber: { top: "#ffd45e", bottom: "#dd8500" },
  green: { top: "#7be495", bottom: "#16a34a" },
  slate: { top: "#a3b1c6", bottom: "#475569" },
};

/** Where the eyes sit in each shape's 40×40 box: their height, half the distance between them, and their radius. */
export const AVATAR_EYES: Record<AvatarShape, { y: number; dx: number; r: number }> = {
  circle: { y: 19.5, dx: 5.6, r: 4.3 },
  square: { y: 19.5, dx: 5.8, r: 4.4 },
  hexagon: { y: 20, dx: 5.4, r: 4.2 },
  diamond: { y: 20, dx: 4.6, r: 3.6 },
  triangle: { y: 25.5, dx: 4.4, r: 3.5 },
  star: { y: 21.8, dx: 4.3, r: 3.4 },
  flower: { y: 20, dx: 5.4, r: 4.2 },
  drop: { y: 25, dx: 5.2, r: 4.1 },
};

/** A valid avatar from untrusted input (frontmatter, API, tool calls), or undefined. */
export function parseAvatar(v: unknown): AgentAvatar | undefined {
  if (!v || typeof v !== "object") return undefined;
  const { color, shape } = v as Record<string, unknown>;
  if (!(AVATAR_COLORS as readonly unknown[]).includes(color) || !(AVATAR_SHAPES as readonly unknown[]).includes(shape)) return undefined;
  return { color: color as AvatarColor, shape: shape as AvatarShape };
}
