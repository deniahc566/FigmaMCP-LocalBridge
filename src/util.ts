/** Run async work over items with bounded concurrency, preserving order. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

export class TtlCache<V> {
  private entries = new Map<string, { value: V; expires: number }>();
  constructor(private ttlMs: number, private maxEntries = 100) {}

  get(key: string): V | undefined {
    const hit = this.entries.get(key);
    if (!hit) return undefined;
    if (hit.expires < Date.now()) {
      this.entries.delete(key);
      return undefined;
    }
    return hit.value;
  }

  set(key: string, value: V): void {
    if (this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
    this.entries.set(key, { value, expires: Date.now() + this.ttlMs });
  }

  async getOrLoad(key: string, load: () => Promise<V>): Promise<V> {
    const hit = this.get(key);
    if (hit !== undefined) return hit;
    const value = await load();
    this.set(key, value);
    return value;
  }
}

/** Format a number for CSS/XML output: at most 2 decimals, no trailing zeros. */
export function num(n: number): string {
  const rounded = Math.round(n * 100) / 100;
  return Object.is(rounded, -0) ? '0' : String(rounded);
}

export function px(n: number): string {
  return `${num(n)}px`;
}

export function xmlEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function pascalCase(name: string, fallback = 'Component'): string {
  const words = name
    .normalize('NFKD')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  let out = words.map((w) => w[0].toUpperCase() + w.slice(1)).join('');
  out = out.replace(/[^A-Za-z0-9_$]/g, '');
  if (!out || !/^[A-Za-z_$]/.test(out)) out = fallback + out;
  return out;
}

export function kebabCase(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
}

/** Detect the real format of image bytes from their magic numbers. */
export function sniffFormat(bytes: Buffer): string {
  if (bytes.length >= 4 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpeg';
  if (bytes.length >= 4 && bytes.subarray(0, 4).toString('ascii') === 'GIF8') return 'gif';
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP') return 'webp';
  const head = bytes.subarray(0, 256).toString('utf8').trimStart();
  if (head.startsWith('<svg') || head.startsWith('<?xml')) return 'svg';
  return 'original';
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
