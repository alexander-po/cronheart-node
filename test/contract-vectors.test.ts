import { afterAll, describe, expect, it } from 'vitest'
import { errorForStatus } from '../src/api/classify.js'
import {
  ApiAuthenticationError,
  ApiChannelDeliveryError,
  ApiConflictError,
  ApiForbiddenError,
  ApiNotFoundError,
  ApiPlanRestrictionError,
  ApiRateLimitError,
  ApiTransportError,
  ApiUnexpectedResponseError,
  ApiValidationError,
} from '../src/api/errors.js'
import { EMPTY_PROBLEM } from '../src/api/problem.js'
import { truncateBody } from '../src/ping/body.js'
import { classifyStatus, isAccepted } from '../src/ping/outcome.js'
import { parseRetryAfter } from '../src/transport/retry-after.js'
import { InvalidActionError } from '../src/wiring/errors.js'
import { assertEmittableAction } from '../src/wiring/validate.js'
import { classifyAction, contract } from './support/server-model.js'
import {
  type Adapter,
  type Subject,
  type VectorCase,
  type VectorFile,
  encodeByteString,
  loadVectorFiles,
  runCase,
} from './support/vectors.js'

const SDK_SUBJECTS: Readonly<Record<string, Subject>> = {
  'ping.assertEmittableAction': (input) => {
    assertEmittableAction((input as { action: string | null }).action)
  },
  'body.truncate': (input) => {
    const { body, mode } = input as { body: unknown; mode: 'head' | 'tail' }

    return truncateBody(encodeByteString(body), mode)
  },
  'ping.classifyResponse': (input) => {
    const { status, body } = input as { status: number; body: string }
    const outcome = classifyStatus(status, body)

    return { outcome, ok: isAccepted(outcome) }
  },
  'api.classifyStatus': (input) => {
    const { status, detail, deliversDownstream } = input as {
      status: number
      detail: string | null
      deliversDownstream?: boolean
    }

    throw errorForStatus(
      status,
      { ...EMPTY_PROBLEM, detail: detail ?? undefined },
      { request: { method: 'GET', path: '/api/v1/monitors' }, deliversDownstream },
    )
  },
  'http.parseRetryAfter': (input) => {
    const { header, now } = input as { header: string | null; now: string }

    return { seconds: parseRetryAfter(header, Date.parse(now)) ?? null }
  },
}

// A hand-written model of the server's action mapper, living only in test scope. No shipped
// module imports it, so these cases are a cross-language port model rather than a statement
// about this SDK, and they are counted and reported apart from the ones that are.
const SERVER_MODEL_SUBJECTS: Readonly<Record<string, Subject>> = {
  'ping.classifyAction': (input) => classifyAction((input as { action: string | null }).action),
}

const adapter: Adapter = {
  subjects: { ...SDK_SUBJECTS, ...SERVER_MODEL_SUBJECTS },
  errorClasses: {
    InvalidAction: InvalidActionError,
    Authentication: ApiAuthenticationError,
    PlanRestriction: ApiPlanRestrictionError,
    Forbidden: ApiForbiddenError,
    NotFound: ApiNotFoundError,
    Conflict: ApiConflictError,
    Validation: ApiValidationError,
    RateLimit: ApiRateLimitError,
    ChannelDelivery: ApiChannelDeliveryError,
    UnexpectedResponse: ApiUnexpectedResponseError,
    ApiTransport: ApiTransportError,
  },
}

type Side = 'sdk' | 'serverModel'

function sideOf(vectorCase: VectorCase, file: VectorFile): Side {
  const name = vectorCase.subject ?? file.default_subject

  return name !== undefined && Object.hasOwn(SERVER_MODEL_SUBJECTS, name) ? 'serverModel' : 'sdk'
}

function label(vectorCase: VectorCase, file: VectorFile): string {
  return sideOf(vectorCase, file) === 'serverModel'
    ? `server model — ${vectorCase.id}`
    : vectorCase.id
}

const files = loadVectorFiles(new URL('../contract/vectors/', import.meta.url))
const declaredTotal = files.reduce((total, file) => total + file.case_count, 0)

const declared: Record<Side, number> = { sdk: 0, serverModel: 0 }

for (const file of files) {
  for (const vectorCase of file.cases) {
    declared[sideOf(vectorCase, file)] += 1
  }
}

const executed: Record<Side, number> = { sdk: 0, serverModel: 0 }
const skipped: string[] = []

describe('conformance vectors', () => {
  it('finds every vector group, so a file that stops loading cannot pass as an empty suite', () => {
    expect(files.map((file) => file.group)).toEqual([
      'api.status_classification',
      'body.truncation',
      'ping.action_to_kind',
      'ping.response_classification',
      'http.retry_after',
    ])
  })

  it('counts the cases that exercise this SDK apart from the ones that only model the server', () => {
    expect(declared).toEqual({ sdk: 82, serverModel: 35 })
  })

  describe.each(files)('$group', (file) => {
    it('carries as many cases as it declares', () => {
      expect(file.cases.length).toBe(file.case_count)
    })

    it('is written against the contract version the SDK was built against', () => {
      expect(file.contract_version).toBe(contract.contract_version)
    })

    it.each(file.cases.map((vectorCase) => [label(vectorCase, file), vectorCase] as const))(
      '%s',
      async (_label, vectorCase) => {
        const outcome = await runCase(vectorCase, file.default_subject, adapter)

        if (outcome.executed) {
          executed[sideOf(vectorCase, file)] += 1
        } else {
          skipped.push(vectorCase.id)
        }

        expect(outcome.failures).toEqual([])
      },
    )
  })
})

afterAll(() => {
  process.stderr.write(
    `conformance vectors — ${executed.sdk} case(s) against the SDK, ${executed.serverModel} against the test model of the server\n`,
  )

  expect(executed).toEqual(declared)
  expect(executed.sdk + executed.serverModel + skipped.length).toBe(declaredTotal)
  expect(skipped).toEqual([])
})
