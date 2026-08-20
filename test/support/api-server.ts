import { type IncomingMessage, type Server, type ServerResponse, createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { MonitorStore } from './monitor-store.js'

export interface ApiServer {
  readonly url: string
  readonly authorizations: readonly string[]
  close(): Promise<void>
}

async function bodyOf(message: IncomingMessage): Promise<string> {
  let text = ''

  for await (const chunk of message) {
    text += String(chunk)
  }

  return text
}

// The same in-memory model the unit suites reconcile against, served over a socket, so the
// command-line tests exercise the built binary rather than a stand-in for it.
export async function startApiServer(store: MonitorStore): Promise<ApiServer> {
  const authorizations: string[] = []
  const server: Server = createServer((message: IncomingMessage, response: ServerResponse) => {
    void bodyOf(message).then((text) => {
      const parsed = new URL(message.url ?? '/', 'http://api.invalid')
      const query: Record<string, string> = {}

      for (const [key, value] of parsed.searchParams) {
        query[key] = value
      }

      authorizations.push(String(message.headers['authorization'] ?? ''))

      const reply = store.handle({
        method: message.method ?? 'GET',
        path: parsed.pathname,
        query,
        body: text === '' ? undefined : JSON.parse(text),
        idempotencyKey:
          typeof message.headers['idempotency-key'] === 'string'
            ? message.headers['idempotency-key']
            : undefined,
      })

      response.writeHead(reply.status, { 'Content-Type': 'application/json' })
      response.end(reply.json === undefined ? '' : JSON.stringify(reply.json))
    })
  })

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve)
  })

  const address = server.address() as AddressInfo

  return {
    url: `http://127.0.0.1:${address.port}`,
    get authorizations() {
      return authorizations
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => {
          resolve()
        })
      }),
  }
}
