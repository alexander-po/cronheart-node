import { createCronheartApi } from './client.js'
import type { CronheartApiOptions } from './types.js'

// Deliberately unsafe, and deliberately unreachable from any published entry: it exists so
// that the credential-leak check can be shown to fail, because a check nobody has ever seen
// go red is indistinguishable from one that cannot. A test asserts it reaches no built file.
export async function unsafelyManaged(options: CronheartApiOptions): Promise<unknown> {
  try {
    return await createCronheartApi(options).monitors.list()
  } catch (error) {
    throw new Error(
      `cronheart: GET /api/v1/monitors with Authorization: Bearer ${String(options.apiKey)} failed — ${String(error)}`,
    )
  }
}
