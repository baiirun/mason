import type { Edge, LayoutNode } from "./types";

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Directional focus by geometry, like i3/tmux: the nearest rect in direction
 * `dir` from `from`, preferring ones that overlap on the perpendicular axis.
 */
export function pickDirectional<T extends { rect: Rect }>(items: T[], from: Rect, dir: Edge): T | undefined {
  const cx = from.x + from.w / 2;
  const cy = from.y + from.h / 2;
  let best: T | undefined;
  let bestScore = Infinity;
  for (const it of items) {
    const r = it.rect;
    if (r === from) continue;
    let gap: number;
    let overlap: number;
    switch (dir) {
      case "left":
        gap = from.x - (r.x + r.w);
        overlap = Math.min(from.y + from.h, r.y + r.h) - Math.max(from.y, r.y);
        break;
      case "right":
        gap = r.x - (from.x + from.w);
        overlap = Math.min(from.y + from.h, r.y + r.h) - Math.max(from.y, r.y);
        break;
      case "up":
        gap = from.y - (r.y + r.h);
        overlap = Math.min(from.x + from.w, r.x + r.w) - Math.max(from.x, r.x);
        break;
      case "down":
        gap = r.y - (from.y + from.h);
        overlap = Math.min(from.x + from.w, r.x + r.w) - Math.max(from.x, r.x);
        break;
    }
    if (gap < -1) continue; // not in that direction
    const rcx = r.x + r.w / 2;
    const rcy = r.y + r.h / 2;
    const dist = Math.hypot(rcx - cx, rcy - cy);
    const score = (overlap > 0 ? 0 : 1e6) + Math.max(gap, 0) * 10 + dist;
    if (score < bestScore) {
      bestScore = score;
      best = it;
    }
  }
  return best;
}

/** Which drop zone of `rect` the point falls in: the middle 50% is "center". */
export function dropZone(rect: Rect, px: number, py: number): Edge | "center" {
  const fx = (px - rect.x) / rect.w;
  const fy = (py - rect.y) / rect.h;
  if (fx > 0.25 && fx < 0.75 && fy > 0.25 && fy < 0.75) return "center";
  const d = { left: fx, right: 1 - fx, up: fy, down: 1 - fy };
  return (Object.keys(d) as Edge[]).reduce((a, b) => (d[a] <= d[b] ? a : b));
}

/** The rect a block would occupy after dropping in `zone`, for the drag preview. */
export function zoneRect(rect: Rect, zone: Edge | "center"): Rect {
  const { x, y, w, h } = rect;
  switch (zone) {
    case "center":
      return rect;
    case "left":
      return { x, y, w: w / 2, h };
    case "right":
      return { x: x + w / 2, y, w: w / 2, h };
    case "up":
      return { x, y, w, h: h / 2 };
    case "down":
      return { x, y: y + h / 2, w, h: h / 2 };
  }
}

/** Lay the tree out in a unit square (no DOM), keyed by stack id. Used server-side to describe positions. */
export function layoutRects(root: LayoutNode | null, rect: Rect = { x: 0, y: 0, w: 1, h: 1 }, out: Record<string, Rect> = {}) {
  if (!root) return out;
  if (root.type === "stack") {
    out[root.id] = rect;
    return out;
  }
  let offset = 0;
  root.children.forEach((child, i) => {
    const f = root.sizes[i] ?? 0;
    const r =
      root.dir === "row"
        ? { x: rect.x + offset * rect.w, y: rect.y, w: f * rect.w, h: rect.h }
        : { x: rect.x, y: rect.y + offset * rect.h, w: rect.w, h: f * rect.h };
    offset += f;
    layoutRects(child, r, out);
  });
  return out;
}

/** Where `other` sits relative to `from`, in words: "left of", "below"... */
export function relativePosition(from: Rect, other: Rect): "left of" | "right of" | "above" | "below" {
  const dx = other.x + other.w / 2 - (from.x + from.w / 2);
  const dy = other.y + other.h / 2 - (from.y + from.h / 2);
  if (Math.abs(dx) >= Math.abs(dy)) return dx < 0 ? "left of" : "right of";
  return dy < 0 ? "above" : "below";
}
