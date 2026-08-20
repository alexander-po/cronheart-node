import {
  BUILT_IN_SECRETS,
  REDACTION,
  globalised,
  redactSecrets,
  withoutLeadingPartial,
  withoutTrailingPartial,
} from '../ping/body.js'

const encoder = new TextEncoder()

const decoder = new TextDecoder()

// How far back redaction is guaranteed to reach, and how much of the live end of the stream
// is withheld from it. A secret longer than this is not covered at any boundary below.
const REDACTION_REACH_BYTES = 2048

const COMPACTION_SLACK_BYTES = 8192

export interface StderrTail {
  push(chunk: Uint8Array): void
  text(): string
  readonly bytes: number
}

// A match reaching the live end of the stream is left alone: the rest of it may not have been
// written yet, and replacing the prefix now would take the anchor with it and leave the
// remainder to ship as plain material.
function redactSettled(
  text: string,
  patterns: readonly (string | RegExp)[],
  liveChars: number,
): string {
  return [...BUILT_IN_SECRETS, ...patterns].reduce<string>((current, pattern) => {
    const edge = current.length - liveChars

    return current.replace(globalised(pattern), (match: string, ...rest: unknown[]) => {
      const at = rest[rest.length - 2] as number

      return at + match.length > edge ? match : REDACTION
    })
  }, text)
}

// The ring holds bytes rather than text: decoding each write on arrival turns any character
// the operating system split across two reads into a replacement character, which is exactly
// what a byte budget over a stream produces on non-ASCII output.
export function createStderrTail(
  budgetBytes: number,
  patterns: readonly (string | RegExp)[] = [],
): StderrTail {
  const held: Uint8Array[] = []
  const keepBytes = budgetBytes + REDACTION_REACH_BYTES
  const ceiling = keepBytes + COMPACTION_SLACK_BYTES
  let bytes = 0

  const joined = (): Uint8Array => {
    const all = new Uint8Array(bytes)
    let offset = 0

    for (const chunk of held) {
      all.set(chunk, offset)
      offset += chunk.length
    }

    return all
  }

  const whole = (): {
    readonly text: string
    readonly complete: Uint8Array
    readonly pending: Uint8Array
  } => {
    const all = joined()
    const complete = withoutTrailingPartial(all)

    return {
      text: decoder.decode(complete),
      complete,
      pending: all.subarray(complete.length),
    }
  }

  // Nothing leaves this ring unredacted, so every later cut — this ring's own, the byte
  // budget's, the body cap's — can only ever split [redacted] rather than decapitate a secret.
  const compact = (): void => {
    const { text, complete, pending } = whole()
    const liveFrom = Math.max(0, complete.length - REDACTION_REACH_BYTES)
    const liveChars = decoder.decode(complete.subarray(liveFrom)).length + 4
    const done = encoder.encode(redactSettled(text, patterns, Math.min(text.length, liveChars)))
    const kept = withoutLeadingPartial(
      done.length <= keepBytes ? done : done.subarray(done.length - keepBytes),
    )

    held.length = 0
    held.push(kept, pending)
    bytes = kept.length + pending.length
  }

  return {
    push(chunk) {
      if (budgetBytes <= 0 || chunk.length === 0) {
        return
      }

      held.push(chunk)
      bytes += chunk.length

      if (bytes > ceiling) {
        compact()
      }
    },
    text() {
      if (budgetBytes <= 0) {
        return ''
      }

      const done = encoder.encode(redactSecrets(whole().text, patterns))
      const kept = done.length <= budgetBytes ? done : done.subarray(done.length - budgetBytes)

      return decoder.decode(withoutLeadingPartial(kept))
    },
    get bytes() {
      return bytes
    },
  }
}
