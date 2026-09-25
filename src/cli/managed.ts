import { createCronheartApi } from '../api/client.js'
import { createSignupClient } from '../api/signup.js'
import type {
  CronheartApi,
  CronheartApiOptions,
  SignupClient,
  SignupClientOptions,
} from '../api/types.js'

export type Opened<T> =
  | { readonly ok: true; readonly api: T }
  | { readonly ok: false; readonly problem: string }

export type Managed = Opened<CronheartApi>

function opened<T>(build: () => T): Opened<T> {
  try {
    return { ok: true, api: build() }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)

    return {
      ok: false,
      problem: message.replace(/^cronheart:\s*/, ''),
    }
  }
}

export function openManagementClient(options: CronheartApiOptions = {}): Managed {
  return opened(() => createCronheartApi(options))
}

export function openSignupClient(options: SignupClientOptions = {}): Opened<SignupClient> {
  return opened(() => createSignupClient(options))
}
