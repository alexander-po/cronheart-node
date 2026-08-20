import { readFileSync } from 'node:fs'
import { defineConfig } from 'tsdown'

const pkg = JSON.parse(
  readFileSync(new URL('package.json', import.meta.url), 'utf8'),
) as { version: string }

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    api: 'src/api.ts',
    sync: 'src/sync.ts',
    testing: 'src/testing.ts',
    cli: 'src/cli.ts',
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
  define: {
    __CRONHEART_VERSION__: JSON.stringify(pkg.version),
  },
})
