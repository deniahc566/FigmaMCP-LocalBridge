import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { nodeToXml } from '../dist/codegen/metadata.js';
import { collectImageFills, collectSvgNodes, collectVariableIds } from '../dist/codegen/nodes.js';
import { generateReact, renderModule } from '../dist/codegen/react.js';
import { normalizeNodeId, parseFigmaUrl, resolveTarget } from '../dist/figma/ids.js';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/card.json', import.meta.url), 'utf8'));
const entry = fixture.nodes['1:2'];
const ctx = (variables = new Map()) => ({
  components: entry.components,
  componentSets: entry.componentSets,
  styles: entry.styles,
  variables,
});

test('parses design, branch and board URLs', () => {
  assert.deepEqual(parseFigmaUrl('https://www.figma.com/design/AbC123xyz/My-File?node-id=12-34&t=x'), {
    fileKey: 'AbC123xyz',
    kind: 'design',
    nodeId: '12:34',
  });
  assert.equal(parseFigmaUrl('https://figma.com/design/MAIN/branch/BRANCHKEY/File')?.fileKey, 'BRANCHKEY');
  assert.equal(parseFigmaUrl('https://figma.com/board/BOARD/Retro?node-id=0-1')?.kind, 'board');
  assert.equal(parseFigmaUrl('https://example.com/design/x/y'), null);
  assert.equal(normalizeNodeId('I1-7;10-2'), 'I1:7;10:2');
  assert.deepEqual(resolveTarget('https://figma.com/design/KEY/F?node-id=1-2'), { fileKey: 'KEY', nodeId: '1:2', kind: 'design' });
});

test('generates flex layout, sizing and visuals from auto layout', () => {
  const { jsx } = generateReact(entry.document, ctx());
  assert.match(jsx, /export default function ProductCard\(\)/);
  const root = jsx.split('\n').find((l) => l.includes('data-node-id="1:2"'));
  for (const cls of ['flex', 'flex-col', 'gap-[16px]', 'items-start', 'p-[24px]', 'w-[320px]', 'bg-[#ffffff]', 'rounded-[12px]', 'border-[1px]', 'border-[#e6e6e6]', 'overflow-clip']) {
    assert.ok(root.includes(cls), `root missing ${cls}: ${root}`);
  }
  assert.ok(root.includes('shadow-[0px_4px_16px_0px_rgba(0,0,0,0.08)]'), root);
  assert.ok(!root.includes('h-['), 'hug height should not be fixed');
  // FILL child in a vertical parent stretches across; hug children keep their size.
  assert.match(jsx, /data-node-id="1:5"/);
  assert.ok(jsx.split('\n').find((l) => l.includes('data-node-id="1:5"')).includes('self-stretch'));
  assert.ok(jsx.split('\n').find((l) => l.includes('data-node-id="1:5"')).includes('justify-between'));
});

test('renders text with overrides, escaping and hug behavior', () => {
  const { jsx } = generateReact(entry.document, ctx());
  const title = jsx.split('\n').find((l) => l.includes('data-node-id="1:4"'));
  assert.ok(title.startsWith('      <p'), title);
  for (const cls of ["font-['Inter',sans-serif]", 'font-[600]', 'text-[20px]', 'leading-[28px]', 'text-[#121212]']) assert.ok(title.includes(cls), `${cls} in ${title}`);
  assert.ok(title.includes('Wireless <span className="font-[400] italic">Headphones</span>'), title);
  const price = jsx.split('\n').find((l) => l.includes('data-node-id="1:6"'));
  assert.ok(price.includes('whitespace-nowrap'));
  assert.ok(price.includes('leading-[normal]'));
  assert.ok(price.includes('{"$199 {sale}"}'), 'braces must be escaped for JSX');
  assert.ok(!jsx.includes('should not render'), 'hidden layers are skipped');
});

test('hoists image and icon assets and positions absolute children', () => {
  const result = generateReact(entry.document, ctx());
  assert.deepEqual(
    result.assets.map((a) => [a.varName, a.kind, a.nodeId]),
    [
      ['imgPhoto', 'image', '1:3'],
      ['imgIconCart', 'svg', 'I1:7;10:2'],
    ],
  );
  const code = renderModule(result, { imgPhoto: 'https://cdn/photo', imgIconCart: null });
  assert.match(code, /^const imgPhoto = "https:\/\/cdn\/photo";/);
  assert.match(code, /const imgIconCart = ""; \/\/ could not render svg/);
  assert.match(code, /src=\{imgPhoto\}/);
  const badge = code.split('\n').find((l) => l.includes('data-node-id="1:8"'));
  assert.ok(badge.includes('absolute') && badge.includes('right-[12px]') && badge.includes('top-[12px]'), badge);
  assert.deepEqual(
    result.instances.map((i) => [i.nodeId, i.componentSetName, i.properties.Variant]),
    [
      ['1:7', 'Button', 'Primary'],
      ['I1:7;10:2', undefined, undefined],
    ],
  );
});

test('substitutes bound variables as var(--token,fallback)', () => {
  const vars = new Map([
    ['VariableID:1:5', { name: 'Surface/Default' }],
    ['VariableID:1:6', { name: 'Spacing/4', webSyntax: 'var(--space-4)' }],
  ]);
  const { jsx } = generateReact(entry.document, ctx(vars));
  const root = jsx.split('\n').find((l) => l.includes('data-node-id="1:2"'));
  assert.ok(root.includes('bg-[color:var(--surface-default,#ffffff)]'), root);
  assert.ok(root.includes('gap-[var(--space-4,16px)]'), root);
});

test('binds corner radius variables in the nested rectangleCornerRadii shape Figma exports', () => {
  const alias = { type: 'VARIABLE_ALIAS', id: 'VariableID:3:1290' };
  const node = {
    id: '3:1478',
    name: 'Card',
    type: 'FRAME',
    absoluteBoundingBox: { x: 0, y: 0, width: 260, height: 300 },
    cornerRadius: 20,
    boundVariables: {
      rectangleCornerRadii: {
        RECTANGLE_TOP_LEFT_CORNER_RADIUS: alias,
        RECTANGLE_TOP_RIGHT_CORNER_RADIUS: alias,
        RECTANGLE_BOTTOM_LEFT_CORNER_RADIUS: alias,
        RECTANGLE_BOTTOM_RIGHT_CORNER_RADIUS: alias,
      },
    },
  };
  const { jsx } = generateReact(node, ctx(new Map([['VariableID:3:1290', { name: 'Radius/LG', webSyntax: 'var(--litex-radius-lg)' }]])));
  assert.ok(jsx.includes('rounded-[var(--litex-radius-lg,20px)]'), jsx);
});

test('collectors find variables, image fills and svg nodes', () => {
  assert.deepEqual([...collectVariableIds(entry.document)].sort(), ['VariableID:1:5', 'VariableID:1:6']);
  assert.deepEqual(collectImageFills(entry.document).map((r) => r.imageRef), ['abc123']);
  assert.deepEqual(collectSvgNodes(entry.document).map((n) => n.id), ['I1:7;10:2']);
});

test('metadata XML uses parent-relative positions', () => {
  const { xml } = nodeToXml(entry.document);
  assert.match(xml, /^<frame id="1:2" name="Product Card" x="100" y="100" width="320" height="420">/);
  assert.match(xml, /<rectangle id="1:3" name="Photo" x="24" y="24" width="272" height="180" \/>/);
  assert.match(xml, /<text id="1:9" name="Hidden note" hidden="true" \/>/);
});
