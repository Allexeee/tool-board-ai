import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

export const toolRoot = join(here, '..', '..')

/** Единственный источник номера версии — package.json самого инструмента. */
export function toolVersion(root = toolRoot): string {
  const path = join(root, 'package.json')
  if (!existsSync(path)) return '0.0.0'

  const raw = readFileSync(path, 'utf8').replace(/^\uFEFF/, '')
  const pkg = JSON.parse(raw) as { version?: string }
  return pkg.version ?? '0.0.0'
}
