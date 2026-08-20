export function eagerly(load: (specifier: string) => unknown): unknown {
  return load(require("../api/manage.js"))
}
