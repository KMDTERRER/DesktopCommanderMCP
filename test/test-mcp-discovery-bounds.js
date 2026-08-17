#!/usr/bin/env node
import assert from 'node:assert';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

async function main() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const isolated = await fs.mkdtemp(path.join(os.tmpdir(), 'dc-mcp-discovery-bounds-'));
  try {
    const fakeServer = path.join(isolated, 'huge-tools.mjs');
    const configPath = path.join(isolated, 'mcporter.json');
    await fs.writeFile(fakeServer, `
let buffer='';
const send=(id,result)=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',id,result})+'\\n');
process.stdin.setEncoding('utf8');
process.stdin.on('data',(chunk)=>{ buffer+=chunk; for(;;){ const nl=buffer.indexOf('\\n'); if(nl<0)break;
  const line=buffer.slice(0,nl).trim(); buffer=buffer.slice(nl+1); if(!line)continue; const m=JSON.parse(line);
  if(m.method==='initialize') send(m.id,{protocolVersion:m.params?.protocolVersion||'2025-06-18',capabilities:{tools:{}},serverInfo:{name:'huge',version:'1'}});
  else if(m.method==='notifications/initialized') {}
  else if(m.method==='ping') send(m.id,{});
  else if(m.method==='tools/list') send(m.id,{tools:[{name:'huge_tool',description:'x'.repeat(8*1024*1024+256*1024),inputSchema:{type:'object',properties:{}}}]});
}});
`, 'utf8');
    await fs.writeFile(configPath, JSON.stringify({ mcpServers: { huge: {
      command: process.execPath, args: [fakeServer], protocolVersion: 'legacy', lifecycle: 'keep-alive',
    } } }), 'utf8');

    process.env.DESKTOP_COMMANDER_MCP_CONFIG = configPath;
    process.env.HOME = isolated;
    process.env.USERPROFILE = isolated;
    const moduleUrl = pathToFileURL(path.join(root, 'dist', 'tools', 'external-mcp.js')).href;
    const { listExternalMcpTools, closeExternalMcpRuntime } = await import(moduleUrl);
    try {
      await assert.rejects(
        () => listExternalMcpTools({ server: 'huge', timeout_ms: 30_000 }),
        (error) => {
          assert.equal(error?.code, 'EFBIG', `expected EFBIG resource rejection, got: ${String(error)}`);
          assert.match(String(error?.message ?? error), /resource limit|exceeds/i);
          return true;
        },
        'oversized tools/list descriptor must be rejected before cache admission',
      );
    } finally {
      await closeExternalMcpRuntime();
    }
    console.log('MCP discovery bounds: PASS');
  } finally {
    await fs.rm(isolated, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
