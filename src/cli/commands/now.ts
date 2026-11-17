import { findProject } from '../../core/project.ts'
import { openDb } from '../../core/db.ts'
import { advanceTime } from '../../core/clock.ts'
import { nowView, ownerView, type OwnerStageRow, type OwnerStageStatus } from '../../core/views.ts'
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

  const holders = view.holders.map((holder) => {
    // занятость без задачи видна так же ясно, как выданная задача: причина и срок.
    const state: string[] = []
    if (holder.active.length > 0) state.push(paint(`держит ${holder.active.join(', ')}`, 'cyan'))
    if (holder.busy) {
      state.push(paint(`занят: ${holder.busy.reason} (до ${shortTime(holder.busy.until)})`, 'cyan'))
    }
    if (state.length === 0) state.push(paint('свободен', 'gray'))

    const hand = holder.hand.length > 0 ? `рука: ${holder.hand.join(', ')}` : 'рука пуста'
    return `  ${holder.executor.padEnd(12)} ${state.join(' · ')} · ${hand}`
  })

  const plans = view.plans.map((plan) => `  ${plan.id.padEnd(5)} ${plan.requestId.padEnd(5)} ${plan.title}`)

  // два счётчика ожидания стоят рядом: сколько просит работы и сколько ждёт решения владельца.
  // пустая строка сверху и табуляция в начале каждой строки: вывод читается как блок, а не как эхо команды.
  const pending = pendingRelease(db)
  const pendingBlock = pending.length
    ? `\n\nОЖИДАЕТ РЕЛИЗА: ${pending.length} этапов\n` +
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
    (view.pool.length ? '\n\nПУЛ\n' + pool.join('\n') : '') +
    '\n\nИСПОЛНИТЕЛИ\n' +
    (holders.length ? holders.join('\n') : '  нет')

  ok(view, '\n' + indent(text))
  return 0
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

