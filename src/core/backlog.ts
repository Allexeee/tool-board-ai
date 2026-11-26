import type { DatabaseSync } from 'node:sqlite'
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { isIdeaCard, listCards } from './cards.ts'
import { listDeps } from './deps.ts'
import { readSettings, type BoardSettings } from './settings.ts'
import { renderBacklogPage } from './backlog-view.ts'
import type { Card, CardStatus } from './types.ts'

/** Человеческие статусы */
export const STATUS_LABEL: Record<CardStatus, string> = {
  new: 'новый запрос',
  shaping: 'разбор',
  approval: 'ждёт утверждения владельцем',
  waiting: 'ждёт другие карточки',
  ready: 'в очереди',
  booked: 'забронирована',
  in_progress: 'в работе',
  review: 'ждет финального ревью',
  acceptance: 'требует приёмки владельцем',
  blocked: 'заблокирована',
  deferred: 'отложена',
  done: 'готово',
  cancelled: 'отменена',
}

const HIDDEN: CardStatus[] = ['cancelled', 'deferred', 'done']

/** Сколько часов назад считаем «недавно готово» (примерно сессия). */
const DONE_WINDOW_HOURS = 12

const SKILL_LABEL: Record<string, string> = {
  owner: 'владельца',
}

export interface BacklogRow {
  id: string
  title: string
  status: string
  statusKey: CardStatus
  note: string
}

export interface BacklogDone {
  id: string
  title: string
  doneAt: string
}

export interface BacklogIdea {
  id: string
  text: string
  updatedAt: string
}

export interface BacklogSkill {
  skill: string
  label: string
  rows: BacklogRow[]
}

export interface BacklogData {
  generatedAt: string
  skills: BacklogSkill[]
  deferred: BacklogRow[]
  done: BacklogDone[]
  ideas: BacklogIdea[]
}

function cell(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ').trim()
}

function shortTime(iso: string): string {
  const date = new Date(iso)
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${pad(date.getDate())}.${pad(date.getMonth() + 1)} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function score(card: Card): number {
  return (card.importance ?? 0) * 4 + (card.urgency ?? 0)
}

function noteFor(db: DatabaseSync, card: Card): string {
  if (card.status === 'waiting') {
    const deps = listDeps(db, card.id)
    return deps.length > 0 ? `ждёт: ${deps.join(', ')}` : ''
  }
  if (card.status === 'blocked' || card.status === 'deferred') {
    return cell(card.note ?? '')
  }
  return ''
}

function row(db: DatabaseSync, card: Card): BacklogRow {
  return {
    id: card.id,
    title: card.title,
    status: STATUS_LABEL[card.status] ?? String(card.status),
    statusKey: card.status,
    note: noteFor(db, card),
  }
}

/** waiting и blocked в конце секции: очередь не разрывается, зависимые не лезут вперёд. */
function statusRank(card: Card): number {
  return card.status === 'waiting' || card.status === 'blocked' ? 1 : 0
}

function sortCards(cards: Card[]): Card[] {
  return [...cards].sort(
    (left, right) =>
      statusRank(left) - statusRank(right) ||
      score(right) - score(left) ||
      (left.position ?? Number.MAX_SAFE_INTEGER) - (right.position ?? Number.MAX_SAFE_INTEGER) ||
      (left.importance ?? 0) - (right.importance ?? 0) ||
      left.id.localeCompare(right.id),
  )
}

/** Данные бэклога: таблицы по навыкам, отложенные и недавно готовые. */
export function buildBacklog(db: DatabaseSync, reference: Date = new Date()): BacklogData {
  const cards = listCards(db).filter(
    (card) => !HIDDEN.includes(card.status) && !isIdeaCard(card) && card.status !== 'acceptance',
  )
  const acceptance = sortCards(listCards(db, { status: 'acceptance' })).map((card) => row(db, card))

  const bySkill = new Map<string, Card[]>()
  for (const card of cards) {
    const skill = card.skill ?? 'без навыка'
    const list = bySkill.get(skill) ?? []
    list.push(card)
    bySkill.set(skill, list)
  }

  const skills = [...bySkill.keys()].sort((left, right) =>
    left === 'owner' ? -1 : right === 'owner' ? 1 : left.localeCompare(right),
  )

  const cut = reference.getTime() - DONE_WINDOW_HOURS * 60 * 60 * 1000
  const done = listCards(db, { status: 'done' }).filter((card) => {
    if (isIdeaCard(card)) return false
    if (card.doneAt === null) return false
    return new Date(card.doneAt).getTime() >= cut
  })

  const ideas = listCards(db, { status: 'deferred', tag: 'idea' })
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .map((card) => ({
      id: card.id,
      text: card.body.trim() || card.title,
      updatedAt: card.updatedAt,
    }))

  const sections = skills.map((skill) => ({
    skill,
    label: SKILL_LABEL[skill] ?? skill,
    rows: sortCards(bySkill.get(skill)!).map((card) => row(db, card)),
  }))
  if (acceptance.length > 0) {
    const owner = sections.find((section) => section.skill === 'owner')
    if (owner) owner.rows = [...acceptance, ...owner.rows]
    else sections.unshift({ skill: 'owner', label: 'владельца', rows: acceptance })
  }

  return {
    generatedAt: reference.toISOString(),
    skills: sections,
    deferred: sortCards(
      listCards(db, { status: 'deferred' }).filter((card) => !isIdeaCard(card)),
    ).map((card) => row(db, card)),
    done: done
      .sort((left, right) => (right.doneAt ?? '').localeCompare(left.doneAt ?? ''))
      .map((card) => ({ id: card.id, title: card.title, doneAt: card.doneAt! })),
    ideas,
  }
}

/** md-бэклог: таблицы по навыкам, отложенные и недавно готовые. */
export function renderBacklog(db: DatabaseSync, reference: Date = new Date()): string {
  const data = buildBacklog(db, reference)
  const lines = [
    '# Бэклог',
    '',
    '> Файл собран из `.board/board.db`. Не редактируйте вручную: изменения перезапишутся.',
    '> Пересобрать: `board backlog`. «Ждёт утверждения владельцем» — нужен ваш ответ по spec.',
    '',
  ]

  if (data.skills.length === 0) lines.push('Открытых карточек нет.', '')

  for (const section of data.skills) {
    lines.push(`## Задачи для ${section.label}`, '')
    lines.push('| ID | Заголовок | Статус | Заметка |', '|---|---|---|---|')
    for (const item of section.rows) {
      lines.push(`| ${item.id} | ${cell(item.title)} | ${item.status} | ${item.note} |`)
    }
    lines.push('')
  }

  if (data.deferred.length > 0) {
    lines.push('## Отложенные', '', '| ID | Заголовок | Причина |', '|---|---|---|')
    for (const item of data.deferred) {
      lines.push(`| ${item.id} | ${cell(item.title)} | ${cell(item.note)} |`)
    }
    lines.push('')
  }

  if (data.done.length > 0) {
    lines.push(
      `## Готово за последние ${DONE_WINDOW_HOURS} часов`,
      '',
      '| ID | Заголовок | Завершено |',
      '|---|---|---|',
    )
    for (const item of data.done) {
      lines.push(`| ${item.id} | ${cell(item.title)} | ${shortTime(item.doneAt)} |`)
    }
    lines.push('')
  }

  if (data.ideas.length > 0) {
    lines.push('## Идеи', '', '| ID | Идея | Изменено |', '|---|---|---|')
    for (const item of data.ideas) {
      lines.push(`| ${item.id} | ${cell(item.text)} | ${shortTime(item.updatedAt)} |`)
    }
    lines.push('')
  }

  return `${lines.join('\n').trimEnd()}\n`
}

/** Путь файла бэклога относительно корня проекта. */
export function backlogPath(root: string, settings: BoardSettings): string {
  return join(root, settings.backlog.path)
}

/** HTML-бэклог лежит рядом с md: BACKLOG.md → BACKLOG.html. */
export function backlogHtmlPath(root: string, settings: BoardSettings): string {
  return backlogPath(root, settings).replace(/\.md$/i, '.html')
}

/** Атомарная запись: читатель видит либо старый файл, либо новый, но не половину. */
function writeAtomic(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true })
  const temp = `${path}.${process.pid}.tmp`
  try {
    writeFileSync(temp, content, 'utf8')
    renameSync(temp, path)
  } catch {
    try {
      rmSync(temp, { force: true })
    } catch {
      // временный файл не создался — чистить нечего
    }
    writeFileSync(path, content, 'utf8')
  }
}

export function writeBacklog(
  db: DatabaseSync,
  root: string,
  settings: BoardSettings,
): string {
  const path = backlogPath(root, settings)
  writeAtomic(path, renderBacklog(db))
  return path
}

/** HTML-снимок рядом с md: открывается в браузере, обновляется по F5. */
export function writeBacklogHtml(
  db: DatabaseSync,
  root: string,
  settings: BoardSettings,
): string {
  const path = backlogHtmlPath(root, settings)
  writeAtomic(path, renderBacklogPage(buildBacklog(db), settings.backlog.refreshSeconds))
  return path
}

/** Отметка «бэклог собран на такой-то ревизии»: лежит рядом с базой. */
export interface BacklogState {
  revision: number
  path: string
  refreshSeconds: number
}

export function backlogStatePath(root: string): string {
  return join(root, '.board', 'backlog.state')
}

/** Ревизия доски — последнее событие. Любое изменение карточки или забега её двигает. */
export function backlogRevision(db: DatabaseSync): number {
  const row = db
    .prepare('select coalesce(max(id), 0) as revision from events')
    .get() as { revision: number }
  return row.revision
}

function readBacklogState(root: string): BacklogState | null {
  try {
    const parsed = JSON.parse(readFileSync(backlogStatePath(root), 'utf8')) as Partial<BacklogState>
    if (
      typeof parsed.revision !== 'number' ||
      typeof parsed.path !== 'string' ||
      typeof parsed.refreshSeconds !== 'number'
    ) {
      return null
    }
    return {
      revision: parsed.revision,
      path: parsed.path,
      refreshSeconds: parsed.refreshSeconds,
    }
  } catch {
    return null
  }
}

export interface BacklogFlush {
  path: string | null
  error?: string
}

/**
 * Пересборка «по флагу»: отметка хранит ревизию и настройки, поэтому команда
 * без изменений файлы не трогает. Ошибка пересборки не роняет команду —
 * отметка остаётся, следующая команда повторит.
 */
export function flushBacklog(
  db: DatabaseSync,
  root: string,
  options: { force?: boolean } = {},
): BacklogFlush {
  const settings = readSettings(root)
  if (!settings.backlog.auto) return { path: null }

  const state = readBacklogState(root)
  const stale =
    options.force === true ||
    state === null ||
    state.revision !== backlogRevision(db) ||
    state.path !== settings.backlog.path ||
    state.refreshSeconds !== settings.backlog.refreshSeconds
  if (!stale) return { path: null }

  const revision = backlogRevision(db)
  try {
    const path = writeBacklog(db, root, settings)
    writeBacklogHtml(db, root, settings)
    writeAtomic(
      backlogStatePath(root),
      JSON.stringify(
        {
          revision,
          path: settings.backlog.path,
          refreshSeconds: settings.backlog.refreshSeconds,
        },
        null,
        2,
      ) + '\n',
    )
    return { path }
  } catch (error) {
    return { path: null, error: (error as Error).message }
  }
}

/** Автосборка после finish/run end и любой другой команды, меняющей доску. */
export function refreshBacklogIfAuto(db: DatabaseSync, root: string): string | null {
  return flushBacklog(db, root).path
}
