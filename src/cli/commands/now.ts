import { findProject } from '../../core/project.ts'
import { openDb } from '../../core/db.ts'
import { advanceTime } from '../../core/clock.ts'
import { nowView, ownerView, taskQueue, queueFreeReason, type OwnerStageRow, type OwnerStageStatus, type QueueRow } from '../../core/views.ts'
import { pendingRelease } from '../../core/git/release.ts'
import { listTasks } from '../../core/tasks.ts'
import { boolFlag, type ParsedArgs } from '../args.ts'
import { ok, paint, setColorMode, type ColorName } from '../output.ts'
import { UserError } from '../errors.ts'

// цвет несёт только смысл: готово — можно не читать, в работе — смотри сюда, очередь — фон.
const stageColor: Record<OwnerStageStatus, ColorName> = {
  done: 'green',
  merge: 'cyan',
  wip: 'magenta',
  pending: 'gray',
}

// цвет строки очереди отвечает на один вопрос: можно ли брать эту задачу сейчас.
// зелёная — можно, жёлтая — уже в чьей-то руке, циан — в работе, серая — чего-то ждёт.
export const queueColor = (row: QueueRow): ColorName => {
  if (row.status === 'active' || row.holder !== null) return 'cyan'
  if (row.hand !== null) return 'yellow'
  if (row.status !== 'ready' || row.waitsFor.length > 0) return 'gray'
  return row.reason === queueFreeReason ? 'green' : 'gray'
}

export default async function command(args: ParsedArgs) {
  const project = findProject(process.cwd())
  if (!project) throw new UserError(3, 'проект не найден: выполните toolbox-al init')
  const db = openDb(project.dbPath)
  advanceTime(db)

  // цвет выключается и флагом, и NO_COLOR; в пайп он не течёт вовсе.
  if (boolFlag(args, 'no-color')) setColorMode(false)

  const all = boolFlag(args, 'all')
  const view = nowView(db, { all })
  const owner = ownerView(db, { all })

  // строки этапов уже отсортированы: готовые → в работе → очередь.
  // фичу без этапов (или только с отменёнными) показываем одной строкой, иначе она исчезает из обзора.
  const stageRows: OwnerStageRow[] = [...owner.stages]
  const shown = new Set(stageRows.map((row) => row.featureId))
  for (const feature of view.features) {
    if (shown.has(feature.id)) continue
    stageRows.push({
      featureId: feature.id,
      featureName: feature.name,
      stageId: '',
      seq: 0,
      total: 0,
      progress: { current: 0, total: 0 },
      status: 'pending',
      name: feature.name,
    })
  }

  const featureWidth = Math.max(0, ...stageRows.map((row) => row.featureId.length))
  const stageWidth = Math.max(0, ...stageRows.map((row) => `[${row.seq}/${row.total}]`.length))
  const progressWidth = Math.max(
    0,
    ...stageRows.map((row) => `${row.progress.current}/${row.progress.total}`.length),
  )
  const decisionsByFeature = new Map(view.features.map((feature) => [feature.id, feature.decisions ?? []]))

  const printed = new Set<string>()
  const features = stageRows.map((row) => {
    const mark = `[${row.seq}/${row.total}]`
    const progress = `${row.progress.current}/${row.progress.total}`
    const line = [
      row.featureId.padEnd(featureWidth),
      mark.padEnd(stageWidth),
      progress.padEnd(progressWidth),
      paint(row.status.padEnd(7), stageColor[row.status]),
      row.name,
    ]
      .join('  ')
      .trimEnd()
    if (printed.has(row.featureId)) return line
    printed.add(row.featureId)
    const decisions = decisionsByFeature.get(row.featureId) ?? []
    return [line, ...decisions.map((decision) => `   · ${decision.question} → ${decision.choice}`)].join('\n')
  })

  const pool = view.pool.map((task) => `  ${task.id.padEnd(12)} ${task.title}`)

  // очередь вместо рук: владельцу нужен порядок задач, а не то, как они разложены по исполнителям
  const queue = taskQueue(db)
  const queueIdWidth = Math.max(0, ...queue.map((row) => row.taskId.length))
  const assignWidth = Math.max(
    8,
    ...queue.map((row) => (row.holder ?? row.hand ?? 'свободна').length),
  )
  const queueLines = queue.map((row) => {
    const assign = row.holder ?? row.hand ?? 'свободна'
    // у свободной задачи причина стоит на месте пустоты: владелец сразу видит, чего она ждёт.
    const note = row.reason
      ? ` · ${row.reason}`
      : row.waitsFor.length > 0
        ? ` · ждёт ${row.waitsFor.join(', ')}`
        : ''
    return `  ${row.taskId.padEnd(queueIdWidth)}  ${paint(assign.padEnd(assignWidth), queueColor(row))}  ${row.title}${note}`
  })

  // сводка внизу: сколько задач стоит на каждой причине. Цифра важнее отдельной строки.
  const reasons = new Map<string, number>()
  for (const row of queue) {
    if (row.reason === null) continue
    reasons.set(row.reason, (reasons.get(row.reason) ?? 0) + 1)
  }
  const reasonWidth = Math.max(0, ...[...reasons.keys()].map((reason) => reason.length))
  const unassigned = reasons.size
    ? '\n\nНЕ РАЗДАНО\n' +
      [...reasons.entries()]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .map(([reason, count]) => `  ${reason.padEnd(reasonWidth)}  ${count}`)
        .join('\n')
    : ''

  const holders = view.holders.map((holder) => {
    // занятость без задачи видна так же ясно, как выданная задача: причина и срок.
    const state: string[] = []
    if (holder.active.length > 0) state.push(paint(`держит ${holder.active.join(', ')}`, 'cyan'))
    if (holder.busy) {
      state.push(paint(`занят: ${holder.busy.reason} (до ${shortTime(holder.busy.until)})`, 'cyan'))
    }
    if (state.length === 0) state.push(paint('свободен', 'gray'))

    return `  ${holder.executor.padEnd(12)} ${state.join(' · ')}`
  })

  const plans = view.plans.map((plan) => `  ${plan.id.padEnd(5)} ${plan.requestId.padEnd(5)} ${plan.title}`)

  // два счётчика ожидания стоят рядом: сколько просит работы и сколько ждёт решения владельца.
  // пустая строка сверху и табуляция в начале каждой строки: вывод читается как блок, а не как эхо команды.
  const pending = pendingRelease(db)
  const pendingBlock = pending.length
    ? `\n\nОЖИДАЕТ РЕЛИЗА: ${pending.length} ${stagesWord(pending.length)}\n` +
      pending
        .map((stage) => {
          const count = listTasks(db, { stageId: stage.stageId }).length
          return `  ${stage.stageId.padEnd(7)} ${stage.stageName}  (${count})`
        })
        .join('\n')
    : ''

  const text =
    `Открытых запросов: ${view.requests.length}\n` +
    `ждёт вас: ${view.waitingOwner}\n\n` +
    (features.length
      ? features.join('\n')
      : all
        ? 'фич нет'
        : 'фич в работе нет') +
    (view.plans.length ? '\n\nПЛАНЫ НА УТВЕРЖДЕНИЕ\n' + plans.join('\n') : '') +
    pendingBlock +
    (queue.length ? `\n\nОЧЕРЕДЬ\n` + queueLines.join('\n') : '') +
    (view.pool.length ? '\n\nПУЛ\n' + pool.join('\n') : '') +
    '\n\nИСПОЛНИТЕЛИ\n' +
    (holders.length ? holders.join('\n') : '  нет') +
    unassigned

  ok(view, '\n' + indent(text))
  return 0
}

/** Согласование с числом: 1 этап, 2 этапа, 5 этапов, 21 этап, но 11-14 всегда этапов. */
function stagesWord(count: number): string {
  const mod100 = count % 100
  const mod10 = count % 10
  if (mod100 >= 11 && mod100 <= 14) return 'этапов'
  if (mod10 === 1) return 'этап'
  if (mod10 >= 2 && mod10 <= 4) return 'этапа'
  return 'этапов'
}

/** Пустые строки остаются разделителями, содержательные — начинаются с табуляции. */
function indent(text: string): string {
  return text
    .split('\n')
    .map((line) => (line.trim() === '' ? '' : '\t' + line))
    .join('\n')
}

/** Срок занятости печатается локальным временем: человек читает часы, а не ISO. */
function shortTime(iso: string): string {
  const at = new Date(iso)
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${pad(at.getHours())}:${pad(at.getMinutes())}`
}

