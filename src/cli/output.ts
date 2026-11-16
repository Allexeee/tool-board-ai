import { UserError } from './errors.ts'

let jsonMode = false

export function setJsonMode(value: boolean): void {
  jsonMode = value
}

export function isJsonMode(): boolean {
  return jsonMode
}

export function ok(data: unknown, human: string): void {
  if (jsonMode) {
    process.stdout.write(JSON.stringify(data) + '\n')
    return
  }
  process.stdout.write(human + '\n')
}

export function fail(code: 1 | 2 | 3, message: string): never {
  throw new UserError(code, message)
}
