export const API_BASE_PATH = '/api/v1'

export const API_TOKEN_PREFIX = 'cmk_'

export const API_PAGE_LIMIT_MAX = 100

export const API_PAGE_LIMIT_DEFAULT = 50

export const API_MAX_PAGES = 10000

export const API_IDEMPOTENCY_TTL_SECONDS = 60

export const API_IDEMPOTENCY_KEY_MAX_LENGTH = 255

export const MONITOR_NAME_MAX_LENGTH = 120

export const MONITOR_GRACE_SECONDS_MAX = 86400

export const INTERVAL_SECONDS_MIN = 30

export const INTERVAL_SECONDS_MAX = 31622400

export const CRON_FIELD_COUNT = 5

export const SIMPLE_SCHEDULES = [
  'every_minute',
  'every_5_minutes',
  'every_10_minutes',
  'every_15_minutes',
  'every_30_minutes',
  'hourly',
  'every_2_hours',
  'every_6_hours',
  'daily',
  'daily_morning',
  'weekly',
  'monthly',
] as const

export const SNOOZE_DURATIONS = ['1h', '4h', '1d', '1w'] as const

export const CHANNEL_KINDS = ['email', 'telegram', 'slack', 'discord', 'webhook'] as const

export const MONITOR_STATUSES = ['new', 'up', 'late', 'down', 'paused'] as const

export const PLAN_KEYS = ['free', 'starter', 'growth', 'scale'] as const

export const SCHEDULE_KINDS = ['cron', 'interval', 'simple'] as const

export const MONITOR_NAME_MIN_LENGTH = 2

export const MONITOR_GRACE_SECONDS_MIN = 0

export const SCHEDULE_EXPR_MAX_LENGTH = 120

export const TIMEZONE_MAX_LENGTH = 64

export const CHANNEL_LABEL_MIN_LENGTH = 2

export const CHANNEL_LABEL_MAX_LENGTH = 80

export const CRON_ALIASES = [
  '@yearly',
  '@annually',
  '@monthly',
  '@weekly',
  '@daily',
  '@midnight',
  '@hourly',
] as const

export const DEFAULT_API_TIMEOUT_MS = 10000

export const DEFAULT_API_RETRIES = 2

export const CREATE_RETRY_BASE_DELAY_MS = 250
