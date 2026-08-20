import { type ChildProcess, spawn } from 'node:child_process'
import { type IncomingMessage, type Server, type ServerResponse, createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { fileURLToPath } from 'node:url'

export const CLI = fileURLToPath(new URL('../../dist/cli.mjs', import.meta.url))

export const MONITOR_ID = '00000000-0000-4000-8000-00000000c11a'

export const OTHER_MONITOR_ID = '00000000-0000-4000-8000-00000000c11b'

export interface Ran {
  readonly status: number | null
  readonly signal: string | null
  readonly stdout: string
  readonly stderr: string
  readonly elapsedMs: number
}

export interface RunOptions {
  readonly env?: Readonly<Record<string, string>> | undefined
  readonly input?: string | undefined
  readonly timeoutMs?: number | undefined
  readonly detached?: boolean | undefined
  readonly holdStderr?: boolean | undefined
}

function childEnv(given: Readonly<Record<string, string>> | undefined): Record<string, string> {
  return { PATH: process.env['PATH'] ?? '', NODE_ENV: 'test', ...given }
}

export interface LiveCli {
  readonly child: ChildProcess
  readonly settled: Promise<Ran>
  stderrSoFar(): string
  stdoutSoFar(): string
  releaseStderr(): void
  dropStderr(): void
}

// spawnSync would block this worker's event loop, and the stand-in server answering the
// check-in runs on that same loop, so a synchronous launch deadlocks against its own server.
export function startCli(args: readonly string[], options: RunOptions = {}): LiveCli {
  const startedAt = Date.now()
  const child = spawn(process.execPath, [CLI, ...args], {
    env: childEnv(options.env),
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: options.detached ?? false,
  })
  let stdout = ''
  let stderr = ''

  child.stdout?.setEncoding('utf8')
  child.stderr?.setEncoding('utf8')
  child.stdout?.on('data', (chunk: string) => {
    stdout += chunk
  })

  const collectStderr = (chunk: string): void => {
    stderr += chunk
  }

  if (options.holdStderr === true) {
    child.stderr?.pause()
  } else {
    child.stderr?.on('data', collectStderr)
  }

  child.stderr?.on('error', () => {})
  child.stdin?.on('error', () => {})
  child.stdin?.end(options.input ?? '')

  const settled = new Promise<Ran>((resolve) => {
    child.on('close', (status, signal) => {
      resolve({ status, signal, stdout, stderr, elapsedMs: Date.now() - startedAt })
    })
  })

  return {
    child,
    settled,
    stderrSoFar: () => stderr,
    stdoutSoFar: () => stdout,
    releaseStderr: () => {
      child.stderr?.on('data', collectStderr)
      child.stderr?.resume()
    },
    dropStderr: () => {
      child.stderr?.destroy()
    },
  }
}

export function runCli(args: readonly string[], options: RunOptions = {}): Promise<Ran> {
  return startCli(args, options).settled
}

// Node cannot allocate a pseudo-terminal of its own, and stdin being one is what run branches on.
export function runCliUnderTerminal(
  args: readonly string[],
  options: RunOptions = {},
): Promise<Ran> {
  const startedAt = Date.now()
  const command = [process.execPath, CLI, ...args].join(' ')
  const child = spawn('script', ['-qec', command, '/dev/null'], {
    env: childEnv(options.env),
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''

  child.stdout?.setEncoding('utf8')
  child.stderr?.setEncoding('utf8')
  child.stdout?.on('data', (chunk: string) => {
    stdout += chunk
  })
  child.stderr?.on('data', (chunk: string) => {
    stderr += chunk
  })
  child.stdin?.on('error', () => {})
  child.stdin?.end(options.input ?? '')

  return new Promise<Ran>((resolve) => {
    child.on('close', (status, signal) => {
      resolve({ status, signal, stdout, stderr, elapsedMs: Date.now() - startedAt })
    })
  })
}

export interface PingRequest {
  readonly method: string
  readonly path: string
  readonly monitorId: string
  readonly action: string | null
  readonly headers: Readonly<Record<string, string>>
  readonly body: string
  readonly bodyBytes: Uint8Array
}

export interface ServerReply {
  readonly status?: number | undefined
  readonly body?: string | undefined
  readonly headers?: Readonly<Record<string, string>> | undefined
  readonly delayMs?: number | undefined
}

export type Replier = (request: PingRequest) => ServerReply

export interface PingServer {
  readonly url: string
  readonly requests: readonly PingRequest[]
  replyWith(replier: Replier): void
  close(): Promise<void>
}

const PING_PATH = /^\/ping\/([^/?#]+)(?:\/([^/?#]+))?$/

function describe(message: IncomingMessage, body: Uint8Array): PingRequest {
  const path = message.url ?? ''
  const match = PING_PATH.exec(path)
  const headers: Record<string, string> = {}

  for (const [name, value] of Object.entries(message.headers)) {
    headers[name] = Array.isArray(value) ? value.join(', ') : (value ?? '')
  }

  return {
    method: message.method ?? '',
    path,
    monitorId: match?.[1] ?? '',
    action: match?.[2] ?? null,
    headers,
    body: new TextDecoder().decode(body),
    bodyBytes: body,
  }
}

async function collect(message: IncomingMessage): Promise<Uint8Array> {
  const chunks: Uint8Array[] = []

  for await (const chunk of message) {
    chunks.push(chunk as Uint8Array)
  }

  let total = 0

  for (const chunk of chunks) {
    total += chunk.length
  }

  const joined = new Uint8Array(total)
  let offset = 0

  for (const chunk of chunks) {
    joined.set(chunk, offset)
    offset += chunk.length
  }

  return joined
}

export async function startPingServer(initial?: Replier): Promise<PingServer> {
  const requests: PingRequest[] = []
  let replier: Replier = initial ?? (() => ({}))
  const server: Server = createServer((message: IncomingMessage, response: ServerResponse) => {
    void collect(message).then((body) => {
      const request = describe(message, body)
      requests.push(request)
      const reply = replier(request)
      const send = (): void => {
        response.writeHead(reply.status ?? 200, {
          'Content-Type': 'text/plain; charset=utf-8',
          ...reply.headers,
        })
        response.end(reply.body ?? 'OK')
      }

      if (reply.delayMs !== undefined && reply.delayMs > 0) {
        // Detached so a reply nobody waits for cannot hold this worker open past the test.
        setTimeout(send, reply.delayMs).unref()

        return
      }

      send()
    })
  })

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve)
  })

  const address = server.address() as AddressInfo

  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    replyWith: (next) => {
      replier = next
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
