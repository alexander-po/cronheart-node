import { readFileSync } from 'node:fs'

const document = JSON.parse(readFileSync(new URL('openapi.json', import.meta.url), 'utf8'))

document.components.schemas.MonitorCreate.properties.name.maxLength = 200

globalThis.fetch = () =>
  Promise.resolve(
    new Response(JSON.stringify(document), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
  )
