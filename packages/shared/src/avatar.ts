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

/** A valid avatar from untrusted input (frontmatter, API, tool calls), or undefined. */
export function parseAvatar(v: unknown): AgentAvatar | undefined {
  if (!v || typeof v !== "object") return undefined;
  const { color, shape } = v as Record<string, unknown>;
  if (!(AVATAR_COLORS as readonly unknown[]).includes(color) || !(AVATAR_SHAPES as readonly unknown[]).includes(shape)) return undefined;
  return { color: color as AvatarColor, shape: shape as AvatarShape };
}
