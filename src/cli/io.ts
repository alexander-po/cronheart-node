import process from 'node:process'

export interface Io {
  out(text: string): void
  err(text: string): void
}

function ignore(): void {}

// A closed reader errors these streams by event, and an emitter with no error listener
// rethrows that as an uncaught exception — replacing the wrapped command's exit status with 1.
export function silenceStreamErrors(): void {
  process.stdout.on('error', ignore)
  process.stderr.on('error', ignore)
}

// Whether the stream will take more without buffering. A write that throws instead of
// emitting — a file-backed stream out of space — answers true: no drain is coming for it.
export function writeQuietly(
  stream: { write(chunk: string | Uint8Array): boolean },
  chunk: string | Uint8Array,
): boolean {
  try {
    return stream.write(chunk)
  } catch {
    return true
  }
}

export const processIo: Io = {
  out: (text) => {
    writeQuietly(process.stdout, text)
  },
  err: (text) => {
    writeQuietly(process.stderr, text)
  },
}
