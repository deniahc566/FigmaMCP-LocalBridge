import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { errorMessage } from '../util.js';
import { fail, guarded, image, sniffFormat, target, text, toolName, type ToolDeps } from './common.js';

const MAX_RESULT_CHARS = 100_000;
const MAX_IMAGES = 5;

/**
 * Pull exported bytes (e.g. `return await node.exportAsync()`) out of the result so PNG/JPEG come
 * back as viewable images and SVG as text, instead of a wall of base64.
 */
function extractImages(value: unknown, images: { data: string; mimeType: string }[]): unknown {
  if (Array.isArray(value)) return value.map((v) => extractImages(v, images));
  if (!value || typeof value !== 'object') return value;
  const v = value as Record<string, unknown>;
  if (v.__type === 'Uint8Array' && typeof v.base64 === 'string') {
    const bytes = Buffer.from(v.base64, 'base64');
    const fmt = sniffFormat(bytes);
    if ((fmt === 'png' || fmt === 'jpeg') && images.length < MAX_IMAGES) {
      images.push({ data: v.base64, mimeType: `image/${fmt}` });
      return { __type: 'Uint8Array', byteLength: v.byteLength, format: fmt, note: `returned as image #${images.length}` };
    }
    if (fmt === 'svg') return { __type: 'Uint8Array', byteLength: v.byteLength, format: 'svg', svg: bytes.toString('utf8') };
    return v;
  }
  return Object.fromEntries(Object.entries(v).map(([k, val]) => [k, extractImages(val, images)]));
}

export function registerWriteTools(server: McpServer, deps: ToolDeps) {
  const useFigma = toolName(deps.config.toolPrefix, 'use_figma');
  server.registerTool(
    useFigma,
    {
      title: 'Use Figma',
      description: [
        'Create, edit, inspect or sync anything in a Figma file by running JavaScript against the Figma Plugin API: frames, components, variants, variables, styles, text, auto layout, images and whole screens. Works in design files and FigJam boards.',
        'Requires the companion "Figma MCP Bridge" plugin to be running in the target file in the Figma desktop app.',
        'The code runs as the body of an async function with `figma` in scope. Use `return` to send JSON-serializable data back (nodes are returned as {id, name, type}; bytes from exportAsync come back as images). A single expression is returned automatically. console.log output is captured.',
        'GOTCHAS: the plugin uses dynamic page loading, so use async APIs: `await figma.getNodeByIdAsync(id)`, `await figma.setCurrentPageAsync(page)`, `await page.loadAsync()` before reading another page. Call `await figma.loadFontAsync({family, style})` before setting text; the Inter style is "Semi Bold", not "SemiBold". Append new nodes to a parent and position them, and return the IDs of what you created. Each call is committed as one undo step.',
      ].join(' '),
      inputSchema: {
        fileKey: z
          .string()
          .min(1)
          .describe('The key of the Figma file to edit (from the URL). Used to pick the right plugin connection when several files are open.'),
        code: z.string().min(1).max(50_000).describe('JavaScript to execute. Has access to the `figma` global (Figma Plugin API).'),
        description: z.string().max(2000).describe('A concise description of what the code aims to do.'),
        timeoutMs: z.number().int().min(1000).max(300_000).optional().describe('Execution timeout in milliseconds. Defaults to 60000.'),
      },
      annotations: { destructiveHint: true, openWorldHint: false },
    },
    guarded(async (args) => {
      if (!deps.bridge) return fail(`The plugin bridge is disabled (FIGMA_BRIDGE=off), so ${useFigma} is unavailable.`);
      const t = target(args.fileKey);
      try {
        const { result, logs, plugin } = await deps.bridge.execute(t.fileKey, args.code, args.timeoutMs ?? deps.config.bridgeTimeoutMs);
        const images: { data: string; mimeType: string }[] = [];
        const cleaned = extractImages(result, images);
        let body = cleaned === null || cleaned === undefined ? 'null' : JSON.stringify(cleaned, null, 2);
        if (body.length > MAX_RESULT_CHARS) body = `${body.slice(0, MAX_RESULT_CHARS)}\n… (truncated; return less data)`;
        const content: CallToolResult['content'] = [text(body)];
        if (logs.length) content.push(text(`console:\n${logs.join('\n')}`));
        content.push(text(`Ran in "${plugin.fileName}"${plugin.pageName ? `, page "${plugin.pageName}"` : ''}.`));
        for (const img of images) content.push(image(img.data, img.mimeType));
        return { content };
      } catch (err) {
        const logs: string[] = (err as { logs?: string[] }).logs ?? [];
        const stack = (err as { pluginStack?: string }).pluginStack;
        const parts = [`Error: ${errorMessage(err)}`];
        if (stack) parts.push(stack.split('\n').slice(0, 6).join('\n'));
        if (logs.length) parts.push(`console:\n${logs.join('\n')}`);
        return fail(parts.join('\n\n'));
      }
    }),
  );
}
