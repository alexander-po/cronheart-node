import { readFileSync } from 'node:fs'
import { defineConfig } from 'tsdown'

const pkg = JSON.parse(
  readFileSync(new URL('package.json', import.meta.url), 'utf8'),
) as { version: string }

const contract = JSON.parse(
  readFileSync(new URL('contract/cronheart-contract.json', import.meta.url), 'utf8'),
) as { contract_version: string }

// Rolldown labels every inlined module with a //#region pair, which ships to whoever installs
// the package and costs more of the ping entry's size budget than its redaction patterns do.
const withoutRegionMarkers = {
  name: 'without-region-markers',
  renderChunk(code: string): { code: string; map: null } {
    return { code: code.replace(/^\/\/#(?:region|endregion).*\n/gm, ''), map: null }
  },
}

const define = {
  __CRONHEART_VERSION__: JSON.stringify(pkg.version),
  __CRONHEART_CONTRACT_VERSION__: JSON.stringify(contract.contract_version),
}

export default defineConfig([
  {
    entry: {
      index: 'src/index.ts',
      api: 'src/api.ts',
      sync: 'src/sync.ts',
      testing: 'src/testing.ts',
      croner: 'src/integrations/croner.ts',
      cron: 'src/integrations/cron.ts',
      'node-cron': 'src/integrations/node-cron.ts',
      'node-schedule': 'src/integrations/node-schedule.ts',
      bullmq: 'src/integrations/bullmq.ts',
      nestjs: 'src/integrations/nestjs.ts',
    },
    format: ['esm', 'cjs'],
    outExtensions: ({ format }) =>
      format === 'cjs' ? { js: '.cjs', dts: '.d.cts' } : { js: '.mjs', dts: '.d.mts' },
    dts: true,
    clean: true,
    target: 'node22',
    define,
    plugins: [withoutRegionMarkers],
  },
  {
    entry: { 'contract-anchors': 'src/contract-anchors.ts' },
    outDir: 'build',
    format: ['esm'],
    outExtensions: () => ({ js: '.mjs' }),
    dts: false,
    clean: true,
    target: 'node22',
    define,
    plugins: [withoutRegionMarkers],
  },
])
