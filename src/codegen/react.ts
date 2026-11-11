import type { ComponentMeta, Effect, FigmaNode, Paint, StyleMeta, TypeStyle, VariableAlias } from '../figma/types.js';
import { kebabCase, num, pascalCase, px } from '../util.js';
import { cssColor, gradientCss, visiblePaints } from './paint.js';
import { hasImageFill, isSvgAsset, isVisible, nodeSize, visibleChildren } from './nodes.js';

/**
 * Figma node tree -> React + Tailwind reference code, in the spirit of the official server's
 * get_design_context output: absolute values in arbitrary-value classes, `var(--token,fallback)`
 * where a variable is bound, data-node-id on every element, and assets hoisted to consts.
 */

export interface VariableInfo {
  name: string;
  value?: string;
  /** Designer-set web code syntax such as "var(--color-bg)"; preferred over a name-derived token. */
  webSyntax?: string;
}

export interface CodegenContext {
  components: Record<string, ComponentMeta>;
  componentSets: Record<string, ComponentMeta>;
  styles: Record<string, StyleMeta>;
  variables: Map<string, VariableInfo>;
  maxNodes?: number;
}

export interface AssetRequest {
  varName: string;
  nodeId: string;
  nodeName: string;
  kind: 'svg' | 'image';
  imageRef?: string;
}

export interface InstanceInfo {
  nodeId: string;
  name: string;
  componentId?: string;
  componentName?: string;
  componentSetName?: string;
  componentKey?: string;
  remote?: boolean;
  properties: Record<string, string | boolean>;
}

export interface CodegenResult {
  componentName: string;
  jsx: string;
  assets: AssetRequest[];
  instances: InstanceInfo[];
  nodeCount: number;
  truncated: boolean;
}

type Sizing = 'FIXED' | 'HUG' | 'FILL';
type Axis = 'h' | 'v';

const BLEND: Record<string, string> = {
  MULTIPLY: 'multiply',
  SCREEN: 'screen',
  OVERLAY: 'overlay',
  DARKEN: 'darken',
  LIGHTEN: 'lighten',
  COLOR_DODGE: 'color-dodge',
  COLOR_BURN: 'color-burn',
  HARD_LIGHT: 'hard-light',
  SOFT_LIGHT: 'soft-light',
  DIFFERENCE: 'difference',
  EXCLUSION: 'exclusion',
  HUE: 'hue',
  SATURATION: 'saturation',
  COLOR: 'color',
  LUMINOSITY: 'luminosity',
};

function asAlias(value: unknown): VariableAlias | undefined {
  if (Array.isArray(value)) return asAlias(value[0]);
  if (value && typeof value === 'object' && (value as VariableAlias).type === 'VARIABLE_ALIAS') return value as VariableAlias;
  return undefined;
}

function primaryAxis(node: FigmaNode | null | undefined): Axis | null {
  if (node?.layoutMode === 'HORIZONTAL') return 'h';
  if (node?.layoutMode === 'VERTICAL') return 'v';
  return null;
}

function isAutoLayout(node: FigmaNode | null | undefined): boolean {
  return node?.layoutMode === 'HORIZONTAL' || node?.layoutMode === 'VERTICAL' || node?.layoutMode === 'GRID';
}

function sizing(node: FigmaNode, axis: Axis, parent: FigmaNode | null): Sizing {
  const explicit = axis === 'h' ? node.layoutSizingHorizontal : node.layoutSizingVertical;
  if (explicit) return explicit;
  const parentAxis = primaryAxis(parent);
  if (parentAxis) {
    if (axis === parentAxis && node.layoutGrow === 1) return 'FILL';
    if (axis !== parentAxis && node.layoutAlign === 'STRETCH') return 'FILL';
  }
  if (node.type === 'TEXT') {
    const resize = node.style?.textAutoResize;
    if (resize === 'WIDTH_AND_HEIGHT') return 'HUG';
    if (resize === 'HEIGHT' && axis === 'v') return 'HUG';
    return 'FIXED';
  }
  const own = primaryAxis(node);
  if (own) {
    const mode = axis === own ? node.primaryAxisSizingMode : node.counterAxisSizingMode;
    if (mode === 'AUTO') return 'HUG';
  }
  return 'FIXED';
}

/**
 * Tailwind cannot infer the type of an arbitrary value that is a CSS variable, so add a type hint
 * (e.g. text-[length:var(--size,16px)]) only in that case.
 */
function hint(type: 'color' | 'length' | 'number', value: string): string {
  return value.startsWith('var(') ? `${type}:${value}` : value;
}

function jsxText(s: string): string {
  return /[{}<>]/.test(s) ? `{${JSON.stringify(s)}}` : s;
}

function jsxAttr(name: string, value: string): string {
  return value.includes('"') ? `${name}={${JSON.stringify(value)}}` : `${name}="${value}"`;
}

function styleAttr(style: Record<string, string>): string {
  const entries = Object.entries(style);
  if (!entries.length) return '';
  return ` style={{ ${entries.map(([k, v]) => `${k}: ${v.startsWith('`') ? v : JSON.stringify(v)}`).join(', ')} }}`;
}

/** Compress four box values into the shortest Tailwind form (p-, px-/py-, or per side). */
function boxClasses(prefix: string, top: string, right: string, bottom: string, left: string): string[] {
  const zero = (v: string) => v === '0px';
  if ([top, right, bottom, left].every(zero)) return [];
  if (top === right && right === bottom && bottom === left) return [`${prefix}-[${top}]`];
  if (top === bottom && left === right) {
    return [...(zero(left) ? [] : [`${prefix}x-[${left}]`]), ...(zero(top) ? [] : [`${prefix}y-[${top}]`])];
  }
  const out: string[] = [];
  if (!zero(top)) out.push(`${prefix}t-[${top}]`);
  if (!zero(right)) out.push(`${prefix}r-[${right}]`);
  if (!zero(bottom)) out.push(`${prefix}b-[${bottom}]`);
  if (!zero(left)) out.push(`${prefix}l-[${left}]`);
  return out;
}

class Generator {
  readonly assets: AssetRequest[] = [];
  readonly instances: InstanceInfo[] = [];
  private assetNames = new Set<string>();
  private imageVars = new Map<string, string>();
  count = 0;
  truncated = false;

  constructor(private ctx: CodegenContext) {}

  /** `fallback` wrapped as var(--token,fallback) when the alias resolves to a known variable. */
  private tok(alias: VariableAlias | undefined, fallback: string): string {
    if (!alias) return fallback;
    const info = this.ctx.variables.get(alias.id);
    if (!info) return fallback;
    const fromSyntax = info.webSyntax?.match(/^(?:var\(\s*)?(--[\w-]+)/)?.[1];
    return `var(${fromSyntax ?? `--${kebabCase(info.name)}`},${fallback})`;
  }

  private bound(node: FigmaNode, field: string): VariableAlias | undefined {
    return asAlias(node.boundVariables?.[field]);
  }

  private paintColor(paint: Paint): string | null {
    if (paint.type !== 'SOLID' || !paint.color) return null;
    return this.tok(paint.boundVariables?.color, cssColor(paint.color, paint.opacity ?? 1));
  }

  private assetVar(node: FigmaNode, kind: 'svg' | 'image', imageRef?: string): string {
    if (kind === 'image' && imageRef && this.imageVars.has(imageRef)) return this.imageVars.get(imageRef)!;
    const base = 'img' + pascalCase(node.name, kind === 'svg' ? 'Vector' : 'Image');
    let name = base;
    for (let i = 2; this.assetNames.has(name); i++) name = `${base}${i}`;
    this.assetNames.add(name);
    this.assets.push({ varName: name, nodeId: node.id, nodeName: node.name, kind, imageRef });
    if (kind === 'image' && imageRef) this.imageVars.set(imageRef, name);
    return name;
  }

  // ---------- layout ----------

  private sizeClasses(w: number, h: number, sw: Sizing, sh: Sizing, wantW = true, wantH = true): string[] {
    const fixedW = wantW && sw === 'FIXED';
    const fixedH = wantH && sh === 'FIXED';
    if (fixedW && fixedH && num(w) === num(h)) return [`size-[${px(w)}]`];
    return [...(fixedW ? [`w-[${px(w)}]`] : []), ...(fixedH ? [`h-[${px(h)}]`] : [])];
  }

  private minMax(node: FigmaNode): string[] {
    const out: string[] = [];
    if (node.minWidth) out.push(`min-w-[${px(node.minWidth)}]`);
    if (node.maxWidth) out.push(`max-w-[${px(node.maxWidth)}]`);
    if (node.minHeight) out.push(`min-h-[${px(node.minHeight)}]`);
    if (node.maxHeight) out.push(`max-h-[${px(node.maxHeight)}]`);
    return out;
  }

  /** How the node sits inside its parent: flex child, absolutely positioned, or the root. */
  private placement(node: FigmaNode, parent: FigmaNode | null): string[] {
    const { width: w, height: h } = nodeSize(node);
    const sw = sizing(node, 'h', parent);
    const sh = sizing(node, 'v', parent);

    if (!parent) {
      return ['relative', ...this.sizeClasses(w, h, sw === 'FILL' ? 'FIXED' : sw, sh === 'FILL' ? 'FIXED' : sh), ...this.minMax(node)];
    }

    if (isAutoLayout(parent) && node.layoutPositioning !== 'ABSOLUTE') {
      const axis = primaryAxis(parent);
      const out = ['relative'];
      const fill = (a: Axis) => (a === 'h' ? sw : sh) === 'FILL';
      if (axis) {
        const cross: Axis = axis === 'h' ? 'v' : 'h';
        if (fill(axis)) out.push('flex-[1_0_0]', axis === 'h' ? 'min-w-px' : 'min-h-px');
        else out.push('shrink-0');
        if (fill(cross)) out.push('self-stretch');
      } else {
        out.push('shrink-0');
        if (fill('h')) out.push('w-full');
        if (fill('v')) out.push('h-full');
      }
      out.push(...this.sizeClasses(w, h, sw, sh));
      out.push(...this.minMax(node));
      return out;
    }

    // Absolute positioning relative to the parent's box, honoring constraints where they map cleanly.
    const pb = parent.absoluteBoundingBox;
    const nb = node.absoluteBoundingBox;
    const pw = pb?.width ?? 0;
    const ph = pb?.height ?? 0;
    let x = nb && pb ? nb.x - pb.x : 0;
    let y = nb && pb ? nb.y - pb.y : 0;
    const out = ['absolute'];

    const rotation = this.rotationDeg(node);
    if (rotation && node.size && nb) {
      // The bounding box is the rotated extent; place the unrotated box at the same center.
      x += nb.width / 2 - w / 2;
      y += nb.height / 2 - h / 2;
    }

    const groupParent = parent.type === 'GROUP' || parent.type === 'BOOLEAN_OPERATION';
    const hc = groupParent ? 'LEFT' : node.constraints?.horizontal ?? 'LEFT';
    const vc = groupParent ? 'TOP' : node.constraints?.vertical ?? 'TOP';
    let wantW = true;
    let wantH = true;

    switch (hc) {
      case 'RIGHT':
        out.push(`right-[${px(pw - x - w)}]`);
        break;
      case 'LEFT_RIGHT':
        out.push(`left-[${px(x)}]`, `right-[${px(pw - x - w)}]`);
        wantW = false;
        break;
      case 'CENTER': {
        const offset = x + w / 2 - pw / 2;
        out.push(offset ? `left-[calc(50%+${px(offset)})]` : 'left-1/2', '-translate-x-1/2');
        break;
      }
      case 'SCALE':
        if (pw) {
          out.push(`left-[${num((x / pw) * 100)}%]`, `w-[${num((w / pw) * 100)}%]`);
          wantW = false;
        } else out.push(`left-[${px(x)}]`);
        break;
      default:
        out.push(`left-[${px(x)}]`);
    }
    switch (vc) {
      case 'BOTTOM':
        out.push(`bottom-[${px(ph - y - h)}]`);
        break;
      case 'TOP_BOTTOM':
        out.push(`top-[${px(y)}]`, `bottom-[${px(ph - y - h)}]`);
        wantH = false;
        break;
      case 'CENTER': {
        const offset = y + h / 2 - ph / 2;
        out.push(offset ? `top-[calc(50%+${px(offset)})]` : 'top-1/2', '-translate-y-1/2');
        break;
      }
      case 'SCALE':
        if (ph) {
          out.push(`top-[${num((y / ph) * 100)}%]`, `h-[${num((h / ph) * 100)}%]`);
          wantH = false;
        } else out.push(`top-[${px(y)}]`);
        break;
      default:
        out.push(`top-[${px(y)}]`);
    }
    out.push(...this.sizeClasses(w, h, sw === 'FILL' ? 'FIXED' : sw, sh === 'FILL' ? 'FIXED' : sh, wantW, wantH));
    out.push(...this.minMax(node));
    return out;
  }

  private rotationDeg(node: FigmaNode): number {
    const m = node.relativeTransform;
    if (!m) return 0;
    const deg = (Math.atan2(m[1][0], m[0][0]) * 180) / Math.PI;
    return Math.abs(deg) < 0.01 ? 0 : deg;
  }

  /** The node's own layout for its children (flex/grid, gap, padding, alignment). */
  private containerLayout(node: FigmaNode): string[] {
    const pad = () =>
      boxClasses(
        'p',
        this.tok(this.bound(node, 'paddingTop'), px(node.paddingTop ?? 0)),
        this.tok(this.bound(node, 'paddingRight'), px(node.paddingRight ?? 0)),
        this.tok(this.bound(node, 'paddingBottom'), px(node.paddingBottom ?? 0)),
        this.tok(this.bound(node, 'paddingLeft'), px(node.paddingLeft ?? 0)),
      );

    if (node.layoutMode === 'GRID') {
      const out = ['grid'];
      if (node.gridColumnCount) out.push(`grid-cols-[repeat(${node.gridColumnCount},minmax(0,1fr))]`);
      if (node.gridRowCount) out.push(`grid-rows-[repeat(${node.gridRowCount},minmax(0,1fr))]`);
      if (node.gridColumnGap) out.push(`gap-x-[${px(node.gridColumnGap)}]`);
      if (node.gridRowGap) out.push(`gap-y-[${px(node.gridRowGap)}]`);
      return [...out, ...pad()];
    }

    const axis = primaryAxis(node);
    if (!axis) return [];
    const out = ['flex', axis === 'h' ? 'flex-row' : 'flex-col'];
    const between = node.primaryAxisAlignItems === 'SPACE_BETWEEN';
    const gap = this.tok(this.bound(node, 'itemSpacing'), px(node.itemSpacing ?? 0));
    if (node.layoutWrap === 'WRAP') {
      out.push('flex-wrap');
      const crossGap = this.tok(this.bound(node, 'counterAxisSpacing'), px(node.counterAxisSpacing ?? node.itemSpacing ?? 0));
      const [gx, gy] = axis === 'h' ? [gap, crossGap] : [crossGap, gap];
      if (!between && gx !== '0px') out.push(`gap-x-[${gx}]`);
      if (gy !== '0px') out.push(`gap-y-[${gy}]`);
      if (node.counterAxisAlignContent === 'SPACE_BETWEEN') out.push('content-between');
    } else if (!between && gap !== '0px') {
      out.push(`gap-[${gap}]`);
    }
    out.push(
      { MIN: 'items-start', CENTER: 'items-center', MAX: 'items-end', BASELINE: 'items-baseline' }[node.counterAxisAlignItems ?? 'MIN'],
    );
    const justify = { MIN: '', CENTER: 'justify-center', MAX: 'justify-end', SPACE_BETWEEN: 'justify-between' }[node.primaryAxisAlignItems ?? 'MIN'];
    if (justify) out.push(justify);
    return [...out, ...pad()];
  }

  // ---------- visuals ----------

  private radius(node: FigmaNode): string[] {
    if (node.type === 'ELLIPSE') return ['rounded-[50%]'];
    const corners = ['topLeftRadius', 'topRightRadius', 'bottomRightRadius', 'bottomLeftRadius'];
    // Figma's JSON nests radius bindings as boundVariables.rectangleCornerRadii.RECTANGLE_TOP_LEFT_CORNER_RADIUS, etc.
    const restCorners = ['TOP_LEFT', 'TOP_RIGHT', 'BOTTOM_RIGHT', 'BOTTOM_LEFT'].map((c) => `RECTANGLE_${c}_CORNER_RADIUS`);
    const nested = node.boundVariables?.rectangleCornerRadii as Record<string, VariableAlias> | undefined;
    const raw = node.rectangleCornerRadii ?? (node.cornerRadius ? [node.cornerRadius, node.cornerRadius, node.cornerRadius, node.cornerRadius] : null);
    if (!raw || raw.every((r) => !r)) return [];
    const vals = raw.map((r, i) => this.tok(this.bound(node, corners[i]) ?? asAlias(nested?.[restCorners[i]]), px(r)));
    if (vals.every((v) => v === vals[0])) return [`rounded-[${vals[0]}]`];
    return ['tl', 'tr', 'br', 'bl'].map((c, i) => (raw[i] ? `rounded-${c}-[${vals[i]}]` : '')).filter(Boolean);
  }

  private background(node: FigmaNode, classes: string[], style: Record<string, string>) {
    const paints = visiblePaints(node.fills).filter((p) => p.type !== 'IMAGE');
    if (!paints.length) return;
    const { width, height } = nodeSize(node);
    if (paints.length === 1 && paints[0].type === 'SOLID') {
      const c = this.paintColor(paints[0]);
      if (c) classes.push(`bg-[${hint('color', c)}]`);
      return;
    }
    // Figma stacks paints bottom-to-top; CSS lists background layers top-first.
    const layers: string[] = [];
    let base: string | undefined;
    paints.forEach((p, i) => {
      if (p.type === 'SOLID') {
        const c = this.paintColor(p)!;
        if (i === 0) base = c;
        else layers.unshift(`linear-gradient(${c}, ${c})`);
      } else {
        const g = gradientCss(p, width, height, (c, si) => this.tok(p.gradientStops?.[si]?.boundVariables?.color, cssColor(c, p.opacity ?? 1)));
        if (g) layers.unshift(g);
      }
    });
    if (base) classes.push(`bg-[${hint('color', base)}]`);
    if (layers.length) style.backgroundImage = layers.join(', ');
  }

  private border(node: FigmaNode): string[] {
    const paint = visiblePaints(node.strokes)[0];
    if (!paint) return [];
    const color =
      paint.type === 'SOLID'
        ? this.paintColor(paint)
        : paint.gradientStops?.[0]
          ? cssColor(paint.gradientStops[0].color, paint.opacity ?? 1)
          : null;
    if (!color) return [];
    const dashed = node.strokeDashes?.length ? 'dashed' : 'solid';
    if (node.strokeAlign === 'OUTSIDE') {
      return ['outline', `outline-[${px(node.strokeWeight ?? 1)}]`, `outline-[${hint('color', color)}]`, dashed === 'dashed' ? 'outline-dashed' : 'outline-solid'];
    }
    const sides = node.individualStrokeWeights;
    let widths: string[];
    if (sides && !(sides.top === sides.right && sides.right === sides.bottom && sides.bottom === sides.left)) {
      widths = (
        [
          ['t', sides.top],
          ['r', sides.right],
          ['b', sides.bottom],
          ['l', sides.left],
        ] as const
      )
        .filter(([, w]) => w > 0)
        .map(([side, w]) => `border-${side}-[${px(w)}]`);
    } else {
      const w = sides ? sides.top : node.strokeWeight;
      widths = w ? [`border-[${px(w)}]`] : [];
    }
    if (!widths.length) return [];
    return [...widths, `border-[${hint('color', color)}]`, `border-${dashed}`];
  }

  private effects(node: FigmaNode, text = false): string[] {
    const fx = (node.effects ?? []).filter((e: Effect) => e.visible !== false);
    const out: string[] = [];
    const shadows = fx
      .filter((e) => e.type === 'DROP_SHADOW' || (e.type === 'INNER_SHADOW' && !text))
      .map((e) => {
        const color = this.tok(asAlias(e.boundVariables?.color), cssColor(e.color ?? { r: 0, g: 0, b: 0, a: 0.25 }));
        const parts = [px(e.offset?.x ?? 0), px(e.offset?.y ?? 0), px(e.radius)];
        if (!text) parts.push(px(e.spread ?? 0));
        return `${e.type === 'INNER_SHADOW' ? 'inset_' : ''}${parts.join('_')}_${color}`;
      });
    if (shadows.length) out.push(text ? `[text-shadow:${shadows.join(',')}]` : `shadow-[${shadows.join(',')}]`);
    const blur = fx.find((e) => e.type === 'LAYER_BLUR');
    if (blur) out.push(`blur-[${px(blur.radius / 2)}]`);
    const bgBlur = fx.find((e) => e.type === 'BACKGROUND_BLUR');
    if (bgBlur) out.push(`backdrop-blur-[${px(bgBlur.radius / 2)}]`);
    return out;
  }

  private common(node: FigmaNode): string[] {
    const out: string[] = [];
    const opacity = node.opacity ?? 1;
    if (opacity < 1 || this.bound(node, 'opacity')) out.push(`opacity-[${this.tok(this.bound(node, 'opacity'), num(opacity))}]`);
    const blend = node.blendMode ? BLEND[node.blendMode] : undefined;
    if (blend) out.push(`mix-blend-${blend}`);
    const rot = this.rotationDeg(node);
    if (rot && node.size) out.push(`rotate-[${num(rot)}deg]`);
    return out;
  }

  // ---------- text ----------

  private textStyleClasses(s: TypeStyle, bound: (field: string) => VariableAlias | undefined, base?: TypeStyle): string[] {
    const out: string[] = [];
    const differs = <K extends keyof TypeStyle>(k: K) => !base || s[k] !== base[k];
    if (s.fontFamily && differs('fontFamily')) out.push(`font-['${s.fontFamily.replace(/ /g, '_')}',sans-serif]`);
    if (s.fontWeight && differs('fontWeight')) out.push(`font-[${hint('number', this.tok(bound('fontWeight'), String(s.fontWeight)))}]`);
    if (s.italic && differs('italic')) out.push('italic');
    if (s.fontSize && differs('fontSize')) out.push(`text-[${hint('length', this.tok(bound('fontSize'), px(s.fontSize)))}]`);
    if (differs('lineHeightPx') || differs('lineHeightUnit')) {
      if (s.lineHeightUnit === 'INTRINSIC_%') out.push('leading-[normal]');
      else if (s.lineHeightUnit === 'FONT_SIZE_%' && s.lineHeightPercentFontSize) out.push(`leading-[${num(s.lineHeightPercentFontSize / 100)}]`);
      else if (s.lineHeightPx) out.push(`leading-[${this.tok(bound('lineHeight'), px(s.lineHeightPx))}]`);
    }
    if (s.letterSpacing && differs('letterSpacing')) out.push(`tracking-[${this.tok(bound('letterSpacing'), px(s.letterSpacing))}]`);
    if (differs('textCase')) {
      const cases: Record<string, string> = {
        UPPER: 'uppercase',
        LOWER: 'lowercase',
        TITLE: 'capitalize',
        SMALL_CAPS: '[font-variant:small-caps]',
        SMALL_CAPS_FORCED: '[font-variant:all-small-caps]',
      };
      const tc = cases[s.textCase ?? 'ORIGINAL'];
      if (tc) out.push(tc);
    }
    if (differs('textDecoration')) {
      if (s.textDecoration === 'UNDERLINE') out.push('underline');
      if (s.textDecoration === 'STRIKETHROUGH') out.push('line-through');
    }
    return out;
  }

  private textFill(fills: Paint[] | undefined, classes: string[], style: Record<string, string>, width: number, height: number) {
    const paint = visiblePaints(fills)[0];
    if (!paint) return;
    if (paint.type === 'SOLID') {
      const c = this.paintColor(paint);
      if (c) classes.push(`text-[${hint('color', c)}]`);
    } else if (paint.type.startsWith('GRADIENT')) {
      const g = gradientCss(paint, width, height);
      if (g) {
        classes.push('bg-clip-text', 'text-transparent');
        style.backgroundImage = g;
      }
    }
  }

  private textContent(node: FigmaNode): string {
    const chars = node.characters ?? '';
    const overrides = node.characterStyleOverrides ?? [];
    const table = node.styleOverrideTable ?? {};
    const base = node.style ?? {};

    const segments: { text: string; id: number }[] = [];
    for (let i = 0; i < chars.length; i++) {
      const id = overrides[i] ?? 0;
      const last = segments[segments.length - 1];
      if (last && last.id === id) last.text += chars[i];
      else segments.push({ text: chars[i], id });
    }

    const lines = (text: string) =>
      text
        .split('\n')
        .map(jsxText)
        .join('<br />');

    return segments
      .map(({ text, id }) => {
        const override = id ? table[String(id)] : undefined;
        if (!override) return lines(text);
        const merged: TypeStyle = { ...base, ...override };
        const classes = this.textStyleClasses(merged, (f) => asAlias(override.boundVariables?.[f]), base);
        const style: Record<string, string> = {};
        if (override.fills) this.textFill(override.fills, classes, style, 0, 0);
        const link = override.hyperlink?.url;
        const tag = link ? 'a' : 'span';
        const attrs = (classes.length ? ` className="${classes.join(' ')}"` : '') + styleAttr(style) + (link ? ` ${jsxAttr('href', link)}` : '');
        return `<${tag}${attrs}>${lines(text)}</${tag}>`;
      })
      .join('');
  }

  private renderText(node: FigmaNode, parent: FigmaNode | null, indent: string): string[] {
    const s = node.style ?? {};
    const { width, height } = nodeSize(node);
    const classes = [...this.placement(node, parent)];
    const style: Record<string, string> = {};
    const bound = (f: string) => this.bound(node, f);

    classes.push(...this.textStyleClasses(s, bound));
    this.textFill(node.fills, classes, style, width, height);
    if (s.textAlignHorizontal && s.textAlignHorizontal !== 'LEFT') {
      classes.push({ CENTER: 'text-center', RIGHT: 'text-right', JUSTIFIED: 'text-justify' }[s.textAlignHorizontal]);
    }
    const hug = sizing(node, 'h', parent) === 'HUG';
    const preserveSpaces = /(^ | $| {2})/m.test(node.characters ?? '');
    if (hug) classes.push(preserveSpaces ? 'whitespace-pre' : 'whitespace-nowrap');
    else if (preserveSpaces) classes.push('whitespace-pre-wrap');
    if (s.textTruncation === 'ENDING') classes.push(s.maxLines && s.maxLines > 1 ? `line-clamp-${s.maxLines}` : 'truncate');
    classes.push(...this.effects(node, true), ...this.common(node));

    const vertical = s.textAlignVertical && s.textAlignVertical !== 'TOP' && sizing(node, 'v', parent) !== 'HUG';
    if (vertical) classes.push('flex', 'flex-col', s.textAlignVertical === 'CENTER' ? 'justify-center' : 'justify-end');

    const link = s.hyperlink?.url;
    const tag = vertical ? 'div' : link ? 'a' : 'p';
    const content = this.textContent(node);
    const inner = vertical ? `<p>${content}</p>` : content;
    const attrs = this.attrs(node, classes, style) + (link && !vertical ? ` ${jsxAttr('href', link)}` : '');
    return [`${indent}<${tag}${attrs}>${inner}</${tag}>`];
  }

  // ---------- elements ----------

  private attrs(node: FigmaNode, classes: string[], style: Record<string, string>): string {
    const cls = [...new Set(classes.filter(Boolean))].join(' ');
    return `${cls ? ` className="${cls}"` : ''}${styleAttr(style)} ${jsxAttr('data-name', node.name)} data-node-id="${node.id}"`;
  }

  private recordInstance(node: FigmaNode) {
    const comp = node.componentId ? this.ctx.components[node.componentId] : undefined;
    const set = comp?.componentSetId ? this.ctx.componentSets[comp.componentSetId] : undefined;
    const properties: Record<string, string | boolean> = {};
    for (const [key, prop] of Object.entries(node.componentProperties ?? {})) properties[key.replace(/#[^#]*$/, '')] = prop.value;
    this.instances.push({
      nodeId: node.id,
      name: node.name,
      componentId: node.componentId,
      componentName: comp?.name,
      componentSetName: set?.name,
      componentKey: comp?.key,
      remote: comp?.remote,
      properties,
    });
  }

  render(node: FigmaNode, parent: FigmaNode | null, indent: string): string[] {
    if (!isVisible(node)) return [];
    if (this.ctx.maxNodes && this.count >= this.ctx.maxNodes) {
      this.truncated = true;
      return [];
    }
    this.count++;
    if (node.type === 'INSTANCE') this.recordInstance(node);
    if (node.type === 'TEXT') return this.renderText(node, parent, indent);

    if (isSvgAsset(node)) {
      const v = this.assetVar(node, 'svg');
      const classes = this.placement(node, parent);
      return [
        `${indent}<div${this.attrs(node, classes, {})}>`,
        `${indent}  <img alt="" className="block max-w-none size-full" src={${v}} />`,
        `${indent}</div>`,
      ];
    }

    const classes = this.placement(node, parent);
    const style: Record<string, string> = {};
    classes.push(...this.containerLayout(node));
    this.background(node, classes, style);
    classes.push(...this.border(node), ...this.radius(node), ...this.effects(node), ...this.common(node));
    if (node.clipsContent) classes.push('overflow-clip');

    const children: string[] = [];
    const image = [...visiblePaints(node.fills)].reverse().find((p) => p.type === 'IMAGE');
    if (image && hasImageFill(node)) {
      const v = this.assetVar(node, 'image', image.imageRef);
      const fit = { FIT: 'object-contain', STRETCH: 'object-fill', TILE: 'object-none', FILL: 'object-cover', CROP: 'object-cover' }[image.scaleMode ?? 'FILL'];
      const radius = this.radius(node);
      if (radius.length) classes.push('overflow-hidden');
      children.push(`${indent}  <img alt="" className="absolute inset-0 max-w-none pointer-events-none size-full ${fit}" src={${v}} />`);
    }

    const kids = visibleChildren(node);
    for (const child of kids) children.push(...this.render(child, node, indent + '  '));
    if (this.truncated && kids.length && node === this.rootNode) {
      children.push(`${indent}  {/* Output truncated: too many layers. Request design context for a child node to get the rest. */}`);
    }

    const open = `${indent}<div${this.attrs(node, classes, style)}`;
    if (!children.length) return [`${open} />`];
    return [`${open}>`, ...children, `${indent}</div>`];
  }

  rootNode?: FigmaNode;
}

export function generateReact(root: FigmaNode, ctx: CodegenContext): CodegenResult {
  const gen = new Generator(ctx);
  gen.rootNode = root;
  const componentName = pascalCase(root.name);
  const lines = gen.render(root, null, '    ');
  const jsx = [`export default function ${componentName}() {`, '  return (', ...lines, '  );', '}'].join('\n');
  return { componentName, jsx, assets: gen.assets, instances: gen.instances, nodeCount: gen.count, truncated: gen.truncated };
}

/** Prepend asset constants to the component. Missing URLs stay as empty strings with a note. */
export function renderModule(result: CodegenResult, urls: Record<string, string | null | undefined>): string {
  const consts = result.assets.map((a) => {
    const url = urls[a.varName];
    return url ? `const ${a.varName} = ${JSON.stringify(url)};` : `const ${a.varName} = ""; // could not render ${a.kind} for node ${a.nodeId}`;
  });
  return [...consts, ...(consts.length ? [''] : []), result.jsx].join('\n');
}
