const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const { ListToolsRequestSchema, CallToolRequestSchema } = require('@modelcontextprotocol/sdk/types.js');
const { version } = require('../package.json');

const MCP_HTTP_PATH = '/mcp';

function mcpHttpUrl(host, port) {
    return `http://${host}:${port}${MCP_HTTP_PATH}`;
}

// Stateless: every request gets its own server/transport pair, so no session state
// survives between calls and concurrent agents cannot interfere with each other.
async function handleMcpHttpRequest(req, res, { host, port }) {
    const { createCorvasMcp } = await import('../mcp/flow-canvas-tools.mjs');
    const { tools, callTool } = createCorvasMcp({ baseUrl: `http://${host}:${port}` });
    const server = new Server({ name: 'flow-canvas-mcp', version }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, () => ({ tools }));
    server.setRequestHandler(CallToolRequestSchema, request => callTool(request.params.name, request.params.arguments));

    const authorities = [`127.0.0.1:${port}`, `localhost:${port}`];
    const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
        enableDnsRebindingProtection: true,
        allowedHosts: authorities,
        allowedOrigins: authorities.map(authority => `http://${authority}`)
    });
    res.on('close', () => {
        transport.close().catch(() => {});
        server.close().catch(() => {});
    });
    await server.connect(transport);
    await transport.handleRequest(req, res);
}

module.exports = { MCP_HTTP_PATH, mcpHttpUrl, handleMcpHttpRequest };
