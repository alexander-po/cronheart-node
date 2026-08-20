import { withoutLeadingPartial } from '../ping/body.js'

const decoder = new TextDecoder()

export interface StderrTail {
  push(chunk: Uint8Array): void
  text(): string
  readonly bytes: number
}

// The ring holds bytes rather than text: decoding each write on arrival turns any character
// the operating system split across two reads into a replacement character, which is exactly
// what a byte budget over a stream produces on non-ASCII output.
export function createStderrTail(budgetBytes: number): StderrTail {
  const chunks: Uint8Array[] = []
  let held = 0

  const trim = (): void => {
    while (held > budgetBytes) {
      const first = chunks[0]

      if (first === undefined) {
        held = 0
        break
      }

      const excess = held - budgetBytes

      if (first.length <= excess) {
        chunks.shift()
        held -= first.length
        continue
      }

      chunks[0] = first.subarray(excess)
      held -= excess
    }
  }

  return {
    push(chunk) {
      if (budgetBytes <= 0 || chunk.length === 0) {
        return
      }

      chunks.push(chunk)
      held += chunk.length
      trim()
    },
    text() {
      const joined = new Uint8Array(held)
      let offset = 0

      for (const chunk of chunks) {
        joined.set(chunk, offset)
        offset += chunk.length
      }

      return decoder.decode(withoutLeadingPartial(joined))
    },
    get bytes() {
      return held
    },
  }
}
