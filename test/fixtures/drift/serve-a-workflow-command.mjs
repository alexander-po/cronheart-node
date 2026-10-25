globalThis.fetch = () =>
  Promise.resolve(
    new Response('\n::error::injected', {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
  )
