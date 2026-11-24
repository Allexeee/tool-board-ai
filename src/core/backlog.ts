import type { DatabaseSync } from 'node:sqlite'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { listCards } from './cards.ts'
import { listDeps } from './deps.ts'
import { readSettings, type BoardSettings } from './settings.ts'
import type { Card, CardStatus } from './types.ts'

/** Человеческие статусы: реальный статус карточки → строка в бэклоге. */
const STATUS_LABEL: Record<CardStatus, string> = {
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

function table(rows: Card[], db: DatabaseSync): string[] {
  const lines = ['| ID | Заголовок | Статус | Заметка |', '|---|---|---|---|']
  for (const card of rows) {
    lines.push(
      `| ${card.id} | ${cell(card.title)} | ${STATUS_LABEL[card.status]} | ${noteFor(db, card)} |`,
    )
  }
  return lines
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

/** md-бэклог: таблицы по навыкам, отложенные и недавно готовые. */
export function renderBacklog(db: DatabaseSync, reference: Date = new Date()): string {
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

  const lines = [
    '# Бэклог',
    '',
    '> Файл собран из `.board/board.db`. Не редактируйте вручную: изменения перезапишутся.',
    '> Пересобрать: `board backlog`. «Ждёт утверждения владельцем» — нужен ваш ответ по spec.',
    '',
  ]

  if (skills.length === 0) lines.push('Открытых карточек нет.', '')

  for (const skill of skills) {
    const label = SKILL_LABEL[skill] ?? skill
    lines.push(`## Задачи для ${label}`, '')
    lines.push(...table(sortCards(bySkill.get(skill)!), db))
    lines.push('')
  }

  const deferred = sortCards(listCards(db, { status: 'deferred' }))
  if (deferred.length > 0) {
    lines.push('## Отложенные', '', '| ID | Заголовок | Причина |', '|---|---|---|')
    for (const card of deferred) {
      lines.push(`| ${card.id} | ${cell(card.title)} | ${cell(card.note ?? '')} |`)
    }
    lines.push('')
  }

  const cut = reference.getTime() - DONE_WINDOW_HOURS * 60 * 60 * 1000
  const done = listCards(db, { status: 'done' }).filter((card) => {
    if (card.doneAt === null) return false
    return new Date(card.doneAt).getTime() >= cut
  })
  if (done.length > 0) {
    lines.push(
      `## Готово за последние ${DONE_WINDOW_HOURS} часов`,
      '',
      '| ID | Заголовок | Завершено |',
      '|---|---|---|',
    )
    for (const card of done.sort((left, right) => (right.doneAt ?? '').localeCompare(left.doneAt ?? ''))) {
      lines.push(`| ${card.id} | ${cell(card.title)} | ${shortTime(card.doneAt!)} |`)
    }
    lines.push('')
  }

  return `${lines.join('\n').trimEnd()}\n`
}

/** Путь файла бэклога относительно корня проекта. */
export function backlogPath(root: string, settings: BoardSettings): string {
  return join(root, settings.backlog.path)
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

/** Автосборка после finish/run end: только если включена в настройках. */
export function refreshBacklogIfAuto(db: DatabaseSync, root: string): string | null {
  const settings = readSettings(root)
  if (!settings.backlog.auto) return null
  return writeBacklog(db, root, settings)
}

