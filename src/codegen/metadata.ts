import type { FigmaNode } from '../figma/types.js';
import { num, xmlEscape } from '../util.js';
import { cssColor, visiblePaints } from './paint.js';

export interface XmlOptions {
  maxNodes?: number;
  /** Include text content and fill colors (used for FigJam boards, where the text is the content). */
  rich?: boolean;
}

export interface XmlResult {
  xml: string;
  nodeCount: number;
  truncated: boolean;
}

const tagFor = (type: string) => type.toLowerCase().replace(/_/g, '-');

/**
 * Structural XML like the official get_metadata: layer type as the tag, plus id, name, and position
 * and size relative to the parent.
 */
export function nodeToXml(root: FigmaNode, opts: XmlOptions = {}): XmlResult {
  const maxNodes = opts.maxNodes ?? 5000;
  const lines: string[] = [];
  let count = 0;
  let truncated = false;

  const walk = (node: FigmaNode, parent: FigmaNode | null, depth: number) => {
    if (count >= maxNodes) {
      truncated = true;
      return;
    }
    count++;
    const indent = '  '.repeat(depth);
    const attrs: [string, string][] = [
      ['id', node.id],
      ['name', node.name],
    ];
    const box = node.absoluteBoundingBox;
    const pbox = parent?.absoluteBoundingBox;
    if (box) {
      attrs.push(['x', num(pbox ? box.x - pbox.x : box.x)], ['y', num(pbox ? box.y - pbox.y : box.y)]);
      attrs.push(['width', num(box.width)], ['height', num(box.height)]);
    }
    if (node.visible === false) attrs.push(['hidden', 'true']);
    if (opts.rich) addRichAttrs(node, attrs);

    const head = `${indent}<${tagFor(node.type)} ${attrs.map(([k, v]) => `${k}="${xmlEscape(v)}"`).join(' ')}`;
    const children = node.children ?? [];
    const text = opts.rich && node.characters ? node.characters : '';
    if (!children.length && !text) {
      lines.push(`${head} />`);
      return;
    }
    lines.push(`${head}>`);
    if (text) lines.push(`${indent}  ${xmlEscape(text).replace(/\n/g, `\n${indent}  `)}`);
    for (const child of children) walk(child, node, depth + 1);
    lines.push(`${indent}</${tagFor(node.type)}>`);
  };

  walk(root, null, 0);
  if (truncated) lines.push(`<!-- truncated after ${maxNodes} nodes; query a child node for the rest -->`);
  return { xml: lines.join('\n'), nodeCount: count, truncated };
}

function addRichAttrs(node: FigmaNode, attrs: [string, string][]) {
  const fill = visiblePaints(node.fills).find((p) => p.type === 'SOLID');
  if (fill?.color && node.type !== 'TEXT') attrs.push(['fill', cssColor(fill.color, fill.opacity ?? 1)]);
  if (typeof node.shapeType === 'string') attrs.push(['shape', node.shapeType]);
  if (node.type === 'CONNECTOR') {
    const start = node.connectorStart as { endpointNodeId?: string } | undefined;
    const end = node.connectorEnd as { endpointNodeId?: string } | undefined;
    if (start?.endpointNodeId) attrs.push(['from', start.endpointNodeId]);
    if (end?.endpointNodeId) attrs.push(['to', end.endpointNodeId]);
    if (typeof node.connectorLineType === 'string') attrs.push(['line', node.connectorLineType]);
  }
  if (typeof node.codeLanguage === 'string') attrs.push(['language', node.codeLanguage]);
  if (node.type === 'STICKY' && node.authorVisible === true && typeof node.authorName === 'string') attrs.push(['author', node.authorName]);
}

/** Top-level page listing used when get_metadata is called without a nodeId. */
export function pagesToXml(fileName: string, document: FigmaNode): string {
  const pages = (document.children ?? []).map((p) => `  <canvas id="${xmlEscape(p.id)}" name="${xmlEscape(p.name)}" />`);
  return [`<document name="${xmlEscape(fileName)}">`, ...pages, '</document>'].join('\n');
}
