import type { DatabaseSync } from 'node:sqlite'
import { listEvents } from './events.ts'
import { scopesOverlap } from './git/scope.ts'
import { listTasks, type Task } from './tasks.ts'

/** Неудача в журнале: блокировка держит задачу, переоткрытие возвращает её в работу. */
export type FailureKind = 'block' | 'reopen'

const KIND_LABEL: Record<FailureKind, string> = {
  block: 'блок',
  reopen: 'переоткрытие',
}

const EVENT_KIND: Record<string, FailureKind> = {
  'task.blocked': 'block',
  'task.reopened': 'reopen',
}

export interface FailureRecord {
  taskId: string
  taskTitle: string
  at: string
  kind: FailureKind
  reason: string
  note: string | null
}

/**
 * Каталог — это он и всё под ним: иначе `memory src/core` не нашёл бы задачу
 * с областью `src/core/hands.ts`. Явная маска (`src/*`) остаётся как есть.
 */
export function pathScope(path: string): string[] {
  const normalized = path.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '')
  if (!normalized) return []
  if (normalized.includes('*')) return [normalized]
  return [normalized, `${normalized}/**`]
}

/**
 * Заметка блокировки пишется как `<причина>: <текст>`, поэтому и режем по первому
 * разделителю: причина остаётся кодом, заметка — словами исполнителя.
 * У переоткрытия в заметке живёт сама причина, отдельного кода там нет.
 */
function parseNote(kind: FailureKind, note: string | null): { reason: string; note: string | null } {
  if (kind === 'reopen') return { reason: note?.trim() || 'без причины', note: null }
  if (!note) return { reason: 'без причины', note: null }

  const index = note.indexOf(': ')
  if (index <= 0) return { reason: note.trim(), note: null }
  const text = note.slice(index + 2).trim()
  return { reason: note.slice(0, index).trim(), note: text || null }
}

/** Неудачи задач, чья область пересекается с путём. Свежие сверху. */
export function failureMemory(db: DatabaseSync, path: string): FailureRecord[] {
  const query = pathScope(path)
  if (query.length === 0) return []

  const tasks = new Map<string, Task>()
  for (const task of listTasks(db)) {
    if (scopesOverlap(task.scope, query)) tasks.set(task.id, task)
  }
  if (tasks.size === 0) return []

  // журнал идёт по возрастанию id: индекс хранит порядок и разводит события одной миллисекунды
  const numbered: Array<{ record: FailureRecord; index: number }> = []
  for (const [index, event] of listEvents(db).entries()) {
    const kind = EVENT_KIND[event.type]
    if (!kind) continue

    const task = tasks.get(event.subject)
    if (!task) continue

    const parsed = parseNote(kind, event.note)
    numbered.push({
      index,
      record: {
        taskId: task.id,
        taskTitle: task.title,
        at: event.at,
        kind,
        reason: parsed.reason,
        note: parsed.note,
      },
    })
  }

  numbered.sort((left, right) =>
    left.record.at === right.record.at
      ? right.index - left.index
      : right.record.at.localeCompare(left.record.at),
  )

  return numbered.map((entry) => entry.record)
}

/** Пусто — это ответ, а не ошибка: «в этой области неудач не было». */
export function formatFailureMemory(records: FailureRecord[]): string {
  if (records.length === 0) return 'в этой области неудач не было'

  return records
    .map((record) => {
      const at = record.at.slice(0, 16).replace('T', ' ')
      const label = KIND_LABEL[record.kind].padEnd(12)
      const detail = record.note ? `${record.reason}: ${record.note}` : record.reason
      return `${at}  ${label}  ${record.taskId}  ${record.taskTitle} — ${detail}`
    })
    .join('\n')
}
