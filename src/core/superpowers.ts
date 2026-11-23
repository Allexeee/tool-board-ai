import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Рекомендация владельцу: без superpowers brainstorming не работает. */
export const SUPERPOWERS_ADVICE =
  'superpowers не подключён: brainstorming заметно повышает точность выполнения задач. ' +
  'Добавьте плагин superpowers в .opencode/opencode.json (plugins) и перезапустите OpenCode.'

function pluginsOf(file: string): unknown[] {
  if (!existsSync(file)) return []
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, '')) as {
      plugins?: unknown
    }
    return Array.isArray(parsed.plugins) ? parsed.plugins : []
  } catch {
    return []
  }
}

function hasSuperpowers(plugins: unknown[]): boolean {
  return plugins.some((item) => {
    if (typeof item === 'string') return /superpowers/i.test(item)
    if (item !== null && typeof item === 'object') {
      return /superpowers/i.test(JSON.stringify(item))
    }
    return false
  })
}

/**
 * Подключён ли superpowers: проектный `.opencode/opencode.json` или глобальный
 * конфиг OpenCode. Битый или отсутствующий конфиг — это «не подключён», без падений.
 */
export function superpowersConfigured(root: string, home: string = homedir()): boolean {
  const files = [
    join(root, '.opencode', 'opencode.json'),
    join(home, '.config', 'opencode', 'opencode.json'),
  ]
  return files.some((file) => hasSuperpowers(pluginsOf(file)))
}
