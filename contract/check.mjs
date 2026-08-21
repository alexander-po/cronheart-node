import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { isDeepStrictEqual } from 'node:util'

const UNRESOLVED = Symbol('unresolved')
const VERSION_SHAPE = /^\d+\.\d+\.\d+$/
const ARRAY_INDEX = /^(0|[1-9][0-9]*)$/
const SDK_LITERAL = /^[A-Z][A-Z0-9_]*$/

// The paths are arguments so that the check can be pointed at a fixture and proven able
// to fail, the way the source guard is.
const contractUrl =
  process.argv[2] === undefined
    ? new URL('cronheart-contract.json', import.meta.url)
    : pathToFileURL(process.argv[2])

// The values live in a build-time module that is never published, so that holding a wire
// fact costs the package nothing on its public surface. The published root is read too,
// but only to sweep it: a wire literal exported to consumers still has to be accounted for.
const anchorsUrl =
  process.argv[3] === undefined
    ? new URL('../build/contract-anchors.mjs', import.meta.url)
    : pathToFileURL(process.argv[3])

const publishedUrl =
  process.argv[4] === undefined
    ? new URL('../dist/index.mjs', import.meta.url)
    : pathToFileURL(process.argv[4])

// Both published entry points are swept, not only the root: the management client is a
// separate bundle, so a wire literal added there would otherwise never be accounted for.
const managementUrl =
  process.argv[5] === undefined
    ? new URL('../dist/api.mjs', import.meta.url)
    : pathToFileURL(process.argv[5])

// The source is swept alongside the built modules, because a module export is a decision a
// constant can decline to take part in: the seven bounds this sweep first went red on were
// all exported from their own file and simply never re-exported here. A sixth argument adds
// a second tree to the sweep rather than replacing src/, so a fixture proving the sweep can
// fail contributes exactly its own failures.
const sourceRoots = [
  new URL('../src/', import.meta.url),
  ...(process.argv[6] === undefined ? [] : [pathToFileURL(`${process.argv[6].replace(/\/*$/, '/')}`)]),
]

const SOURCE_CONSTANT = /^(?:export\s+)?const\s+([A-Z][A-Z0-9_]*)\b/gm

const contract = JSON.parse(readFileSync(contractUrl, 'utf8'))

function resolvePointer(pointer) {
  return pointer.split('/').slice(1).reduce(step, contract)
}

function step(node, token) {
  if (node === UNRESOLVED || node === null || typeof node !== 'object') {
    return UNRESOLVED
  }

  const key = token.replaceAll('~1', '/').replaceAll('~0', '~')

  if (Array.isArray(node)) {
    return ARRAY_INDEX.test(key) && Number(key) < node.length ? node[Number(key)] : UNRESOLVED
  }

  return Object.hasOwn(node, key) ? node[key] : UNRESOLVED
}

function problemWith(anchor, position) {
  if (typeof anchor.id !== 'string' || anchor.id === '') {
    return `${position} has no id`
  }

  if (typeof anchor.pointer !== 'string' || !anchor.pointer.startsWith('/')) {
    return `${anchor.id} has no JSON Pointer`
  }

  const resolved = resolvePointer(anchor.pointer)

  if (resolved === UNRESOLVED) {
    return `${anchor.id} — ${anchor.pointer} does not resolve`
  }

  if (Object.hasOwn(anchor, 'value') && !isDeepStrictEqual(resolved, anchor.value)) {
    return `${anchor.id} — ${anchor.pointer} is ${JSON.stringify(resolved)}, the contract states ${JSON.stringify(anchor.value)}`
  }

  return undefined
}

function inspect(anchor, position) {
  if (anchor === null || typeof anchor !== 'object' || Array.isArray(anchor)) {
    return { key: position, assertsValue: false, problem: `${position} is not an object` }
  }

  return {
    key: typeof anchor.id === 'string' && anchor.id !== '' ? anchor.id : position,
    assertsValue: Object.hasOwn(anchor, 'value'),
    problem: problemWith(anchor, position),
  }
}

// Anchors the SDK holds as constants, and the ones it deliberately does not.
// An anchor in neither list fails: adding one to the contract has to be a decision
// about the SDK, not a silent no-op.
const HELD_AS_CONSTANTS = {
  'ping.body.cap_bytes': 'PING_BODY_CAP_BYTES',
  'ping.runtime_header.name': 'RUNTIME_HEADER_NAME',
  'ping.runtime_header.max_value': 'RUNTIME_HEADER_MAX_VALUE',
  'ping.default_base_url': 'DEFAULT_BASE_URL',
  'ping.request.method': 'PING_METHOD',
  'ping.action.emit': 'PING_EMITTABLE_ACTIONS',
  'ping.responses.duplicate_body': 'PING_DUPLICATE_BODY',
  'ping.responses.status_to_outcome': 'PING_STATUS_OUTCOMES',
  'body_truncation.marker': 'PING_BODY_TRUNCATION_MARKER',
  'body_truncation.budget_bytes': 'PING_BODY_BUDGET_BYTES',
  'retry_after.max_seconds': 'RETRY_AFTER_MAX_SECONDS',
  'vocabulary.ping_kind': 'PING_ACTIONS',
  'vocabulary.ping_outcome': 'PING_OUTCOMES',
  'api.base_path': 'API_BASE_PATH',
  'api.auth.token_prefix': 'API_TOKEN_PREFIX',
  'api.pagination.limit_max': 'API_PAGE_LIMIT_MAX',
  'api.pagination.limit_default': 'API_PAGE_LIMIT_DEFAULT',
  'api.pagination.max_pages': 'API_MAX_PAGES',
  'api.idempotency.ttl_seconds': 'API_IDEMPOTENCY_TTL_SECONDS',
  'api.idempotency.max_key_length': 'API_IDEMPOTENCY_KEY_MAX_LENGTH',
  'api.idempotency.finalised_retention_hours': 'API_IDEMPOTENCY_RETENTION_HOURS',
  'constraints.monitor.name.min': 'MONITOR_NAME_MIN_LENGTH',
  'constraints.monitor.name.max': 'MONITOR_NAME_MAX_LENGTH',
  'constraints.schedule_expr.max': 'SCHEDULE_EXPR_MAX_LENGTH',
  'constraints.tz.max': 'TIMEZONE_MAX_LENGTH',
  'constraints.channel.label.min': 'CHANNEL_LABEL_MIN_LENGTH',
  'constraints.channel.label.max': 'CHANNEL_LABEL_MAX_LENGTH',
  'constraints.channel.address.required_for': 'CHANNEL_ADDRESS_KINDS',
  'constraints.channel.chat_id.required_for': 'CHANNEL_CHAT_ID_KINDS',
  'constraints.channel.webhook_url.required_for': 'CHANNEL_WEBHOOK_URL_KINDS',
  'constraints.channel.secret.required_for': 'CHANNEL_SECRET_KINDS',
  'constraints.grace.min': 'MONITOR_GRACE_SECONDS_MIN',
  'constraints.grace.max': 'MONITOR_GRACE_SECONDS_MAX',
  'constraints.interval.min': 'INTERVAL_SECONDS_MIN',
  'constraints.interval.max': 'INTERVAL_SECONDS_MAX',
  'constraints.simple.allowlist': 'SIMPLE_SCHEDULES',
  'constraints.cron.field_count': 'CRON_FIELD_COUNT',
  'constraints.cron.aliases': 'CRON_ALIASES',
  'vocabulary.snooze': 'SNOOZE_DURATIONS',
  'vocabulary.channel_kind': 'CHANNEL_KINDS',
  'vocabulary.monitor_status': 'MONITOR_STATUSES',
  'vocabulary.plan_key': 'PLAN_KEYS',
  'vocabulary.schedule_kind': 'SCHEDULE_KINDS',
}

const DEFERRED = {
  'ping.action.pattern':
    'the SDK emits a closed union of literals and never builds the segment from a value, so the route pattern is a server-side gate it holds no constant for; the conformance vectors read it from this file',
  'ping.uuid.pattern':
    'the SDK accepts only the canonical 8-4-4-4-12 shape, which this looser route pattern strictly contains, so testing both would decide nothing the narrower test has not already decided',
  'ping.dedup.window_seconds':
    'server behaviour the ping path neither implements nor compensates for',
}

// The other direction: a wire literal the SDK holds and the contract does not state is how
// a fact stops being checked without anyone deciding that it should. Grouped by the reason
// rather than one line each, because the reason is what a reader has to agree with.
const UNANCHORED = {
  'the version stamps this package carries, not facts stated inside the contract': [
    'CONTRACT_VERSION',
    'SDK_VERSION',
  ],
  'budgets, timeouts and retry counts this client picks for itself and sends to nobody': [
    'BODY_RELEASE_BUDGET_MS',
    'BUFFERED_STDIO_POLL_MS',
    'COMPACTION_SLACK_BYTES',
    'CREATE_RETRY_BASE_DELAY_MS',
    'DEFAULT_API_RETRIES',
    'DEFAULT_API_TIMEOUT_MS',
    'DEFAULT_FLUSH_TIMEOUT_MS',
    'DEFAULT_KILL_AFTER_MS',
    'DEFAULT_RETRIES',
    'DEFAULT_TIMEOUT_MS',
    'IN_STEP_MS',
    'LINGER_BUDGET_MS',
    'LONGEST_HELD_TIMEOUT_MS',
    'MAX_OUTPUT_TAIL_BYTES',
    'MAX_RETRIES',
    'MAX_TIMER_MS',
    'REDACTION_REACH_BYTES',
    'RETRY_FLOOR_DELAY_MS',
    'STDERR_DRAIN_BUDGET_MS',
    'STDIN_CAP_BYTES',
    'TERMINAL_CHECK_IN_BUDGET_MS',
  ],
  'shapes this client reads with, each narrower than or absent from what the contract states': [
    'ASCII_DIGITS',
    'ASCTIME',
    'BUILT_IN_SECRETS',
    'CANONICAL_SHAPE',
    'CHANNEL_ID',
    'CONFIGURED_MONITOR',
    'DELTA_SECONDS',
    'DURATION',
    'EMITTABLE',
    'GROUPED_LIKE_AN_ID',
    'HEX_AND_DASHES',
    'IDEMPOTENCY_KEY',
    'IDENTIFIER_SEGMENT',
    'IMF_FIXDATE',
    'LOOPBACK',
    'MONITOR_UUID',
    'CRON_FIELD',
    'CRON_WORDS',
    'MONTHS',
    'OPENS_LIKE_AN_ID',
    'PREFIXED_OFFSET',
    'PURE_STEP',
    'PING_PATH',
    'RFC_850',
    'SCALE',
    'TOKEN_BODY',
    'TRUTHY',
    'USER_AGENT',
    'UTC_DESIGNATOR',
  ],
  'the command line’s own vocabulary — flags, exit codes, signals and the variables it reads': [
    'API_KEY_OPTION',
    'API_KEY_VARIABLE',
    'CHANNELS_PAGE',
    'DASHBOARD',
    'DEFAULT_ENV_FILE',
    'EXAMPLE_BINARY',
    'EXIT_DRIFT',
    'EXIT_INTERNAL',
    'EXIT_NOT_EXECUTABLE',
    'EXIT_NOT_FOUND',
    'EXIT_OK',
    'EXIT_PROBLEM',
    'EXIT_TIMED_OUT',
    'EXIT_USAGE',
    'FLAGS',
    'FORWARDED_SIGNALS',
    'OWNER_ONLY',
    'REDACT_ENV',
    'REDACT_FLAG',
    'SECRET_FIELD',
    'SIGNAL_EXIT_BASE',
    'SIGNALS_REACH_A_GROUP',
    'WITHHELD_FROM_THE_CHILD',
    'WRAPPERS',
  ],
  'sentences this package writes, which no service states and no reader parses': [
    'CANCELLED',
    'DOCTOR_HELP',
    'EMPTY_PROBLEM',
    'ENVIRONMENT',
    'HELP',
    'INIT_HELP',
    'NOT_CHECKED',
    'NOT_STARTED',
    'OFFSET_FORMS',
    'OPT_OUT_INSTEAD',
    'OUT_OF_BUDGET',
    'PAGES',
    'PAID_ONLY_NOTICE',
    'PING_HELP',
    'REASONS',
    'REDACTION',
    'RUN_HELP',
    'SYNC_HELP',
    'UNREACHABLE',
    'WOULD_ALERT_NOBODY',
  ],
  'keys and markers internal to this package': [
    'BRAND',
    'CLIENT_KEY',
    'CONFIG_BRAND',
    'EXPIRED',
    'MARKER',
    'STORE_KEY',
  ],
  'the scheduler adapters’ own vocabulary — the sentences they say and what they read to say them': [
    'DIALECT',
    'DIALECT_WARNING',
    'HOUR_FIELD_INDEX',
    'NOTHING_REGISTERED',
    'ONE_OFF_WARNING',
    'OVERLAP_ADVICE',
    'OVERLAP_WARNING',
    'PARALLEL_WARNING',
    'ZONE_FREE_ALIASES',
    'ZONE_WARNING',
  ],
  'the reconciler’s own vocabulary, layout and sentences, which no service states': [
    'ACTION_WIDTH',
    'CONCURRENT_RUN',
    'CONFIG_NAMES',
    'CONFIRMATION',
    'CONFLICT_REASON',
    'CRON_FIELDS',
    'DETAIL_INDENT',
    'EVERY',
    'EVERY_SCALE',
    'FIELD_WIDTH',
    'HEADINGS',
    'KEY_PREFIX',
    'NOBODY',
    'SAY_SO_INSTEAD',
    'NO_CHANNELS',
    'NO_TERMINAL_TO_ASK',
    'NO_MORE_CREATES',
    'ORPHAN_NOTE',
    'ORPHAN_TAKES',
    'OTHER_FORMS',
    'QUIET_MARK',
    'ROUTING_MODES',
    'SCOPE_NOTICE',
    'SILENT_MARK',
    'SUPPRESSED',
    'EMPTY_CONFIGURATION',
    'SOMETHING_FAILED',
    'TWO_OF_ONE_NAME',
    'TYPESCRIPT',
    'UNCHANGED_HIDDEN',
  ],
}

const unanchoredNames = new Set(Object.values(UNANCHORED).flat())

async function moduleAt(url) {
  return existsSync(url) ? import(url.href) : undefined
}

function compareAgainstSdk(anchors, sdk) {
  return anchors.flatMap((anchor) => {
    const exportName = HELD_AS_CONSTANTS[anchor.id]

    if (exportName === undefined) {
      return Object.hasOwn(DEFERRED, anchor.id)
        ? []
        : [`${anchor.id} — no SDK constant holds it and it is not recorded as deferred`]
    }

    if (!Object.hasOwn(sdk, exportName)) {
      return [`${anchor.id} — the SDK no longer exports ${exportName}`]
    }

    const held = sdk[exportName]
    const stated = resolvePointer(anchor.pointer)

    return isDeepStrictEqual(held, stated)
      ? []
      : [
          `${anchor.id} — the SDK holds ${JSON.stringify(held)}, the contract states ${JSON.stringify(stated)}`,
        ]
  })
}

function sdkLiterals(modules) {
  return [
    ...new Set(
      modules.flatMap((module) =>
        Object.entries(module)
          .filter(([name, value]) => SDK_LITERAL.test(name) && typeof value !== 'function')
          .map(([name]) => name),
      ),
    ),
  ]
}

function sourceFiles(root) {
  return existsSync(root)
    ? readdirSync(root).flatMap((name) => {
        const child = new URL(name, root)

        return statSync(child).isDirectory()
          ? sourceFiles(new URL(`${name}/`, root))
          : name.endsWith('.ts')
            ? [child]
            : []
      })
    : []
}

function declaredConstants(roots) {
  return [
    ...new Set(
      roots.flatMap((root) =>
        sourceFiles(root).flatMap((file) =>
          [...readFileSync(file, 'utf8').matchAll(SOURCE_CONSTANT)].map(([, name]) => name),
        ),
      ),
    ),
  ]
}

function compareAgainstLedgers(modules, roots, anchorIds) {
  const held = new Set(Object.values(HELD_AS_CONSTANTS))
  const literals = sdkLiterals(modules)
  const declared = declaredConstants(roots)
  const accounted = (name) => held.has(name) || unanchoredNames.has(name)

  return [
    ...literals
      .filter((name) => !accounted(name))
      .map(
        (name) =>
          `${name} — the SDK holds it, no contract anchor states it, and it is not recorded as unanchored`,
      ),
    ...declared
      .filter((name) => !accounted(name) && !literals.includes(name))
      .map(
        (name) =>
          `${name} — the source declares it, no contract anchor states it, and it is not recorded as unanchored`,
      ),
    ...[...unanchoredNames]
      .filter((name) => !literals.includes(name) && !declared.includes(name))
      .map((name) => `${name} — recorded as unanchored but the source no longer declares it`),
    ...[...Object.keys(HELD_AS_CONSTANTS), ...Object.keys(DEFERRED)]
      .filter((id) => !anchorIds.has(id))
      .map((id) => `${id} — recorded in a ledger but the contract has no anchor by that name`),
  ]
}

function report(failures) {
  for (const failure of failures) {
    process.stderr.write(`  - ${failure}\n`)
  }

  process.stderr.write(`contract check FAILED — ${failures.length} problem(s)\n`)
  process.exit(1)
}

const anchors = contract.anchors

if (!Array.isArray(anchors) || anchors.length === 0) {
  report(['"anchors" is missing, is not an array, or is empty'])
}

const outcomes = anchors.map((anchor, index) => inspect(anchor, `anchors[${index}]`))
const validated = new Map(outcomes.map((outcome) => [outcome.key, outcome]))
const anchorIds = new Set(outcomes.map((outcome) => outcome.key))

const failures = [
  ...(VERSION_SHAPE.test(contract.contract_version ?? '')
    ? []
    : ['"contract_version" is missing or is not a three-part version']),
  ...outcomes.map((outcome) => outcome.problem).filter((problem) => problem !== undefined),
  ...(validated.size === anchors.length
    ? []
    : [
        `validated ${validated.size} anchor(s) against ${anchors.length} entries — anchor ids must be unique`,
      ]),
]

if (failures.length > 0) {
  report(failures)
}

const valueAssertions = outcomes.filter((outcome) => outcome.assertsValue).length
const anchorsModule = await moduleAt(anchorsUrl)
const publishedModule = await moduleAt(publishedUrl)
const managementModule = await moduleAt(managementUrl)

if (anchorsModule === undefined || publishedModule === undefined || managementModule === undefined) {
  report(['build/ or dist/ is missing — build before checking the contract against the SDK'])
}

const drift = [
  ...compareAgainstSdk(anchors, anchorsModule),
  ...compareAgainstLedgers([anchorsModule, publishedModule, managementModule], sourceRoots, anchorIds),
]

if (drift.length > 0) {
  report(drift)
}

const held = Object.keys(HELD_AS_CONSTANTS).length
const deferred = Object.keys(DEFERRED).length
const unanchored = unanchoredNames.size

process.stdout.write(
  `contract ${contract.contract_version} — ${validated.size} anchor(s) resolved, ${valueAssertions} value assertion(s), ${held} held by the SDK, ${deferred} deferred, ${unanchored} constant(s) recorded as unanchored — ok\n`,
)
