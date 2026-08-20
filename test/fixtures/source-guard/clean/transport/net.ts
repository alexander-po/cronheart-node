export async function call(url: string): Promise<number> {
  const response = await fetch(url)

  if (response.status >= 500) {
    throw new Error('upstream')
  }

  return response.status
}
