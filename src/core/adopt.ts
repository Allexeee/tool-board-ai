import type { DatabaseSync } from 'node:sqlite'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { basename, join, relative, resolve } from 'node:path'
import { listCards } from './cards.ts'
import { listExecutors } from './executors.ts'
import { listGroups, type CardGroup } from './groups.ts'
import { listTags, tagExists } from './tags.ts'
import {
  modelContext,
  resolveReviewProfile,
  type ModelContext,
} from './review-policy.ts'
import { readSettings, type AcceptanceConditions, type AcceptanceRule, type BoardSettings } from './settings.ts'

/**
 * `adopt` — план приведения проекта в порядок, без записи. Всё, что предлагает
 * доска, выполняется обычными командами после согласия владельца.
 */
export interface AdoptStep {
  area: 'groups' | 'tags' | 'profile' | 'acceptance' | 'sources' | 'executors' | 'backlog'
  required: boolean
  title: string
  command: string
}

export interface AdoptSource {
  path: string
  title: string
  group: string
  skill: string
  command: string
}

export interface AdoptGroupSuggestion {
  prefix: string
  name: string
  command: string
}

export interface AdoptAcceptanceSuggestion {
  name: string
  include: AcceptanceConditions
  command: string
}

export interface AdoptProfilePlan {
  configured: string
  resolved: string
  effective: string
  spec: string
  run: string
  findings: string
  package: boolean
  reopens: number
  command: string | null
  note: string
}

export interface AdoptPlan {
  groups: { existing: CardGroup[]; missing: AdoptGroupSuggestion[] }
  tags: {
    existing: string[]
    missingService: string[]
    suggested: Array<{ name: string; description: string; command: string }>
  }
  profile: AdoptProfilePlan
  acceptance: { existing: string[]; suggested: AdoptAcceptanceSuggestion[] }
  executors: {
    existing: Array<{ id: string; kind: string; skills: string[] }>
    missing: Array<{ id: string; kind: string; skills: string[]; command: string }>
  }
  sources: AdoptSource[]
  backlog: {
    path: string
    exists: boolean
    auto: boolean
    refreshSeconds: number
    commands: string[]
  }
  steps: AdoptStep[]
  required: number
  remaining: number
}

/** Служебные теги создаёт сама доска; предлагаем только пользовательский словарь. */
const SERVICE_TAG_NAMES = ['new', 'improve', 'review', 'idea']

const SUGGESTED_TAGS = [
  { name: 'ui', description: 'интерфейс и внешний вид' },
  { name: 'backend', description: 'логика, данные и интеграции' },
  { name: 'docs', description: 'документация и тексты' },
  { name: 'test', description: 'тесты и покрытие' },
]

const TYPE_PREFIX = /^(feat|fix|perf|sec|docs|test|chore|review):\s*/i
const SKIP_DIRS = new Set(['.git', '.board', '.worktrees', 'node_modules', 'tools'])

function quote(value: string): string {
  return `"${value.replace(/"/g, "'")}"`
}

function summarizeConditions(conditions: AcceptanceConditions): string {
  return [
    conditions.groups?.length ? `группы ${conditions.groups.join(',')}` : '',
    conditions.tags?.length ? `теги ${conditions.tags.join(',')}` : '',
    conditions.skills?.length ? `навыки ${conditions.skills.join(',')}` : '',
    conditions.paths?.length ? `пути ${conditions.paths.join(',')}` : '',
  ]
    .filter(Boolean)
    .join('; ')
}

function ruleText(rule: AcceptanceRule): string {
  const include = summarizeConditions(rule.include)
  const exclude = rule.exclude ? `; кроме ${summarizeConditions(rule.exclude)}` : ''
  return `${rule.name} [${include}${exclude}]`
}

function acceptanceCommand(name: string, include: AcceptanceConditions): string {
  const flags: string[] = []
  for (const group of include.groups ?? []) flags.push('--include-group', group)
  for (const tag of include.tags ?? []) flags.push('--include-tag', tag)
  for (const skill of include.skills ?? []) flags.push('--include-skill', skill)
  for (const path of include.paths ?? []) flags.push('--include-path', path)
  return `board acceptance rule add ${quote(name)} ${flags.join(' ')}`.trim()
}

function normalizeTitle(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(TYPE_PREFIX, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
}

function looksLikeSameTask(source: string, card: string): boolean {
  const left = normalizeTitle(source)
  const right = normalizeTitle(card)
  if (left === '' || right === '') return false
  if (left === right) return true
  const shorter = left.length < right.length ? left : right
  const longer = shorter === left ? right : left
  return shorter.length >= 12 && longer.startsWith(shorter)
}

function markdownTitle(path: string): string | null {
  const lines = readFileSync(path, 'utf8').split(/\r?\n/)
  for (const line of lines) {
    const heading = /^#\s+(.+?)\s*$/.exec(line)
    if (heading) return heading[1].replace(/[*_`]/g, '').trim()
  }
  for (const line of lines) {
    const text = line.trim()
    if (text === '' || text === '---' || text.startsWith('<!--')) continue
    return text.replace(/^[-*]\s+/, '').replace(/[*_`]/g, '').trim()
  }
  return null
}

function walkMarkdown(dir: string, root: string, depth = 0): string[] {
  if (depth > 4 || !existsSync(dir)) return []
  const found: string[] = []
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue
    const path = join(dir, name)
    const stat = statSync(path)
    if (stat.isDirectory()) {
      found.push(...walkMarkdown(path, root, depth + 1))
    } else if (/\.md$/i.test(name)) {
      found.push(relative(root, path).replaceAll('\\', '/'))
    }
  }
  return found
}

/** Источники задач: docs/inbox и файлы-чеклисты; шаблоны и бэклог не трогаем. */
export function findAdoptSources(root: string): string[] {
  const paths = new Set<string>(walkMarkdown(join(root, 'docs', 'inbox'), root))
  for (const path of walkMarkdown(join(root, 'docs'), root)) {
    if (/(^|\/)(checklist|check-list)[^/]*\.md$/i.test(path)) paths.add(path)
  }
  for (const name of ['CHECKLIST.md', 'checklist.md']) {
    if (existsSync(join(root, name))) paths.add(name)
  }
  return [...paths].sort()
}

function suggestedGroup(groups: CardGroup[]): string {
  return groups[0]?.prefix ?? 'CARD'
}

function suggestedSkill(executors: Array<{ id: string; kind: string; skills: string[] }>): string {
  const developer = executors.find((executor) => executor.id === 'developer')
  if (developer) return 'developer'
  const agent = executors.find((executor) => executor.kind === 'agent')
  return agent?.skills[0] ?? 'developer'
}

function sourceSteps(
  root: string,
  groups: CardGroup[],
  executors: Array<{ id: string; kind: string; skills: string[] }>,
  existingTitles: string[],
): AdoptSource[] {
  const group = suggestedGroup(groups)
  const skill = suggestedSkill(executors)
  const sources: AdoptSource[] = []
  for (const path of findAdoptSources(root)) {
    let title: string | null = null
    try {
      title = markdownTitle(join(root, path))
    } catch {
      title = null
    }
    const clean = title?.trim() || basename(path, '.md').replace(/[-_]+/g, ' ')
    if (existingTitles.some((card) => looksLikeSameTask(clean, card))) continue

    const cardTitle = TYPE_PREFIX.test(clean) ? clean : `feat: ${clean}`
    sources.push({
      path,
      title: cardTitle,
      group,
      skill,
      command: `board card add --group ${group} --title ${quote(cardTitle)} --skill ${skill}`,
    })
  }
  return sources
}

function acceptanceSuggestions(
  settings: BoardSettings,
  groups: CardGroup[],
): AdoptAcceptanceSuggestion[] {
  if (settings.acceptance.rules.length > 0) return []
  const suggestions: AdoptAcceptanceSuggestion[] = []
  // Одна область — понятное правило по группе; много областей — не угадываем.
  if (groups.length === 1) {
    const group = groups[0]
    const name = `приёмка-${group.prefix.toLowerCase()}`
    const include = { groups: [group.prefix] }
    suggestions.push({ name, include, command: acceptanceCommand(name, include) })
  }
  const docsInclude = { paths: ['docs/**', 'README.md'] }
  suggestions.push({
    name: 'документация',
    include: docsInclude,
    command: acceptanceCommand('документация', docsInclude),
  })
  return suggestions
}

/**
 * Строит план и ничего не пишет. Повторный вызов на неизменённой доске даёт
 * тот же план; после применения шагов они исчезают, дублей нет.
 */
export function buildAdoptPlan(
  db: DatabaseSync,
  root: string,
  context: ModelContext = modelContext(),
): AdoptPlan {
  const settings = readSettings(root)
  const groups = listGroups(db)
  const tags = listTags(db)
  const executors = listExecutors(db).map((executor) => ({
    id: executor.id,
    kind: executor.kind,
    skills: executor.skills,
  }))
  const cards = listCards(db)
  const titles = cards.map((card) => card.title)

  const missingGroups: AdoptGroupSuggestion[] =
    groups.length > 0
      ? []
      : [
          {
            prefix: 'CARD',
            name: 'Общие задачи',
            command: 'board group add CARD --name "Общие задачи" --as developer',
          },
        ]

  const existingTagNames = tags.map((tag) => tag.name)
  const missingService = SERVICE_TAG_NAMES.filter((name) => !tagExists(db, name))
  const suggestedTags = SUGGESTED_TAGS.filter((tag) => !tagExists(db, tag.name)).map(
    (tag) => ({
      ...tag,
      command: `board tag add ${tag.name} --description ${quote(tag.description)}`,
    }),
  )

  const resolved = resolveReviewProfile(settings, context)
  const profile: AdoptProfilePlan = {
    configured: settings.review.profile,
    resolved: resolved.name,
    effective:
      settings.review.profile === 'auto' ? `auto → ${resolved.name}` : resolved.name,
    spec: resolved.profile.spec,
    run: resolved.profile.run,
    findings: resolved.profile.findings,
    package: resolved.profile.package,
    reopens: resolved.profile.reopens,
    command: settings.review.profile === 'auto' ? null : 'board setup --profile auto',
    note:
      settings.review.profile === 'auto'
        ? 'auto пересчитывается при смене модели'
        : 'сейчас профиль фиксирован; auto подстроится под модель',
  }

  const acceptance = {
    existing: settings.acceptance.rules.map(ruleText),
    suggested: acceptanceSuggestions(settings, groups),
  }

  const missingExecutors = executors.some((executor) => executor.id === 'developer')
    ? []
    : [
        {
          id: 'developer',
          kind: 'agent',
          skills: ['dev'],
          command: 'board executor add developer --kind agent --skills dev',
        },
      ]

  const sources = sourceSteps(root, groups, executors, titles)
  const backlogPath = resolve(root, settings.backlog.path)
  const backlogExists = existsSync(backlogPath)
  const backlogCommands: string[] = []
  if (!settings.backlog.auto) backlogCommands.push('board setup --backlog-auto')
  if (!backlogExists) backlogCommands.push('board backlog')

  const backlog = {
    path: settings.backlog.path,
    exists: backlogExists,
    auto: settings.backlog.auto,
    refreshSeconds: settings.backlog.refreshSeconds,
    commands: backlogCommands,
  }

  const steps: AdoptStep[] = []
  for (const item of missingGroups) {
    steps.push({
      area: 'groups',
      required: true,
      title: `Добавить область ${item.prefix}`,
      command: item.command,
    })
  }
  for (const item of missingExecutors) {
    steps.push({
      area: 'executors',
      required: true,
      title: `Добавить исполнителя ${item.id}`,
      command: item.command,
    })
  }
  if (profile.command) {
    steps.push({
      area: 'profile',
      required: false,
      title: 'Вернуть профиль ревью в auto',
      command: profile.command,
    })
  }
  for (const item of acceptance.suggested) {
    steps.push({
      area: 'acceptance',
      required: false,
      title: `Правило приёмки ${item.name}`,
      command: item.command,
    })
  }
  for (const name of missingService) {
    steps.push({
      area: 'tags',
      required: true,
      title: `Вернуть служебный тег ${name}`,
      command: `board tag add ${name} --description "служебный"`,
    })
  }
  for (const item of suggestedTags) {
    steps.push({
      area: 'tags',
      required: false,
      title: `Добавить тег ${item.name}`,
      command: item.command,
    })
  }
  for (const command of backlog.commands) {
    steps.push({
      area: 'backlog',
      required: false,
      title: 'Настроить бэклог',
      command,
    })
  }
  for (const source of sources) {
    steps.push({
      area: 'sources',
      required: false,
      title: `Задача из ${source.path}`,
      command: source.command,
    })
  }

  return {
    groups: { existing: groups, missing: missingGroups },
    tags: { existing: existingTagNames, missingService, suggested: suggestedTags },
    profile,
    acceptance,
    executors: { existing: executors, missing: missingExecutors },
    sources,
    backlog,
    steps,
    required: steps.filter((step) => step.required).length,
    remaining: steps.length,
  }
}

/** Человеческий план для терминала: без JSON-жаргона, но с готовыми командами. */
export function renderAdoptPlan(plan: AdoptPlan): string {
  const lines: string[] = ['План обновления доски (adopt):']

  lines.push(
    `  области: ${
      plan.groups.existing.length > 0
        ? plan.groups.existing.map((group) => group.prefix).join(', ')
        : `нет → ${plan.groups.missing.map((group) => group.prefix).join(', ')}`
    }`,
  )
  lines.push(
    `  теги: ${plan.tags.existing.join(', ') || 'нет'}` +
      (plan.tags.suggested.length > 0
        ? `; предложить: ${plan.tags.suggested.map((tag) => tag.name).join(', ')}`
        : ''),
  )
  lines.push(
    `  профиль: ${plan.profile.effective}` +
      ` (spec ${plan.profile.spec}, забег ${plan.profile.run}, находки ${plan.profile.findings}, пакет ${
        plan.profile.package ? 'да' : 'нет'
      }); ${plan.profile.note}`,
  )
  lines.push(
    `  приёмка: ${
      plan.acceptance.existing.length > 0
        ? plan.acceptance.existing.join('; ')
        : `правил нет; предложить: ${plan.acceptance.suggested.map((rule) => rule.name).join(', ')}`
    }`,
  )
  lines.push(
    `  исполнители: ${
      plan.executors.existing.length > 0
        ? plan.executors.existing.map((executor) => executor.id).join(', ')
        : `нет → ${plan.executors.missing.map((executor) => executor.id).join(', ')}`
    }`,
  )
  lines.push(
    `  бэклог: ${plan.backlog.path} · ${plan.backlog.exists ? 'есть' : 'нет'} · ${
      plan.backlog.auto ? `авто ${plan.backlog.refreshSeconds} с` : 'авто выключено'
    }`,
  )
  lines.push(`  источники задач: ${plan.sources.length}`)

  if (plan.steps.length === 0) {
    lines.push('', 'Всё настроено: доска ничего не предлагает.')
    return lines.join('\n')
  }

  lines.push(
    '',
    `Осталось шагов: ${plan.remaining} (обязательных: ${plan.required}). Доска ничего не создала.`,
  )
  for (const [index, step] of plan.steps.entries()) {
    lines.push(
      `  ${index + 1}. ${step.required ? '' : '[по желанию] '}${step.title}`,
      `     ${step.command}`,
    )
  }
  return lines.join('\n')
}
