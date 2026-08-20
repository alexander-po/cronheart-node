import { readFileSync, readdirSync, statSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'

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
      relative.startsWith('transport/') || relative.startsWith('wiring/'),
    explains:
      'a check-in must never reject; wiring-time validation throws, the ping path returns an outcome',
  },
  {
    id: 'transport-imports-wiring',
    test: (line) => /from '[^']*wiring\//.test(line),
    allows: (relative) => !relative.startsWith('transport/'),
    reads: 'literals',
    explains: 'the wiring layer throws, so nothing on the wire path may reach it',
  },
]

function stripped(source, keepLiterals) {
  const out = []
  let mode = 'code'
  let index = 0

  while (index < source.length) {
    const char = source[index]
    const next = source[index + 1]

    if (mode === 'code') {
      if (char === '/' && next === '/') {
        mode = 'line-comment'
        index += 2
        continue
      }

      if (char === '/' && next === '*') {
        mode = 'block-comment'
        index += 2
        continue
      }

      if (char === "'" || char === '"' || char === '`') {
        mode = char
        out.push(char)
        index += 1
        continue
      }


      out.push(char)
      index += 1
      continue
    }

    if (mode === 'line-comment') {
      if (char === '\n') {
        mode = 'code'
        out.push(char)
      }

      index += 1
      continue
    }

    if (mode === 'block-comment') {
      if (char === '*' && next === '/') {
        mode = 'code'
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

    if (char === mode) {
      mode = 'code'
      out.push(char)
    } else if (char === '\n' || keepLiterals) {
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
