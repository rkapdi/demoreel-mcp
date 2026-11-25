// Tiny MCP client for manual end-to-end checks: node test/client.mjs <tool> '<json args>'
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const entry = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'index.js');
const client = new Client({ name: 'demoreel-test', version: '0' });
await client.connect(new StdioClientTransport({ command: process.execPath, args: [entry] }));
const [tool, json] = process.argv.slice(2);
if (!tool) console.log((await client.listTools()).tools.map((t) => t.name).join('\n'));
else {
  const r = await client.callTool({ name: tool, arguments: json ? JSON.parse(json) : {} }, undefined, { timeout: 600000 });
  console.log(r.isError ? 'ERROR: ' : '', r.content[0].text);
}
await client.close();
