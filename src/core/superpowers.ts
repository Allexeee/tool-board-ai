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

/** Порядок загрузки OpenCode: глобальный, корневой проект, затем .opencode. */
function configLoadOrder(root: string, home: string): string[] {
  return [
    ...globalConfigFiles(home),
    join(root, 'opencode.json'),
    join(root, 'opencode.jsonc'),
    join(root, '.opencode', 'opencode.json'),
    join(root, '.opencode', 'opencode.jsonc'),
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

/** Имя записи plugins: строка, объект с name или JSON-строка. */
function pluginName(entry: unknown): string | null {
  if (typeof entry === 'string') return entry
  if (entry !== null && typeof entry === 'object') {
    const name = (entry as { name?: unknown }).name
    if (typeof name === 'string') return name
    return JSON.stringify(entry)
  }
  return null
}

/**
 * Подключён ли superpowers: OpenCode объединяет plugins из конфигов от низкого
 * приоритета к высокому; запись `-superpowers` выключает плагин.
 */
export function superpowersConfigured(root: string, home: string = homedir()): boolean {
  let enabled = false
  for (const file of configLoadOrder(root, home)) {
    for (const entry of pluginsOf(file)) {
      const name = pluginName(entry)
      if (!name) continue
      const negative = name.startsWith('-')
      const target = negative ? name.slice(1) : name
      if (/superpowers/i.test(target)) enabled = !negative
    }
  }
  return enabled
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** `*` и `?` в resource — как в правах OpenCode. */
export function globMatches(pattern: string, value: string): boolean {
  if (pattern === value || pattern === '*') return true
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.')
  return new RegExp(`^${escaped}$`).test(value)
}

function permissionRules(root: string, home: string): Array<Record<string, unknown>> {
  const rules: Array<Record<string, unknown>> = []
  for (const file of configLoadOrder(root, home)) {
    const config = readConfig(file)
    if (!config || !Array.isArray(config.permissions)) continue
    for (const rule of config.permissions) {
      if (isRecord(rule) && rule.action === 'skill' && typeof rule.resource === 'string') {
        rules.push(rule)
      }
    }
  }
  return rules
}

/** Куда писать права: приоритетный .json, а для .jsonc — отдельный .opencode/opencode.json. */
function projectConfigTarget(root: string): string {
  const existing = projectConfigFiles(root).find((file) => existsSync(file))
  if (!existing || existing.toLowerCase().endsWith('.jsonc')) {
    return join(root, '.opencode', 'opencode.json')
  }
  return existing
}

/** Все конкурирующие навыки выключены: правила комбинируются, выигрывает последнее. */
export function conflictingSkillsDisabled(root: string, home: string = homedir()): boolean {
  if (!superpowersConfigured(root, home)) return true
  const rules = permissionRules(root, home)
  return CONFLICTING_SKILLS.every((skill) => {
    let effect: unknown
    for (const rule of rules) {
      if (globMatches(String(rule.resource), skill)) effect = rule.effect
    }
    return effect === 'deny'
  })
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
