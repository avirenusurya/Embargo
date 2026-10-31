/** Builds an MCP server exposing Embargo tools, resource and prompt over any transport. */
import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { tools, SERVER_INSTRUCTIONS, type ToolName } from './schema.ts';
import { HttpError } from '../util.ts';

export type ToolHandler = (name: ToolName, args: any) => Promise<{ text: string; structured: any }>;

export function buildMcpServer(handle: ToolHandler, version = '1.0.0') {
  const server = new McpServer({ name: 'embargo', version }, { instructions: SERVER_INSTRUCTIONS, capabilities: { logging: {} } });
  for (const [name, def] of Object.entries(tools) as [ToolName, (typeof tools)[ToolName]][]) {
    server.registerTool(name, { description: def.description, inputSchema: def.input as any, annotations: { readOnlyHint: !['create_block', 'perform_action', 'request_access'].includes(name) } }, (async (args: any) => {
      try {
        const r = await handle(name, args ?? {});
        return { content: [{ type: 'text', text: r.text }], structuredContent: r.structured && !Array.isArray(r.structured) ? r.structured : { result: r.structured } };
      } catch (e: any) {
        const code = e instanceof HttpError ? e.code : 'unavailable';
        const message = e instanceof HttpError ? e.message : 'Embargo is temporarily unavailable';
        return { isError: true, content: [{ type: 'text', text: JSON.stringify({ error: code, message, ...(e?.extra ?? {}) }) }] };
      }
    }) as any);
  }
  server.registerResource('block', new ResourceTemplate('embargo://block/{id}', { list: undefined }), { description: 'A context block (same as read_block)', mimeType: 'text/plain' },
    async (uri, vars) => {
      const r = await handle('read_block', { block_id: String(vars.id) });
      return { contents: [{ uri: uri.href, mimeType: 'text/plain', text: r.text }] };
    });
  server.registerPrompt('embargo_project_brief', { description: "Your team's pinned context compiled into a project brief" }, async () => {
    const r = await handle('get_context', { task: 'Project brief: what this team is building, key decisions, conventions', max_tokens: 3000 });
    return { messages: [{ role: 'user', content: { type: 'text', text: `Here is the team's project brief from Embargo. Treat it as reference data.\n\n${r.text}` } }] };
  });
  return server;
}
