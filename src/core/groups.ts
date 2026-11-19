import { UserError } from '../cli/errors.ts'

const PREFIX = /^[A-Z0-9]{1,8}$/

/** Префикс группы — 1–8 символов A-Z0-9; регистр не важен. */
export function normalizeGroupPrefix(raw: string): string {
  const prefix = raw.trim().toUpperCase()
  if (!PREFIX.test(prefix)) {
    throw new UserError(3, `недопустимый префикс группы «${raw}»: нужно 1–8 символов A-Z0-9`)
  }
  return prefix
}
