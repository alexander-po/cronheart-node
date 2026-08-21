globalThis.fetch = () => {
  throw new Error('the drift job reached the network')
}
