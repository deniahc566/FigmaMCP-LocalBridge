import type { Color, Effect, Paint, Vector } from '../figma/types.js';
import { num } from '../util.js';

const hex2 = (v: number) => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, '0');

/** CSS color for a Figma color, folding in an extra paint/layer opacity. */
export function cssColor(c: Color, opacity = 1): string {
  const a = (c.a ?? 1) * opacity;
  if (a >= 0.999) return `#${hex2(c.r)}${hex2(c.g)}${hex2(c.b)}`;
  return `rgba(${Math.round(c.r * 255)},${Math.round(c.g * 255)},${Math.round(c.b * 255)},${num(a)})`;
}

export function visiblePaints(paints: Paint[] | undefined): Paint[] {
  return (paints ?? []).filter((p) => p.visible !== false && (p.opacity ?? 1) > 0);
}

function gradientAngle(handles: Vector[], width: number, height: number): number {
  const [p0, p1] = handles;
  const dx = (p1.x - p0.x) * width;
  const dy = (p1.y - p0.y) * height;
  // CSS: 0deg points up and angles grow clockwise; y grows downward on the canvas.
  const deg = (Math.atan2(dx, -dy) * 180) / Math.PI;
  return (deg + 360) % 360;
}

function stops(paint: Paint, colorFor: (c: Color, stopIndex: number) => string): string {
  return (paint.gradientStops ?? []).map((s, i) => `${colorFor(s.color, i)} ${num(s.position * 100)}%`).join(', ');
}

/**
 * CSS background-image layer for a gradient paint. `colorFor` lets the caller substitute
 * variable references for stop colors.
 */
export function gradientCss(paint: Paint, width: number, height: number, colorFor?: (c: Color, i: number) => string): string | null {
  const handles = paint.gradientHandlePositions;
  if (!handles || handles.length < 2) return null;
  const opacity = paint.opacity ?? 1;
  const color = colorFor ?? ((c: Color) => cssColor(c, opacity));
  const center = `${num(handles[0].x * 100)}% ${num(handles[0].y * 100)}%`;
  switch (paint.type) {
    case 'GRADIENT_LINEAR':
      return `linear-gradient(${num(gradientAngle(handles, width, height))}deg, ${stops(paint, color)})`;
    case 'GRADIENT_RADIAL':
    case 'GRADIENT_DIAMOND': {
      const rx = Math.hypot((handles[1].x - handles[0].x) * width, (handles[1].y - handles[0].y) * height);
      const ry = handles[2] ? Math.hypot((handles[2].x - handles[0].x) * width, (handles[2].y - handles[0].y) * height) : rx;
      return `radial-gradient(${num(rx)}px ${num(ry)}px at ${center}, ${stops(paint, color)})`;
    }
    case 'GRADIENT_ANGULAR':
      return `conic-gradient(from ${num(gradientAngle(handles, width, height))}deg at ${center}, ${stops(paint, color)})`;
    default:
      return null;
  }
}

/** Human-readable description of a paint, used for variable/style values. */
export function describePaint(paint: Paint): string {
  if (paint.type === 'SOLID' && paint.color) return cssColor(paint.color, paint.opacity ?? 1);
  if (paint.type.startsWith('GRADIENT')) return gradientCss(paint, 100, 100) ?? paint.type;
  if (paint.type === 'IMAGE') return `image(${paint.imageRef ?? 'unknown'}, ${paint.scaleMode ?? 'FILL'})`;
  return paint.type;
}

export function describeEffect(e: Effect): string {
  const parts = [`type: ${e.type}`];
  if (e.color) parts.push(`color: ${cssColor(e.color)}`);
  if (e.offset) parts.push(`offset: (${num(e.offset.x)}, ${num(e.offset.y)})`);
  parts.push(`radius: ${num(e.radius)}`);
  if (e.spread) parts.push(`spread: ${num(e.spread)}`);
  return `Effect(${parts.join(', ')})`;
}
