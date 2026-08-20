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

// Built apart from the library entries, for the same reason the command-line tool is: a
// chunk shared with the root would move part of the check-in path out of dist/index.mjs and
// charge every consumer of the ping client for glue that exists only because a management
// client ships alongside it. Measured, not assumed — sharing costs the ping entry 266 bytes.
export default defineConfig({
  entry: { api: 'src/api.ts' },
  format: ['esm', 'cjs'],
  outExtensions: ({ format }) =>
    format === 'cjs' ? { js: '.cjs', dts: '.d.cts' } : { js: '.mjs', dts: '.d.mts' },
  dts: true,
  clean: false,
  target: 'node22',
  plugins: [withoutRegionMarkers],
  define: {
    __CRONHEART_VERSION__: JSON.stringify(pkg.version),
    __CRONHEART_CONTRACT_VERSION__: JSON.stringify(contract.contract_version),
  },
})
