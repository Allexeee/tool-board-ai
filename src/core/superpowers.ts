import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** Рекомендация владельцу: без superpowers brainstorming не работает. */
export const SUPERPOWERS_ADVICE =
  'superpowers не подключён: brainstorming заметно повышает точность выполнения задач. ' +
  'Добавьте плагин superpowers в .opencode/opencode.json (plugins) и перезапустите OpenCode.'

/**
 * Навыки superpowers, которые спорят с доской: свой план, свои субагенты,
 * своё завершение ветки. В проекте с доской они выключены правами OpenCode.
 */
export const CONFLICTING_SKILLS = [
  'writing-plans',
  'executing-plans',
  'subagent-driven-development',
  'finishing-a-development-branch',
  'using-git-worktrees',
] as const

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

function projectConfigPath(root: string): string {
  return join(root, '.opencode', 'opencode.json')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export interface PermissionsWrite {
  changed: boolean
  created?: boolean
  warning?: string
}

/**
 * Дописывает в проектный opencode.json запреты на конкурирующие навыки.
 * Чужие ключи и правила сохраняются; повторный вызов дублей не делает.
 * Без superpowers файл не трогаем.
 */
export function writeSkillPermissions(
  root: string,
  home: string = homedir(),
): PermissionsWrite {
  if (!superpowersConfigured(root, home)) return { changed: false }

  const path = projectConfigPath(root)
  const existed = existsSync(path)
  let config: Record<string, unknown> = {}
  if (existsSync(path)) {
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, '')) as unknown
      if (!isRecord(parsed)) {
        return { changed: false, warning: '.opencode/opencode.json не объект: правила навыков не добавлены' }
      }
      config = parsed
    } catch {
      return {
        changed: false,
        warning: '.opencode/opencode.json не разобран: правила навыков не добавлены',
      }
    }
  }

  const permissions = Array.isArray(config.permissions) ? [...config.permissions] : []
  let changed = false
  for (const skill of CONFLICTING_SKILLS) {
    const disabled = permissions.some(
      (rule) =>
        isRecord(rule) && rule.action === 'skill' && rule.resource === skill && rule.effect === 'deny',
    )
    if (!disabled) {
      permissions.push({ action: 'skill', resource: skill, effect: 'deny' })
      changed = true
    }
  }
  if (!changed) return { changed: false }

  config.permissions = permissions
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(config, null, 2) + '\n', 'utf8')
  return { changed: true, created: !existed }
}

/** Все конкурирующие навыки выключены (или superpowers не подключён). */
export function conflictingSkillsDisabled(root: string, home: string = homedir()): boolean {
  if (!superpowersConfigured(root, home)) return true
  try {
    const parsed = JSON.parse(
      readFileSync(projectConfigPath(root), 'utf8').replace(/^\uFEFF/, ''),
    ) as { permissions?: unknown }
    const permissions = Array.isArray(parsed.permissions) ? parsed.permissions : []
    return CONFLICTING_SKILLS.every((skill) =>
      permissions.some(
        (rule) =>
          isRecord(rule) &&
          rule.action === 'skill' &&
          rule.resource === skill &&
          rule.effect === 'deny',
      ),
    )
  } catch {
    return false
  }
}

export const CONFLICTING_SKILLS_ADVICE =
  'superpowers подключён, но конкурирующие навыки не выключены: выполните board init --refresh'
