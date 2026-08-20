import { readFileSync } from 'node:fs'
import { defineConfig } from 'tsdown'

const pkg = JSON.parse(readFileSync(new URL('package.json', import.meta.url), 'utf8')) as {
  version: string
}

const contract = JSON.parse(
  readFileSync(new URL('contract/cronheart-contract.json', import.meta.url), 'utf8'),
) as { contract_version: string }

const withoutRegionMarkers = {
  name: 'without-region-markers',
  renderChunk(code: string): { code: string; map: null } {
    return { code: code.replace(/^\/\/#(?:region|endregion).*\n/gm, ''), map: null }
  },
}

// Built after the library entries and never sharing a chunk with them: a shared chunk would
// move the ping path out of dist/index.mjs and charge every consumer of the package for
// import glue that exists only because a command-line tool ships alongside it.
export default defineConfig({
  entry: { cli: 'src/cli.ts' },
  format: ['esm'],
  outExtensions: () => ({ js: '.mjs' }),
  dts: false,
  clean: false,
  target: 'node22',
  plugins: [withoutRegionMarkers],
  define: {
    __CRONHEART_VERSION__: JSON.stringify(pkg.version),
    __CRONHEART_CONTRACT_VERSION__: JSON.stringify(contract.contract_version),
  },
})
