#!/usr/bin/env node
// Minimal zero-dependency stdio MCP server that exposes the 60-tool benchmark
// catalog as stub tools. Every tools/call is appended to CATALOG_CALL_LOG so the
// harness can see which tool the agent actually reached, whichever way it got
// there (direct tool_use, tool search, or a Code Mode script).
//
// Env:
//   CATALOG_TOOLS     comma-separated tool names to expose (default: all)
//   CATALOG_FILE      JSON array of { name, description, inputSchema } to serve
//                     instead of the built-in 60-tool catalog (used for BFCL)
//   CATALOG_CALL_LOG  path of a JSONL file to append calls to
import fs from 'node:fs';
import readline from 'node:readline';
import { TOOLS_60 } from './catalog.mjs';

const subset = (process.env.CATALOG_TOOLS || '').split(',').map(s => s.trim()).filter(Boolean);
const logPath = process.env.CATALOG_CALL_LOG || '';

const allTools = process.env.CATALOG_FILE
  ? JSON.parse(fs.readFileSync(process.env.CATALOG_FILE, 'utf8'))
  : Object.entries(TOOLS_60).map(([name, meta]) => ({
      name,
      description: meta.description,
      inputSchema: {
        type: 'object',
        properties: {
          args: { type: 'string', description: 'Arguments for this operation (path, query, command, id, ...)' }
        },
        additionalProperties: true
      }
    }));

const tools = subset.length ? allTools.filter(t => subset.includes(t.name)) : allTools;
const names = tools.map(t => t.name);

const send = msg => process.stdout.write(JSON.stringify(msg) + '\n');

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', line => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  const { id, method, params } = msg;
  if (id === undefined) return; // notification

  if (method === 'initialize') {
    return send({
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: params?.protocolVersion || '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'catalog', version: '1.0.0' }
      }
    });
  }
  if (method === 'ping') return send({ jsonrpc: '2.0', id, result: {} });
  if (method === 'tools/list') return send({ jsonrpc: '2.0', id, result: { tools } });
  if (method === 'tools/call') {
    const name = params?.name;
    if (logPath) {
      fs.appendFileSync(logPath, JSON.stringify({ t: Date.now(), tool: name, arguments: params?.arguments ?? {} }) + '\n');
    }
    if (!names.includes(name)) {
      return send({ jsonrpc: '2.0', id, error: { code: -32602, message: `Unknown tool: ${name}` } });
    }
    return send({
      jsonrpc: '2.0',
      id,
      result: { content: [{ type: 'text', text: `ok: ${name} completed (benchmark stub, no real side effects).` }] }
    });
  }
  send({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } });
});
