import { manage } from '../api/manage.js'

export function forward(): never {
  return manage()
}
