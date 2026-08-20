import { manage } from '../api/manage.js'

export async function beat(url: string): Promise<void> {
  const response = await fetch(url)

  if (response.status !== 200) {
    throw new Error('the job now fails because the check-in did')
  }

  manage()
}

export function label(url: string): string {
  return `checked ${String(fetch(url))}`
}

export function handBack(error: unknown): Promise<void> {
  return Promise.reject(error)
}
