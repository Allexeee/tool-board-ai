import type { DatabaseSync } from 'node:sqlite'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { listCards } from './cards.ts'
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
  ready: 'готов к работе',
  booked: 'готов к работе',
  in_progress: 'в работе',
  review: 'на ревью у агента',
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
  note: string
}

export interface BacklogDone {
  id: string
  title: string
  doneAt: string
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
    status: STATUS_LABEL[card.status],
    note: noteFor(db, card),
  }
}

function sortCards(cards: Card[]): Card[] {
  return [...cards].sort(
    (left, right) =>
      score(right) - score(left) ||
      (left.position ?? Number.MAX_SAFE_INTEGER) - (right.position ?? Number.MAX_SAFE_INTEGER) ||
      (left.importance ?? 0) - (right.importance ?? 0) ||
      left.id.localeCompare(right.id),
  )
}

/** Данные бэклога: таблицы по навыкам, отложенные и недавно готовые. */
export function buildBacklog(db: DatabaseSync, reference: Date = new Date()): BacklogData {
  const cards = listCards(db).filter((card) => !HIDDEN.includes(card.status))

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
    if (card.doneAt === null) return false
    return new Date(card.doneAt).getTime() >= cut
  })

  return {
    generatedAt: reference.toISOString(),
    skills: skills.map((skill) => ({
      skill,
      label: SKILL_LABEL[skill] ?? skill,
      rows: sortCards(bySkill.get(skill)!).map((card) => row(db, card)),
    })),
    deferred: sortCards(listCards(db, { status: 'deferred' })).map((card) => row(db, card)),
    done: done
      .sort((left, right) => (right.doneAt ?? '').localeCompare(left.doneAt ?? ''))
      .map((card) => ({ id: card.id, title: card.title, doneAt: card.doneAt! })),
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

export function writeBacklog(
  db: DatabaseSync,
  root: string,
  settings: BoardSettings,
): string {
  const path = backlogPath(root, settings)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, renderBacklog(db), 'utf8')
  return path
}

/** HTML-снимок рядом с md: открывается в браузере, обновляется по F5. */
export function writeBacklogHtml(
  db: DatabaseSync,
  root: string,
  settings: BoardSettings,
): string {
  const path = backlogHtmlPath(root, settings)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(
    path,
    renderBacklogPage(buildBacklog(db), settings.backlog.refreshSeconds),
    'utf8',
  )
  return path
}

/** Автосборка после finish/run end: только если включена в настройках. */
export function refreshBacklogIfAuto(db: DatabaseSync, root: string): string | null {
  const settings = readSettings(root)
  if (!settings.backlog.auto) return null
  const md = writeBacklog(db, root, settings)
  writeBacklogHtml(db, root, settings)
  return md
}
