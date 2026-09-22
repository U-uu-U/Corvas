const { BlenderDesktop } = require('../electron-main/blender-desktop.cjs');
if (!process.env.FLOW_MCP_SMOKE_PROFILE) throw new Error('Isolated smoke profile required');
BlenderDesktop.prototype.discover = async () => [{ path: process.execPath, name: 'Blender fixture' }];
BlenderDesktop.prototype.validPath = () => true;
BlenderDesktop.prototype.running = async () => [{ pid: process.pid }];
BlenderDesktop.prototype.launch = async () => { throw new Error('Real software must not launch during smoke checks'); };
require('./mcp-client-smoke-entry.cjs');
