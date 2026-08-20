import { describe, expect, it } from 'vitest'
import { parseArgv, readText, unknownFlags } from '../src/cli/args.js'
import { parseDuration } from '../src/cli/duration.js'
import { runCli } from './support/cli.js'

// Node reads some long options as its own wherever they appear on the line, script
// arguments included, so a flag name that collides never reaches this CLI at all.
const DECLARED_FLAGS = [
  '--name=x',
  '--uuid=x',
  '--timeout=1s',
  '--kill-after=1s',
  '--stderr-bytes=1',
  '--action=start',
  '--body=x',
  '--strict',
  '--env-path=/tmp/nowhere',
  '--print-env',
  '--help',
  '--version',
  '-h',
  '-V',
]

describe('the argument parser', () => {
  it('splits the wrapper’s own flags from the command it is asked to run', () => {
    const args = parseArgv(['run', '--name=job', '--timeout=30s', '--', 'ls', '-la'])

    expect(args.positional).toEqual(['run'])
    expect(args.rest).toEqual(['ls', '-la'])
    expect(readText(args, 'name')).toEqual({ ok: true, value: 'job' })
    expect(readText(args, 'timeout')).toEqual({ ok: true, value: '30s' })
  })

  it('hands the command everything after the separator, flags included', () => {
    expect(parseArgv(['run', '--', 'sh', '-c', '--name=not-mine']).rest).toEqual([
      'sh',
      '-c',
      '--name=not-mine',
    ])
  })

  it('tells a separator with nothing after it apart from no separator at all', () => {
    expect(parseArgv(['run', '--']).rest).toEqual([])
    expect(parseArgv(['run']).rest).toBeUndefined()
  })

  it('keeps every character after the first equals sign', () => {
    expect(readText(parseArgv(['ping', 'job', '--body=a=b=c']), 'body')).toEqual({
      ok: true,
      value: 'a=b=c',
    })
  })

  it('reads an empty value as an empty value rather than as an absent flag', () => {
    expect(readText(parseArgv(['ping', 'job', '--action=']), 'action')).toEqual({
      ok: true,
      value: '',
    })
  })

  it('refuses a flag that needs a value and was given none, rather than reading the next token', () => {
    const args = parseArgv(['run', '--name', 'job', '--', 'true'])
    const read = readText(args, 'name')

    expect(read.ok).toBe(false)
    expect(args.positional).toEqual(['run', 'job'])
  })

  it('reports a flag nobody declared', () => {
    const args = parseArgv(['run', '--name=job', '--nope=1', '--also'])

    expect(unknownFlags(args, ['name'])).toEqual(['nope', 'also'])
    expect(unknownFlags(args, ['name', 'nope', 'also'])).toEqual([])
  })
})

describe('duration parsing', () => {
  it.each([
    ['30s', 30_000],
    ['500ms', 500],
    ['2m', 120_000],
    ['1h', 3_600_000],
    ['45', 45_000],
    [' 30s ', 30_000],
    ['0', 0],
  ])('reads %s as %i ms', (value, expected) => {
    expect(parseDuration(value)).toBe(expected)
  })

  it.each(['soon', '-5', '1.5s', '', '30 s', '30sec', 's'])('refuses %s', (value) => {
    expect(parseDuration(value)).toBeUndefined()
  })
})

describe('every declared flag reaches the CLI rather than the runtime that launched it', () => {
  it.each(DECLARED_FLAGS)('passes %s through', async (flag) => {
    const ran = await runCli(['nope', flag])

    expect(`${ran.stdout}${ran.stderr}`).toContain('cronheart')
    expect([0, 64]).toContain(ran.status)
  })

  it('shows what the collision looks like, so the rule above is not folklore', async () => {
    const ran = await runCli(['nope', '--env-file=/tmp/nowhere'])

    expect(`${ran.stdout}${ran.stderr}`).not.toContain('cronheart')
    expect(ran.status).toBe(9)
  })
})
