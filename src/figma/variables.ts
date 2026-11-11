import type { PluginBridge } from '../bridge/server.js';
import { cssColor } from '../codegen/paint.js';
import { num } from '../util.js';
import { FigmaApiError, type FigmaRestClient } from './rest.js';
import type { Color } from './types.js';

export interface ResolvedVariable {
  id: string;
  name: string;
  resolvedType: string;
  value: string;
  collection?: string;
  /** Code syntax the designer set for web, e.g. "var(--color-bg)". */
  webSyntax?: string;
}

export interface ResolveOutcome {
  variables: Map<string, ResolvedVariable>;
  source: 'plugin' | 'rest' | 'none';
  unresolved: string[];
  note?: string;
}

function formatValue(value: unknown, type: string): string {
  if (value === undefined || value === null) return '';
  if (type === 'COLOR' && typeof value === 'object' && 'r' in (value as object)) return cssColor(value as Color);
  if (type === 'FLOAT' && typeof value === 'number') return num(value);
  if (typeof value === 'object' && (value as { type?: string }).type === 'VARIABLE_ALIAS') return `alias(${(value as { id: string }).id})`;
  return String(value);
}

// Runs inside the plugin. resolveForConsumer gives the value in the node's actual mode.
const PLUGIN_RESOLVE = (ids: string[], nodeId: string | undefined) => `
const ids = ${JSON.stringify(ids)};
const consumer = ${nodeId ? `await figma.getNodeByIdAsync(${JSON.stringify(nodeId)})` : 'null'};
const out = {};
for (const id of ids) {
  try {
    const v = await figma.variables.getVariableByIdAsync(id);
    if (!v) continue;
    const col = await figma.variables.getVariableCollectionByIdAsync(v.variableCollectionId);
    let value;
    if (consumer) { try { value = v.resolveForConsumer(consumer).value; } catch (e) {} }
    if (value === undefined) {
      let cur = v, guard = 0;
      value = col ? cur.valuesByMode[col.defaultModeId] : Object.values(cur.valuesByMode)[0];
      while (value && value.type === 'VARIABLE_ALIAS' && guard++ < 10) {
        cur = await figma.variables.getVariableByIdAsync(value.id);
        if (!cur) break;
        const c = await figma.variables.getVariableCollectionByIdAsync(cur.variableCollectionId);
        value = c ? cur.valuesByMode[c.defaultModeId] : Object.values(cur.valuesByMode)[0];
      }
    }
    out[id] = { name: v.name, resolvedType: v.resolvedType, value, collection: col ? col.name : undefined, webSyntax: v.codeSyntax && v.codeSyntax.WEB };
  } catch (e) {}
}
return out;`;

export class VariableResolver {
  /** Files where the REST variables endpoint returned 403 (non-Enterprise), so we stop asking. */
  private restDenied = new Set<string>();

  constructor(
    private rest: FigmaRestClient,
    private bridge: PluginBridge | null,
  ) {}

  async resolve(fileKey: string, ids: string[], consumerNodeId?: string): Promise<ResolveOutcome> {
    const variables = new Map<string, ResolvedVariable>();
    if (ids.length === 0) return { variables, source: 'none', unresolved: [] };

    if (this.bridge?.hasFile(fileKey)) {
      try {
        const { result } = await this.bridge.execute(fileKey, PLUGIN_RESOLVE(ids, consumerNodeId), 20_000);
        for (const [id, v] of Object.entries((result ?? {}) as Record<string, any>)) {
          variables.set(id, { id, name: v.name, resolvedType: v.resolvedType, value: formatValue(v.value, v.resolvedType), collection: v.collection, webSyntax: v.webSyntax || undefined });
        }
        return { variables, source: 'plugin', unresolved: ids.filter((id) => !variables.has(id)) };
      } catch {
        // Fall through to REST.
      }
    }

    if (this.rest.hasToken && !this.restDenied.has(fileKey)) {
      try {
        const meta = await this.rest.getLocalVariables(fileKey);
        const lookup = (id: string) => meta.variables[id];
        for (const id of ids) {
          const v = lookup(id);
          if (!v) continue;
          const col = meta.variableCollections[v.variableCollectionId];
          let value = v.valuesByMode[col?.defaultModeId ?? Object.keys(v.valuesByMode)[0]];
          for (let guard = 0; value && (value as any).type === 'VARIABLE_ALIAS' && guard < 10; guard++) {
            const target = lookup((value as any).id);
            if (!target) break;
            const tc = meta.variableCollections[target.variableCollectionId];
            value = target.valuesByMode[tc?.defaultModeId ?? Object.keys(target.valuesByMode)[0]];
          }
          const syntax = (v as any).codeSyntax?.WEB as string | undefined;
          variables.set(id, { id, name: v.name, resolvedType: v.resolvedType, value: formatValue(value, v.resolvedType), collection: col?.name, webSyntax: syntax });
        }
        const unresolved = ids.filter((id) => !variables.has(id));
        return {
          variables,
          source: 'rest',
          unresolved,
          note: unresolved.length ? 'Some variables come from libraries; run the companion plugin in this file to resolve them.' : undefined,
        };
      } catch (err) {
        if (err instanceof FigmaApiError && (err.status === 403 || err.status === 404)) this.restDenied.add(fileKey);
      }
    }

    return {
      variables,
      source: 'none',
      unresolved: ids,
      note: 'Variable names could not be resolved: the REST variables API needs an Enterprise plan. Run the companion Figma plugin in this file to resolve them.',
    };
  }
}
