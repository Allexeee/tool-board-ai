import type { DatabaseSync } from 'node:sqlite'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { UserError } from '../cli/errors.ts'
import { tx } from './db.ts'
import { appendEvent } from './events.ts'
import { ownerHand, type OwnerItem } from './questions.ts'
import type { TaskSize, TaskStatus } from './tasks.ts'
import { bumpRunSegment, getRunRecord, type RunRecord } from './runs.ts'

// ─── эстафета прогона: состояние переезжает в новую сессию ───────────────────
//
// Прогон один, сессий несколько. Когда оркестратор упирается в контекст, он
// снимает состояние в файл: что сделано, что в работе, что в очереди, чего
// ждёт владелец и с чего начинать дальше. Новая сессия читает файл, а не
// переписку, и продолжает с того же места. Номер сегмента живёт в базе: файл
// перезаписывается, история сегментов — нет.

export interface HandoffStageRow {
  featureId: string
  featureName: string
  stageId: string
  stageName: string
  mergedAt: string
}

export interface HandoffTaskRow {
  id: string
  title: string
  status: TaskStatus
  size: TaskSize
  skill: string
  /** Кто держит задачу сейчас; у готовой — null. */
  holder: string | null
  /** До какого времени держатель вправе молчать. */
  leaseUntil: string | null
  stageId: string | null
  featureId: string | null
  featureName: string | null
  /** Каталог, в котором задача делается: работа без него не продолжается. */
  worktree: string | null
  /** Исполнитель, к которому задача поставлена в руку (ещё не взята). */
  hand: string | null
}

export interface HandoffData {
  run: RunRecord
  /** Сегмент, который снимается этим файлом: он же в runs до сдвига. */
  segment: number
  /** Когда снято состояние. */
  at: string
  /** Сделано: этапы, слитые в dev, пока шёл прогон. */
  done: HandoffStageRow[]
  /** В работе: задачи, которые кто-то держит или которые ждут приёмки. */
  inWork: HandoffTaskRow[]
  /** Очередь готовых: их можно брать, как только освободятся руки. */
  queue: HandoffTaskRow[]
  /** Нужны решения: вопросы, задачи и этапы, которые ждут владельца. */
  owner: OwnerItem[]
  /** С чего начинать новой сессии — одной строкой. */
  nextStep: string
}

export interface Handoff extends HandoffData {
  jsonPath: string
  mdPath: string
}

interface TaskRow {
  id: string
  title: string
  status: TaskStatus
  size: TaskSize
  skill: string
  holder: string | null
  lease_until: string | null
  stage_id: string | null
  feature_id: string | null
  feature_name: string | null
  worktree: string | null
  hand: string | null
}

const toTaskRow = (row: TaskRow): HandoffTaskRow => ({
  id: row.id,
  title: row.title,
  status: row.status,
  size: row.size,
  skill: row.skill,
  holder: row.holder,
  leaseUntil: row.lease_until,
  stageId: row.stage_id,
  featureId: row.feature_id,
  featureName: row.feature_name,
  worktree: row.worktree,
  hand: row.hand,
})

/**
 * Задачи с местом работы: каталог берётся у фичи этапа, а не у проекта —
 * иначе новая сессия пошла бы работать в чужой каталог.
 */
function tasksWithPlace(db: DatabaseSync, statuses: TaskStatus[]): HandoffTaskRow[] {
  const marks = statuses.map(() => '?').join(', ')

  const rows = db
    .prepare(
      'select t.id as id, t.title as title, t.status as status, t.size as size, t.skill as skill, ' +
        't.holder as holder, t.lease_until as lease_until, t.stage_id as stage_id, ' +
        'st.feature_id as feature_id, f.name as feature_name, f.worktree as worktree, ' +
        'h.executor_id as hand ' +
        'from tasks t ' +
        'left join stages st on st.id = t.stage_id ' +
        'left join features f on f.id = st.feature_id ' +
        'left join hand h on h.task_id = t.id ' +
        `where t.status in (${marks}) ` +
        'order by coalesce(f.rank, 999), coalesce(st.seq, 999), t.id',
    )
    .all(...statuses) as unknown as TaskRow[]

  return rows.map(toTaskRow)
}

/** Этапы, слитые в dev, пока шёл прогон: от старта до снятия состояния. */
function mergedInRun(db: DatabaseSync, run: RunRecord, to: string): HandoffStageRow[] {
  return db
    .prepare(
      'select f.id as featureId, f.name as featureName, s.id as stageId, s.name as stageName, ' +
        's.merged_at as mergedAt ' +
        'from stages s join features f on f.id = s.feature_id ' +
        "where s.status = 'merged' and s.merged_at is not null " +
        'and s.merged_at >= ? and s.merged_at <= ? ' +
        'order by s.merged_at, s.id',
    )
    .all(run.startedAt, to) as unknown as HandoffStageRow[]
}

/**
 * Следующий шаг новой сессии. Порядок не случаен: решение владельца держит
 * всё остальное, работа в руках важнее очереди, а пустая очередь — это конец
 * прогона, а не повод ждать.
 */
function nextStepOf(run: RunRecord, owner: OwnerItem[], inWork: HandoffTaskRow[], queue: HandoffTaskRow[]): string {
  if (owner.length > 0) {
    return `дождаться владельца: ${owner.map((item) => item.id).join(', ')}`
  }
  if (inWork.length > 0) {
    const first = inWork[0]!
    const who = first.holder ?? first.hand ?? 'без держателя'
    return `продолжить в работе: ${first.id} «${first.title}» — ${who}`
  }
  if (queue.length > 0) {
    const first = queue[0]!
    return `взять из очереди: ${first.id} «${first.title}»`
  }
  return `очередь пуста: закрыть прогон — run end ${run.id} --reason tasks`
}

export function collectHandoff(
  db: DatabaseSync,
  runId: string,
  options: { now?: Date } = {},
): HandoffData {
  const run = getRunRecord(db, runId)
  if (!run) throw new UserError(3, `прогон ${runId} не найден`)

  // эстафета — про идущий прогон: закрытому передавать нечего, у него есть отчёт
  if (run.endedAt) {
    throw new UserError(
      1,
      `прогон ${run.id} уже закрыт ${run.endedAt}: эстафета пишется по идущему прогону, ` +
        `для закрытого есть run report ${run.id}`,
    )
  }

  const at = (options.now ?? new Date()).toISOString()
  const done = mergedInRun(db, run, at)
  const inWork = tasksWithPlace(db, ['active', 'in_review'])
  const queue = tasksWithPlace(db, ['ready'])
  const owner = ownerHand(db)

  return {
    run,
    segment: run.segment,
    at,
    done,
    inWork,
    queue,
    owner,
    nextStep: nextStepOf(run, owner, inWork, queue),
  }
}

const MODE_TEXT = { plan: 'по плану', all: 'доталово' } as const
const STATUS_TEXT: Partial<Record<TaskStatus, string>> = {
  active: 'в работе',
  in_review: 'на ревью',
  ready: 'готова',
}

function stamp(iso: string): string {
  const at = new Date(iso)
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${pad(at.getDate())}.${pad(at.getMonth() + 1)}.${at.getFullYear()} ${pad(at.getHours())}:${pad(at.getMinutes())}`
}

function ownerLine(item: OwnerItem): string {
  if (item.kind === 'question') {
    const question = item.item as { text: string; deadline?: string | null }
    const deadline = question.deadline ? ` (срок ${stamp(question.deadline)})` : ''
    return `- вопрос ${item.id}: «${question.text}»${deadline}`
  }
  if (item.kind === 'task') {
    const task = item.item as { title: string; status: string }
    return `- задача ${item.id}: «${task.title}» (${task.status})`
  }
  const stage = item.item as { name: string; status: string }
  return `- этап ${item.id}: «${stage.name}» (${stage.status})`
}

function placeText(task: HandoffTaskRow): string {
  const parts: string[] = []
  if (task.featureId) {
    parts.push(`фича ${task.featureId}${task.featureName ? ` «${task.featureName}»` : ''}`)
  }
  if (task.stageId) parts.push(`этап ${task.stageId}`)
  return parts.join(', ')
}

function taskLine(task: HandoffTaskRow): string {
  const place = placeText(task)
  const where = place ? ` (${place})` : ''
  const status = STATUS_TEXT[task.status] ?? task.status
  return `- ${task.id} «${task.title}» — ${status}${where}`
}

function workLine(task: HandoffTaskRow): string {
  const who = task.holder ?? task.hand ?? 'без держателя'
  const lease = task.leaseUntil ? `аренда до ${stamp(task.leaseUntil)}` : 'аренды нет'
  const worktree = task.worktree ? `каталог ${task.worktree}` : 'каталога нет'
  const place = placeText(task)
  const tail = place ? ` · ${place}` : ''
  return `- ${task.id} «${task.title}» — ${who}, ${lease}, ${worktree}${tail}`
}

/**
 * Текст эстафеты. Разделы печатаются всегда, даже пустые: новая сессия должна
 * видеть, что работы нет, а не догадываться по отсутствию заголовка.
 */
export function renderHandoff(data: HandoffData): string {
  const { run } = data
  const requests = run.requests.length > 0 ? run.requests.join(', ') : 'не выбраны'

  const head = [
    `# Эстафета прогона ${run.id} · сегмент ${data.segment}`,
    '',
    `- режим: ${MODE_TEXT[run.mode]}${run.nearest ? ' (плюс ближайшие запросы)' : ''}`,
    `- запросы: ${requests}`,
    `- начат: ${stamp(run.startedAt)}`,
    `- снято: ${stamp(data.at)}`,
    `- следующий шаг: ${data.nextStep}`,
  ]

  const blocks = [head.join('\n')]

  blocks.push(
    ['## Сделано', '', ...(data.done.length > 0 ? data.done.map(
      (row) =>
        `- ${row.stageId} «${row.stageName}» (фича ${row.featureId} «${row.featureName}»), ` +
        `слит в dev ${stamp(row.mergedAt)}`,
    ) : ['- пусто'])].join('\n'),
  )

  blocks.push(
    ['## В работе', '', ...(data.inWork.length > 0 ? data.inWork.map(workLine) : ['- пусто'])].join('\n'),
  )

  blocks.push(
    ['## Очередь готовых', '', ...(data.queue.length > 0 ? data.queue.map(taskLine) : ['- пусто'])].join('\n'),
  )

  blocks.push(
    [
      '## Нужны решения владельца',
      '',
      ...(data.owner.length > 0 ? data.owner.map(ownerLine) : ['- пусто']),
    ].join('\n'),
  )

  return blocks.join('\n\n') + '\n'
}

/** Строка для экрана: то же состояние, но без пересказа файла целиком. */
export function renderHandoffSummary(data: HandoffData): string {
  return (
    `${data.run.id}  сегмент ${data.segment} · сделано: ${data.done.length} · ` +
    `в работе: ${data.inWork.length} · очередь: ${data.queue.length} · ` +
    `нужны решения: ${data.owner.length}\n` +
    `следующий шаг: ${data.nextStep}`
  )
}

/**
 * Снять состояние прогона в файлы и открыть следующий сегмент. Файлы пишутся
 * до сдвига: сегмент в них — тот, который закончился, а в базе уже следующий.
 */
export function writeHandoff(
  db: DatabaseSync,
  runId: string,
  options: { root: string; now?: Date; actor?: string },
): Handoff {
  const data = collectHandoff(db, runId, options)
  const dir = join(options.root, '.toolbox-al', 'reports')
  const jsonPath = join(dir, `${data.run.id}-handoff.json`)
  const mdPath = join(dir, `${data.run.id}-handoff.md`)

  mkdirSync(dir, { recursive: true })
  writeFileSync(jsonPath, JSON.stringify(data, null, 2) + '\n', 'utf8')
  writeFileSync(mdPath, renderHandoff(data), 'utf8')

  tx(db, () => {
    bumpRunSegment(db, data.run.id)
    appendEvent(db, {
      type: 'run.handoff',
      actor: options.actor ?? 'orchestrator',
      subject: data.run.id,
      after: { segment: data.segment, nextStep: data.nextStep },
    })
  })

  return { ...data, jsonPath, mdPath }
}
