import { afterAll, describe, expect, it } from 'vitest'
import { truncateBody } from '../src/ping/body.js'
import { classifyStatus, isAccepted } from '../src/ping/outcome.js'
import { parseRetryAfter } from '../src/transport/retry-after.js'
import { InvalidActionError } from '../src/wiring/errors.js'
import { assertEmittableAction } from '../src/wiring/validate.js'
import { classifyAction, contract } from './support/server-model.js'
import { type Adapter, encodeByteString, loadVectorFiles, runCase } from './support/vectors.js'

const adapter: Adapter = {
  subjects: {
    'ping.classifyAction': (input) => classifyAction((input as { action: string | null }).action),
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
    'http.parseRetryAfter': (input) => {
      const { header, now } = input as { header: string | null; now: string }

      return { seconds: parseRetryAfter(header, Date.parse(now)) ?? null }
    },
  },
  errorClasses: { InvalidAction: InvalidActionError },
}

const files = loadVectorFiles(new URL('../contract/vectors/', import.meta.url))
const declaredTotal = files.reduce((total, file) => total + file.case_count, 0)

let executed = 0
const skipped: string[] = []

describe('conformance vectors', () => {
  it('finds every vector group, so a file that stops loading cannot pass as an empty suite', () => {
    expect(files.map((file) => file.group)).toEqual([
      'body.truncation',
      'ping.action_to_kind',
      'ping.response_classification',
      'http.retry_after',
    ])
  })

  describe.each(files)('$group', (file) => {
    it('carries as many cases as it declares', () => {
      expect(file.cases.length).toBe(file.case_count)
    })

    it('is written against the contract version the SDK was built against', () => {
      expect(file.contract_version).toBe(contract.contract_version)
    })

    it.each(file.cases.map((vectorCase) => [vectorCase.id, vectorCase] as const))(
      '%s',
      async (_id, vectorCase) => {
        const outcome = await runCase(vectorCase, file.default_subject, adapter)

        if (outcome.executed) {
          executed += 1
        } else {
          skipped.push(vectorCase.id)
        }

        expect(outcome.failures).toEqual([])
      },
    )
  })
})

afterAll(() => {
  expect(executed + skipped.length).toBe(declaredTotal)
  expect(skipped).toEqual([])
})
