import { readFileSync } from 'node:fs'

const document = readFileSync(new URL('openapi.json', import.meta.url), 'utf8')

globalThis.fetch = () =>
  Promise.resolve(
    new Response(document, { status: 200, headers: { 'content-type': 'application/json' } }),
  )
