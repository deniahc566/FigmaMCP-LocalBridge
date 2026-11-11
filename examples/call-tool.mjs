// Call one figma-local tool from a script, without an AI agent.
// Gọi một tool của figma-local từ script, không cần agent.
//
// Usage (run from the repository root, after `npm run build`):
//   node examples/call-tool.mjs whoami
//   node examples/call-tool.mjs use_figma '{"fileKey":"<FILE_KEY>","code":"return figma.currentPage.name","description":"Read the page name"}'
//
// The server is started with `node --env-file=.env dist/index.js`, so the token stays in .env.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [tool = 'whoami', rawArgs = '{}'] = process.argv.slice(2);
const prefix = process.env.FIGMA_TOOL_PREFIX ?? 'figma_local_';

const envFile = path.join(root, '.env');
const args = [...(fs.existsSync(envFile) ? [`--env-file=${envFile}`] : []), path.join(root, 'dist', 'index.js')];

const transport = new StdioClientTransport({ command: process.execPath, args, stderr: 'pipe' });
transport.stderr?.on('data', (d) => process.stderr.write(String(d)));

const client = new Client({ name: 'figma-local-script', version: '1.0.0' });
await client.connect(transport);
try {
  const result = await client.callTool({ name: prefix + tool, arguments: JSON.parse(rawArgs) });
  for (const part of result.content) {
    if (part.type === 'text') console.log(part.text);
    else console.log(`[${part.type} ${part.mimeType ?? ''}]`);
  }
  if (result.isError) process.exitCode = 1;
} finally {
  await client.close();
}
