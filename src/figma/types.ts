// Loose shapes for the parts of the Figma REST API this server reads.
// Figma adds fields often, so everything beyond what we touch stays open-ended.

export interface Color {
  r: number;
  g: number;
  b: number;
  a: number;
}

export interface Vector {
  x: number;
  y: number;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface VariableAlias {
  type: 'VARIABLE_ALIAS';
  id: string;
}

export interface ColorStop {
  position: number;
  color: Color;
  boundVariables?: { color?: VariableAlias };
}

export interface Paint {
  type: 'SOLID' | 'GRADIENT_LINEAR' | 'GRADIENT_RADIAL' | 'GRADIENT_ANGULAR' | 'GRADIENT_DIAMOND' | 'IMAGE' | 'EMOJI' | 'VIDEO' | 'PATTERN';
  visible?: boolean;
  opacity?: number;
  color?: Color;
  blendMode?: string;
  gradientHandlePositions?: Vector[];
  gradientStops?: ColorStop[];
  scaleMode?: 'FILL' | 'FIT' | 'TILE' | 'STRETCH' | 'CROP';
  imageRef?: string;
  boundVariables?: { color?: VariableAlias };
}

export interface Effect {
  type: 'DROP_SHADOW' | 'INNER_SHADOW' | 'LAYER_BLUR' | 'BACKGROUND_BLUR' | 'TEXTURE' | 'NOISE';
  visible?: boolean;
  radius: number;
  color?: Color;
  offset?: Vector;
  spread?: number;
  boundVariables?: Record<string, VariableAlias>;
}

export interface TypeStyle {
  fontFamily?: string;
  fontPostScriptName?: string | null;
  fontStyle?: string;
  fontWeight?: number;
  fontSize?: number;
  italic?: boolean;
  textAlignHorizontal?: 'LEFT' | 'RIGHT' | 'CENTER' | 'JUSTIFIED';
  textAlignVertical?: 'TOP' | 'CENTER' | 'BOTTOM';
  letterSpacing?: number;
  lineHeightPx?: number;
  lineHeightPercentFontSize?: number;
  lineHeightUnit?: 'PIXELS' | 'FONT_SIZE_%' | 'INTRINSIC_%';
  textCase?: 'ORIGINAL' | 'UPPER' | 'LOWER' | 'TITLE' | 'SMALL_CAPS' | 'SMALL_CAPS_FORCED';
  textDecoration?: 'NONE' | 'UNDERLINE' | 'STRIKETHROUGH';
  textAutoResize?: 'NONE' | 'HEIGHT' | 'WIDTH_AND_HEIGHT' | 'TRUNCATE';
  textTruncation?: 'DISABLED' | 'ENDING';
  maxLines?: number;
  fills?: Paint[];
  hyperlink?: { type: 'URL' | 'NODE'; url?: string; nodeID?: string };
  boundVariables?: Record<string, VariableAlias>;
}

export interface FigmaNode {
  id: string;
  name: string;
  type: string;
  visible?: boolean;
  children?: FigmaNode[];
  absoluteBoundingBox?: Rect | null;
  absoluteRenderBounds?: Rect | null;
  size?: Vector;
  relativeTransform?: number[][];
  rotation?: number;
  fills?: Paint[];
  strokes?: Paint[];
  strokeWeight?: number;
  individualStrokeWeights?: { top: number; right: number; bottom: number; left: number };
  strokeAlign?: 'INSIDE' | 'OUTSIDE' | 'CENTER';
  strokeDashes?: number[];
  cornerRadius?: number;
  rectangleCornerRadii?: [number, number, number, number];
  effects?: Effect[];
  opacity?: number;
  blendMode?: string;
  clipsContent?: boolean;
  isMask?: boolean;
  layoutMode?: 'NONE' | 'HORIZONTAL' | 'VERTICAL' | 'GRID';
  layoutWrap?: 'NO_WRAP' | 'WRAP';
  layoutPositioning?: 'AUTO' | 'ABSOLUTE';
  layoutSizingHorizontal?: 'FIXED' | 'HUG' | 'FILL';
  layoutSizingVertical?: 'FIXED' | 'HUG' | 'FILL';
  layoutGrow?: number;
  layoutAlign?: 'INHERIT' | 'STRETCH' | 'MIN' | 'CENTER' | 'MAX';
  primaryAxisSizingMode?: 'FIXED' | 'AUTO';
  counterAxisSizingMode?: 'FIXED' | 'AUTO';
  primaryAxisAlignItems?: 'MIN' | 'CENTER' | 'MAX' | 'SPACE_BETWEEN';
  counterAxisAlignItems?: 'MIN' | 'CENTER' | 'MAX' | 'BASELINE';
  counterAxisAlignContent?: 'AUTO' | 'SPACE_BETWEEN';
  itemSpacing?: number;
  counterAxisSpacing?: number;
  paddingLeft?: number;
  paddingRight?: number;
  paddingTop?: number;
  paddingBottom?: number;
  gridRowCount?: number;
  gridColumnCount?: number;
  gridRowGap?: number;
  gridColumnGap?: number;
  minWidth?: number | null;
  maxWidth?: number | null;
  minHeight?: number | null;
  maxHeight?: number | null;
  constraints?: { horizontal: 'LEFT' | 'RIGHT' | 'CENTER' | 'LEFT_RIGHT' | 'SCALE'; vertical: 'TOP' | 'BOTTOM' | 'CENTER' | 'TOP_BOTTOM' | 'SCALE' };
  characters?: string;
  style?: TypeStyle;
  characterStyleOverrides?: number[];
  styleOverrideTable?: Record<string, TypeStyle>;
  styles?: Record<string, string>;
  boundVariables?: Record<string, VariableAlias | VariableAlias[] | Record<string, VariableAlias>>;
  componentId?: string;
  componentProperties?: Record<string, { type: string; value: string | boolean; boundVariables?: unknown }>;
  componentPropertyDefinitions?: Record<string, { type: string; defaultValue: string | boolean; variantOptions?: string[] }>;
  exportSettings?: { suffix: string; format: 'JPG' | 'PNG' | 'SVG' | 'PDF'; constraint: { type: 'SCALE' | 'WIDTH' | 'HEIGHT'; value: number } }[];
  [key: string]: unknown;
}

export interface ComponentMeta {
  key: string;
  name: string;
  description?: string;
  componentSetId?: string;
  remote?: boolean;
  documentationLinks?: { uri: string }[];
}

export interface StyleMeta {
  key: string;
  name: string;
  styleType: 'FILL' | 'TEXT' | 'EFFECT' | 'GRID';
  remote?: boolean;
  description?: string;
}

export interface NodesResponse {
  name: string;
  lastModified: string;
  editorType?: string;
  thumbnailUrl?: string;
  version?: string;
  nodes: Record<
    string,
    {
      document: FigmaNode;
      components: Record<string, ComponentMeta>;
      componentSets: Record<string, ComponentMeta>;
      styles: Record<string, StyleMeta>;
    } | null
  >;
}

export interface FileResponse {
  name: string;
  lastModified: string;
  editorType?: string;
  version?: string;
  document: FigmaNode;
  components: Record<string, ComponentMeta>;
  componentSets: Record<string, ComponentMeta>;
  styles: Record<string, StyleMeta>;
}

/** Item shape returned by the published-library endpoints (files/:key/components, teams/:id/styles, ...). */
export interface PublishedAsset {
  key: string;
  file_key: string;
  node_id: string;
  name: string;
  description?: string;
  thumbnail_url?: string;
  style_type?: StyleMeta['styleType'];
  containing_frame?: { name?: string; nodeId?: string; pageName?: string; containingComponentSet?: { name?: string; nodeId?: string } };
}

export interface RestVariable {
  id: string;
  name: string;
  key: string;
  variableCollectionId: string;
  resolvedType: 'BOOLEAN' | 'FLOAT' | 'STRING' | 'COLOR';
  valuesByMode: Record<string, unknown>;
  remote?: boolean;
}

export interface RestVariableCollection {
  id: string;
  name: string;
  defaultModeId: string;
  modes: { modeId: string; name: string }[];
}
