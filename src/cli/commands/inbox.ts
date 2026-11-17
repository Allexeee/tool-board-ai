import { findProject } from '../../core/project.ts'
import { openDb } from '../../core/db.ts'
import { advanceTime } from '../../core/clock.ts'
import { inbox, type OwnerItem } from '../../core/questions.ts'
import { nowView } from '../../core/views.ts'
import type { Stage } from '../../core/stages.ts'
import { ok } from '../output.ts'
import { UserError } from '../errors.ts'

export default async function command() {
  const project = findProject(process.cwd())
  if (!project) throw new UserError(3, 'проект не найден: выполните toolbox-al init')
  const db = openDb(project.dbPath)
  advanceTime(db)

  const items = inbox(db)
  const now = Date.now()

  const blocks: Array<[string, OwnerItem[]]> = [
    ['ПРОСРОЧЕНО', items.filter((item) => item.deadline && Date.parse(item.deadline) < now)],
    [
      'СЕГОДНЯ',
      items.filter((item) => item.deadline && Date.parse(item.deadline) >= now && isToday(item.deadline)),
    ],
    [
      'ОСТАЛЬНОЕ',
      items.filter((item) => !item.deadline || (Date.parse(item.deadline) >= now && !isToday(item.deadline))),
    ],
  ]

  const text = blocks
    .filter(([, list]) => list.length > 0)
    .map(([title, list]) => title + '\n' + list.map(render).join('\n'))
    .join('\n\n')

  const view = nowView(db)
  const extra: string[] = []
  if (view.requests.length > 0) {
    extra.push('ЗАПРОСЫ В INBOX\n' + view.requests.map((r) => `  ${r.id.padEnd(5)} ${r.title}`).join('\n'))
  }
  if (view.plans.length > 0) {
    extra.push(
      'ПЛАНЫ НА УТВЕРЖДЕНИЕ\n' +
        view.plans.map((p) => `  ${p.id.padEnd(5)} ${p.requestId.padEnd(5)} ${p.title}`).join('\n'),
    )
  }
  if (view.unreleased > 0) {
    extra.push(`НЕ ВЫПУЩЕНО\n  этапов в dev: ${view.unreleased} → release pending`)
  }

  ok(items, [text, ...extra].filter(Boolean).join('\n\n') || 'ничего не ждёт вас')
  return 0
}

function isToday(iso: string): boolean {
  const date = new Date(iso)
  const today = new Date()
  return (
    date.getFullYear() === today.getFullYear() &&
    date.getMonth() === today.getMonth() &&
    date.getDate() === today.getDate()
  )
}

function render(item: OwnerItem): string {
  if (item.kind === 'stage') {
    const stage = item.item as Stage
    const note = stage.status === 'accepted' ? 'ждёт слияния' : 'ждёт приёмки'
    return `  ${item.id.padEnd(12)} ${'этап'.padEnd(7)} ${stage.name} — ${note}`
  }

  const title = item.kind === 'task' ? (item.item as { title: string }).title : (item.item as { text: string }).text
  const kind = item.kind === 'task' ? 'задача' : 'вопрос'
  return `  ${item.id.padEnd(12)} ${kind.padEnd(7)} ${title}`
}

