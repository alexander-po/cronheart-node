import { readFileSync, readdirSync, statSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'

// Files whose whole job is to produce a rejection: the one chokepoint that hands a host
// error back, the stand-in transport, and the control that breaks the axiom on purpose.
const REJECTS_BY_DESIGN = new Set([
  'ping/safely.ts',
  'testing.ts',
  'integrations/__selftest__.ts',
])

const RULES = [
  {
    id: 'fetch-outside-transport',
    test: (line) => /\bfetch\s*\(/.test(line),
    allows: (relative) => relative.startsWith('transport/'),
    explains: 'the network call belongs behind the transport layer, where safely() covers it',
  },
  {
    id: 'throw-outside-guarded-layer',
    test: (line) => /\bthrow\b/.test(line),
    allows: (relative) =>
      relative.startsWith('transport/') ||
      relative.startsWith('wiring/') ||
      relative.startsWith('api/'),
    explains:
      'a check-in must never reject; wiring-time validation and the management client throw, the ping path returns an outcome',
  },
  {
    id: 'promise-reject-outside-guarded-layer',
    test: (line) => /\bPromise\s*\.\s*reject\s*\(/.test(line),
    allows: (relative) =>
      relative.startsWith('transport/') ||
      relative.startsWith('api/') ||
      REJECTS_BY_DESIGN.has(relative),
    explains:
      'a rejected promise is a throw from an async function; rethrow() is the one place a host error is handed back',
  },
  {
    id: 'ping-path-imports-the-management-client',
    test: (line) => /from '[^']*\bapi(?:\/|\.js')/.test(line),
    allows: (relative) =>
      relative === 'api.ts' ||
      relative === 'contract-anchors.ts' ||
      relative.startsWith('api/') ||
      relative.startsWith('cli/'),
    reads: 'literals',
    explains:
      'the management client always throws and is a separate bundle; anything on the check-in path that reached it would inherit both',
  },
  {
    id: 'attempt-count-derived-outside-the-bound',
    test: (line) => /\bretries\b\s*[+-]|[+-]\s*\bretries\b|[<>]=?\s*[\w.]*\bretries\b/.test(line),
    allows: (relative) => relative === 'transport/attempts.ts',
    explains:
      'the number of attempts is capped in one place and handed out branded; a loop that derived its own count from a raw retry option would run past the cap, which is how the check-in cap was bypassed once already',
  },
  {
    id: 'transport-imports-wiring',
    test: (line) => /from '[^']*wiring\//.test(line),
    allows: (relative) => !relative.startsWith('transport/'),
    reads: 'literals',
    explains: 'the wiring layer throws, so nothing on the wire path may reach it',
  },
]

// The lexer follows template interpolations back into code. Treating everything
// between backticks as string content lets any banned expression hide inside a ${…}.
function stripped(source, keepLiterals) {
  const out = []
  const stack = [{ kind: 'code', braces: 0, interpolation: false }]
  let index = 0

  while (index < source.length) {
    const frame = stack[stack.length - 1]
    const char = source[index]
    const next = source[index + 1]

    if (frame.kind === 'code') {
      if (char === '/' && next === '/') {
        stack.push({ kind: 'line-comment' })
        index += 2
        continue
      }

      if (char === '/' && next === '*') {
        stack.push({ kind: 'block-comment' })
        index += 2
        continue
      }

      if (char === "'" || char === '"' || char === '`') {
        stack.push({ kind: 'string', quote: char })
        out.push(char)
        index += 1
        continue
      }

      if (char === '{') {
        frame.braces += 1
      } else if (char === '}') {
        if (frame.braces === 0 && frame.interpolation) {
          stack.pop()
          index += 1
          continue
        }

        frame.braces -= 1
      }

      out.push(char)
      index += 1
      continue
    }

    if (frame.kind === 'line-comment') {
      if (char === '\n') {
        stack.pop()
        out.push(char)
      }

      index += 1
      continue
    }

    if (frame.kind === 'block-comment') {
      if (char === '*' && next === '/') {
        stack.pop()
        index += 2
        continue
      }

      if (char === '\n') {
        out.push(char)
      }

      index += 1
      continue
    }

    if (char === '\\') {
      index += 2
      continue
    }

    if (frame.quote === '`' && char === '$' && next === '{') {
      stack.push({ kind: 'code', braces: 0, interpolation: true })
      index += 2
      continue
    }

    if (char === frame.quote) {
      stack.pop()
      out.push(char)
      index += 1
      continue
    }

    if (char === '\n' || keepLiterals) {
      out.push(char)
    }

    index += 1
  }

  return out.join('')
}

function sourceFiles(root) {
  return readdirSync(root, { withFileTypes: false }).flatMap((name) => {
    const child = new URL(name, root)

    if (statSync(child).isDirectory()) {
      return sourceFiles(new URL(`${name}/`, root))
    }

    return name.endsWith('.ts') ? [child] : []
  })
}

export function findViolations(root) {
  const rootPath = fileURLToPath(root)

  return sourceFiles(root).flatMap((file) => {
    const relative = fileURLToPath(file).slice(rootPath.length)
    const source = readFileSync(file, 'utf8')
    const views = {
      code: stripped(source, false).split('\n'),
      literals: stripped(source, true).split('\n'),
    }

    return views.code.flatMap((line, offset) =>
      RULES.filter(
        (rule) =>
          rule.test(rule.reads === 'literals' ? (views.literals[offset] ?? '') : line) &&
          !rule.allows(relative),
      ).map((rule) => ({
        rule: rule.id,
        file: relative,
        line: offset + 1,
        explains: rule.explains,
      })),
    )
  })
}

function main() {
  const target = process.argv[2] ?? 'src'
  const root = pathToFileURL(`${process.cwd()}/${target.replace(/\/*$/, '/')}`)
  const violations = findViolations(root)

  if (violations.length === 0) {
    process.stdout.write(`source guard — ${target} clean\n`)

    return
  }

  for (const violation of violations) {
    process.stderr.write(
      `  - ${violation.rule}: ${violation.file}:${violation.line} — ${violation.explains}\n`,
    )
  }

  process.stderr.write(`source guard FAILED — ${violations.length} violation(s)\n`)
  process.exit(1)
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main()
}
