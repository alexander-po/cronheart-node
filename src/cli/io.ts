import process from 'node:process'

export interface Io {
  out(text: string): void
  err(text: string): void
}

function writer(stream: { write(chunk: string | Uint8Array): unknown }): (text: string) => void {
  return (text) => {
    try {
      stream.write(text)
    } catch {}
  }
}

export const processIo: Io = {
  out: writer(process.stdout),
  err: writer(process.stderr),
}
