/**
 * Minimal MCP stdio server: newline-delimited JSON-RPC 2.0, tools only.
 *
 * We answer `initialize` with protocol 2025-06-18 on purpose: the tool surface
 * is tiny and stable, and an older negotiated revision is the least surprising
 * thing to a client that also speaks newer ones.
 */
import { createInterface } from 'node:readline'

export const PROTOCOL_VERSION = '2025-06-18'

class RpcError extends Error {
  constructor(code, message) {
    super(message)
    this.code = code
  }
}

/**
 * @param {{name: string, version: string, instructions?: string,
 *   tools: Array<{name: string, description?: string, inputSchema: object,
 *     handler: (args: any) => Promise<{text: string, isError?: boolean}>}>}} server
 */
export function serveStdio(server) {
  const byName = new Map(server.tools.map((tool) => [tool.name, tool]))
  const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`)

  const dispatch = async (method, params) => {
    switch (method) {
      case 'initialize':
        return {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: true } },
          serverInfo: { name: server.name, version: server.version },
          instructions: server.instructions,
        }
      case 'ping':
        return {}
      case 'tools/list':
        return {
          tools: server.tools.map(({ name, description, inputSchema }) => ({
            name,
            ...(description ? { description } : {}),
            inputSchema,
          })),
        }
      case 'tools/call': {
        const tool = byName.get(params?.name)
        if (!tool) throw new RpcError(-32602, `unknown tool: ${params?.name}`)
        try {
          const { text, isError } = await tool.handler(params?.arguments ?? {})
          return { content: [{ type: 'text', text }], ...(isError ? { isError: true } : {}) }
        } catch (error) {
          return { content: [{ type: 'text', text: `error: ${error?.message ?? String(error)}` }], isError: true }
        }
      }
      default:
        throw new RpcError(-32601, `method not found: ${method}`)
    }
  }

  const handle = async (line) => {
    if (!line.trim()) return
    let message
    try {
      message = JSON.parse(line)
    } catch {
      return // client-side garbage: nothing to answer to
    }
    // Notifications (no id) never get a response. A client that just finished
    // initializing gets one tools/list_changed so a server-version change
    // (new tools) is picked up without restarting the client.
    if (message?.id === undefined || message?.id === null) {
      if (message?.method === 'notifications/initialized') send({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' })
      return
    }
    try {
      send({ jsonrpc: '2.0', id: message.id, result: await dispatch(message.method, message.params) })
    } catch (error) {
      send({
        jsonrpc: '2.0',
        id: message.id,
        error: { code: error?.code ?? -32603, message: error?.message ?? 'internal error' },
      })
    }
  }

  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity })
  // Fire and forget: a long build must not block status/list requests.
  rl.on('line', (line) => {
    void handle(line)
  })
  rl.on('close', () => process.exit(0))
  process.on('SIGTERM', () => process.exit(0))
}
