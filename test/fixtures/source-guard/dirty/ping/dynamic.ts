export async function later(): Promise<unknown> {
  const module = await import('../api/manage.js')

  return module
}
