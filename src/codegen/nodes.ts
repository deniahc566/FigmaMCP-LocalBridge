import type { FigmaNode, VariableAlias } from '../figma/types.js';
import { visiblePaints } from './paint.js';

const VECTOR_TYPES = new Set(['VECTOR', 'BOOLEAN_OPERATION', 'STAR', 'LINE', 'REGULAR_POLYGON']);
const SHAPE_TYPES = new Set([...VECTOR_TYPES, 'ELLIPSE', 'RECTANGLE']);
const CONTAINER_TYPES = new Set(['FRAME', 'GROUP', 'COMPONENT', 'COMPONENT_SET', 'INSTANCE', 'SECTION']);

export function isVisible(node: FigmaNode): boolean {
  return node.visible !== false;
}

export function visibleChildren(node: FigmaNode): FigmaNode[] {
  return (node.children ?? []).filter(isVisible);
}

export function hasImageFill(node: FigmaNode): boolean {
  return visiblePaints(node.fills).some((p) => p.type === 'IMAGE');
}

/**
 * True when a node is best exported as one SVG: a vector primitive, or a container (typically an
 * icon) whose visible leaves are all shapes and include at least one true vector, with no text or images.
 */
export function isSvgAsset(node: FigmaNode): boolean {
  if (VECTOR_TYPES.has(node.type)) return true;
  if (node.type === 'ELLIPSE') {
    // Full ellipses render fine as a rounded div; arcs and donuts need the SVG.
    const arc = node.arcData as { startingAngle: number; endingAngle: number; innerRadius: number } | undefined;
    return Boolean(arc && (arc.innerRadius > 0 || Math.abs(arc.endingAngle - arc.startingAngle) < 2 * Math.PI - 0.01));
  }
  if (!CONTAINER_TYPES.has(node.type) || node.type === 'SECTION') return false;
  const kids = visibleChildren(node);
  if (kids.length === 0) return false;
  let sawVector = false;
  const walk = (n: FigmaNode): boolean => {
    if (n.type === 'TEXT' || hasImageFill(n)) return false;
    if (VECTOR_TYPES.has(n.type)) sawVector = true;
    if (SHAPE_TYPES.has(n.type)) return true;
    if (!CONTAINER_TYPES.has(n.type)) return false;
    // Auto-layout containers with padding are layout, not artwork.
    if (n !== node && n.layoutMode && n.layoutMode !== 'NONE') return false;
    return visibleChildren(n).every(walk);
  };
  if (node.layoutMode && node.layoutMode !== 'NONE' && (node.itemSpacing || node.paddingLeft || node.paddingTop)) return false;
  return kids.every(walk) && sawVector;
}

/** Top-most SVG-worthy nodes in a subtree (does not descend into a node once it qualifies). */
export function collectSvgNodes(root: FigmaNode, limit = Infinity): FigmaNode[] {
  const out: FigmaNode[] = [];
  const walk = (n: FigmaNode) => {
    if (out.length >= limit || !isVisible(n)) return;
    if (isSvgAsset(n)) {
      out.push(n);
      return;
    }
    for (const c of n.children ?? []) walk(c);
  };
  walk(root);
  return out;
}

export interface ImageFillRef {
  nodeId: string;
  nodeName: string;
  imageRef: string;
  scaleMode?: string;
}

export function collectImageFills(root: FigmaNode, limit = Infinity): ImageFillRef[] {
  const out: ImageFillRef[] = [];
  const seen = new Set<string>();
  const walk = (n: FigmaNode) => {
    if (out.length >= limit || !isVisible(n)) return;
    for (const p of visiblePaints(n.fills)) {
      if (p.type === 'IMAGE' && p.imageRef && !seen.has(p.imageRef)) {
        seen.add(p.imageRef);
        out.push({ nodeId: n.id, nodeName: n.name, imageRef: p.imageRef, scaleMode: p.scaleMode });
      }
    }
    for (const c of n.children ?? []) walk(c);
  };
  walk(root);
  return out;
}

/** Every VariableID referenced in a subtree: node bindings, paint bindings, effect bindings and text styles. */
export function collectVariableIds(root: FigmaNode): Set<string> {
  const ids = new Set<string>();
  const visit = (value: unknown) => {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    const alias = value as VariableAlias;
    if (alias.type === 'VARIABLE_ALIAS' && typeof alias.id === 'string') {
      ids.add(alias.id);
      return;
    }
    for (const v of Object.values(value)) visit(v);
  };
  const walk = (n: FigmaNode) => {
    if (!isVisible(n)) return;
    visit(n.boundVariables);
    for (const p of [...(n.fills ?? []), ...(n.strokes ?? [])]) visit(p.boundVariables);
    for (const e of n.effects ?? []) visit(e.boundVariables);
    if (n.styleOverrideTable) visit(Object.values(n.styleOverrideTable).map((s) => s.boundVariables));
    for (const c of n.children ?? []) walk(c);
  };
  walk(root);
  return ids;
}

export function countNodes(root: FigmaNode): number {
  let count = 0;
  const walk = (n: FigmaNode) => {
    count++;
    for (const c of n.children ?? []) walk(c);
  };
  walk(root);
  return count;
}

export function nodeSize(node: FigmaNode): { width: number; height: number } {
  if (node.size) return { width: node.size.x, height: node.size.y };
  const box = node.absoluteBoundingBox;
  return { width: box?.width ?? 0, height: box?.height ?? 0 };
}
