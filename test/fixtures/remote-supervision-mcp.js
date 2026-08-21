import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const server = new Server(
  { name: 'remote-supervision-fixture', version: '1.0.0' },
  { capabilities: { tools: {} } },
);

if (process.env.DC_TEST_STDERR_SENTINEL) {
  process.stderr.write(`${process.env.DC_TEST_STDERR_SENTINEL}\n`);
}

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    { name: 'ping', description: 'Return fixture pid', inputSchema: { type: 'object', properties: {} } },
    { name: 'block', description: 'Block until timer fires', inputSchema: { type: 'object', properties: { ms: { type: 'number' } } } },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name === 'ping') {
    return { content: [{ type: 'text', text: `pong:${process.pid}` }] };
  }
  if (request.params.name === 'block') {
    const ms = Math.max(1, Math.min(120000, Number(request.params.arguments?.ms ?? 60000)));
    await new Promise((resolve) => setTimeout(resolve, ms));
    return { content: [{ type: 'text', text: `released:${process.pid}` }] };
  }
  throw new Error(`Unknown tool: ${request.params.name}`);
});

await server.connect(new StdioServerTransport());
