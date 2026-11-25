import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** Рекомендация владельцу: без superpowers brainstorming не работает. */
export const SUPERPOWERS_ADVICE =
  'superpowers не подключён: brainstorming заметно повышает точность выполнения задач. ' +
  'Добавьте плагин superpowers в opencode.json (plugins) и перезапустите OpenCode.'

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

export const CONFLICTING_SKILLS_ADVICE =
  'superpowers подключён, но конкурирующие навыки не выключены: выполните board init --refresh'

/** Конфиги проекта в порядке приоритета OpenCode: .opencode выше корневого. */
function projectConfigFiles(root: string): string[] {
  return [
    join(root, '.opencode', 'opencode.json'),
    join(root, '.opencode', 'opencode.jsonc'),
    join(root, 'opencode.json'),
    join(root, 'opencode.jsonc'),
  ]
}

function globalConfigFiles(home: string): string[] {
  return [
    join(home, '.config', 'opencode', 'opencode.json'),
    join(home, '.config', 'opencode', 'opencode.jsonc'),
  ]
}

/** JSONC: комментарии и хвостовые запятые — не ошибка конфига. */
export function stripJsonc(text: string): string {
  let out = ''
  let inString = false
  let escaped = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (inString) {
      out += ch
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') {
      inString = true
      out += ch
      continue
    }
    if (ch === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++
      out += '\n'
      continue
    }
    if (ch === '/' && text[i + 1] === '*') {
      i += 2
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++
      i++
      continue
    }
    out += ch
  }
  return out.replace(/,\s*([}\]])/g, '$1')
}

function readConfig(file: string): Record<string, unknown> | null {
  if (!existsSync(file)) return null
  try {
    const parsed = JSON.parse(
      stripJsonc(readFileSync(file, 'utf8').replace(/^\uFEFF/, '')),
    ) as unknown
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

function pluginsOf(file: string): unknown[] {
  const parsed = readConfig(file)
  return parsed && Array.isArray(parsed.plugins) ? parsed.plugins : []
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
 * Подключён ли superpowers: корневой opencode.json/.jsonc, старый
 * `.opencode/opencode.json` или глобальный конфиг. Битый файл — не подключён.
 */
export function superpowersConfigured(root: string, home: string = homedir()): boolean {
  return [...projectConfigFiles(root), ...globalConfigFiles(home)].some((file) =>
    hasSuperpowers(pluginsOf(file)),
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Куда писать права: приоритетный .json, а для .jsonc — отдельный .opencode/opencode.json. */
function projectConfigTarget(root: string): string {
  const existing = projectConfigFiles(root).find((file) => existsSync(file))
  if (!existing || existing.toLowerCase().endsWith('.jsonc')) {
    return join(root, '.opencode', 'opencode.json')
  }
  return existing
}

function hasDenyRules(parsed: Record<string, unknown> | null): boolean {
  const permissions = parsed && Array.isArray(parsed.permissions) ? parsed.permissions : []
  return CONFLICTING_SKILLS.every((skill) =>
    permissions.some(
      (rule) =>
        isRecord(rule) &&
        rule.action === 'skill' &&
        rule.resource === skill &&
        rule.effect === 'deny',
    ),
  )
}

export interface PermissionsWrite {
  changed: boolean
  created?: boolean
  path?: string
  warning?: string
}

/**
 * Дописывает запреты на конкурирующие навыки в проектный конфиг OpenCode.
 * Чужие ключи и правила сохраняются; повторный вызов дублей не делает.
 * Без superpowers файл не трогаем.
 */
export function writeSkillPermissions(
  root: string,
  home: string = homedir(),
): PermissionsWrite {
  if (!superpowersConfigured(root, home)) return { changed: false }

  const path = projectConfigTarget(root)
  const existed = existsSync(path)
  let config: Record<string, unknown> = {}
  if (existed) {
    const parsed = readConfig(path)
    if (!parsed) {
      return {
        changed: false,
        warning: `${path} не разобран: правила навыков не добавлены`,
      }
    }
    config = parsed
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
  return { changed: true, created: !existed, path }
}

/** Все конкурирующие навыки выключены (или superpowers не подключён). */
export function conflictingSkillsDisabled(root: string, home: string = homedir()): boolean {
  if (!superpowersConfigured(root, home)) return true
  const target = projectConfigFiles(root).find((file) => existsSync(file))
  return target ? hasDenyRules(readConfig(target)) : false
}
