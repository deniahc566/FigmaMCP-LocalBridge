import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { PluginBridge } from '../bridge/server.js';
import type { Config } from '../config.js';
import { resolveTarget } from '../figma/ids.js';
import type { DesignReader, Rendered } from '../figma/reader.js';
import type { FigmaRestClient } from '../figma/rest.js';
import type { VariableResolver } from '../figma/variables.js';
import { errorMessage } from '../util.js';

export interface ToolDeps {
  config: Config;
  rest: FigmaRestClient;
  bridge: PluginBridge | null;
  variables: VariableResolver;
  /** Plugin-first reads with REST fallback; use this rather than `rest` for file content. */
  reader: DesignReader;
}

export type ToolBase =
  | 'get_design_context'
  | 'get_metadata'
  | 'get_screenshot'
  | 'get_variable_defs'
  | 'get_figjam'
  | 'download_assets'
  | 'get_code_connect_map'
  | 'search_design_system'
  | 'get_libraries'
  | 'use_figma'
  | 'whoami';

/** The registered (prefixed) name of a tool. Use it everywhere a tool is mentioned to the model. */
export function toolName(prefix: string, base: ToolBase): string {
  return prefix + base;
}

// Parameter schemas mirror the official Figma MCP server so prompts and skills written for it work here.
// Patterns are relaxed on purpose: a pasted URL in fileKey, or "1-2" style node IDs, are accepted and normalized.

export const fileKeyParam = z
  .string()
  .min(1)
  .describe(
    'The key of the Figma file to use. If a URL is provided, extract the file key from it: for https://figma.com/design/:fileKey/:fileName?node-id=1-2 the fileKey is `:fileKey`. For https://figma.com/design/:fileKey/branch/:branchKey/:fileName use the branchKey. A full URL is also accepted.',
  );

export const nodeIdParam = z
  .string()
  .min(1)
  .describe(
    'The ID of the node in the Figma document, eg. "123:456" or "123-456". Extract it from the URL\'s node-id query parameter. Do not pass an empty or guessed nodeId.',
  );

export const clientLanguagesParam = z
  .string()
  .optional()
  .describe('A comma separated list of programming languages used by the client in the current context, e.g. `javascript`, `html,css,typescript`. If you do not know, list `unknown`.');

export const clientFrameworksParam = z
  .string()
  .optional()
  .describe('A comma separated list of frameworks used by the client in the current context, e.g. `react`, `vue`, `django`. If you do not know, list `unknown`.');

export function target(fileKey: string, nodeId?: string) {
  return resolveTarget(fileKey, nodeId);
}

export function text(t: string): CallToolResult['content'][number] {
  return { type: 'text', text: t };
}

export function json(value: unknown): CallToolResult['content'][number] {
  return { type: 'text', text: JSON.stringify(value, null, 2) };
}

export function image(data: string, mimeType = 'image/png'): CallToolResult['content'][number] {
  return { type: 'image', data, mimeType };
}

export function fail(message: string): CallToolResult {
  return { isError: true, content: [text(message)] };
}

/** Wrap a handler so thrown errors become MCP tool errors the model can read and act on. */
export function guarded<A>(fn: (args: A) => Promise<CallToolResult>): (args: A) => Promise<CallToolResult> {
  return async (args: A) => {
    try {
      return await fn(args);
    } catch (err) {
      return fail(errorMessage(err));
    }
  };
}

export { sniffFormat } from '../util.js';

/** Base64 of a rendered asset: plugin renders carry their bytes, REST renders are downloaded. */
export async function renderedBase64(deps: ToolDeps, rendered: Rendered): Promise<string> {
  if (rendered.data) return rendered.data.toString('base64');
  if (!rendered.url) throw new Error('Nothing was rendered.');
  const { data } = await deps.rest.fetchBinary(rendered.url);
  return data.toString('base64');
}

/** Where to fetch a rendered asset: a local file for plugin renders, a temporary URL for REST. */
export function location(rendered: Rendered | undefined): { url?: string; file?: string } {
  if (!rendered) return {};
  return rendered.file ? { file: rendered.file } : { url: rendered.url };
}
