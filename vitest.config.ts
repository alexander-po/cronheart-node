import { readFileSync } from 'node:fs'
import { defineConfig } from 'vitest/config'

const pkg = JSON.parse(
  readFileSync(new URL('package.json', import.meta.url), 'utf8'),
) as { version: string }

const contract = JSON.parse(
  readFileSync(new URL('contract/cronheart-contract.json', import.meta.url), 'utf8'),
) as { contract_version: string }

export default defineConfig({
  define: {
    __CRONHEART_VERSION__: JSON.stringify(pkg.version),
    __CRONHEART_CONTRACT_VERSION__: JSON.stringify(contract.contract_version),
  },
  test: {
    setupFiles: ['test/support/setup.ts'],
    include: ['test/**/*.test.ts'],
    exclude: ['test/fixture-consumer/**'],
  },
})
