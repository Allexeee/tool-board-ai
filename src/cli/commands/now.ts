import { findProject } from '../../core/project.ts'
import { openDb } from '../../core/db.ts'
import { advanceTime } from '../../core/clock.ts'
import { nowView, ownerView, taskQueue, queueFreeReason, sessionState, type OwnerStageRow, type OwnerStageStatus, type QueueRow } from '../../core/views.ts'
import { pendingRelease } from '../../core/git/release.ts'
import { readLiveSessions, type LiveSession } from '../../core/usage.ts'
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
  // живые субагенты — из базы OpenCode; без неё список пуст, доска печатается как раньше
  const sessions = readLiveSessions({ projectDir: project.root })
  const view = nowView(db, { all, sessions })
  const owner = ownerView(db, { all })

  // ownerView уже отдаёт по строке на каждую фичу, включая фичу без этапов
  const stageRows: OwnerStageRow[] = [...owner.stages]

  const featureWidth = Math.max(0, ...stageRows.map((row) => row.featureId.length))
  const progressWidth = Math.max(
    0,
    ...stageRows.map((row) => `${row.progress.current}/${row.progress.total}`.length),
  )
  const decisionsByFeature = new Map(view.features.map((feature) => [feature.id, feature.decisions ?? []]))

  const printed = new Set<string>()
  const features = stageRows.map((row) => {
    const progress = `${row.progress.current}/${row.progress.total}`
    const line = [
      row.featureId.padEnd(featureWidth),
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

  // исполнители и живые субагенты — один список: субагент и есть исполнитель.
  // сессия агента, который уже есть в списке, встаёт в его строку; остальные — своими строками.
  const sessionByAgent = new Map<string, LiveSession>()
  for (const session of view.sessions) {
    // у одного агента живых сессий может быть несколько: в строку идёт свежая, она первая
    if (!sessionByAgent.has(session.agent)) sessionByAgent.set(session.agent, session)
  }

  const holderNames = new Set(view.holders.map((holder) => holder.executor))
  const freeSessions = view.sessions.filter((session) => !holderNames.has(session.agent))
  const nameWidth = Math.max(
    12,
    ...view.holders.map((holder) => holder.executor.length),
    ...freeSessions.map((session) => session.agent.length),
  )

  const holders = view.holders.map((holder) => {
    // занятость без задачи видна так же ясно, как выданная задача: причина и срок.
    const state: string[] = []
    if (holder.active.length > 0) state.push(paint(`держит ${holder.active.join(', ')}`, 'cyan'))
    if (holder.busy) {
      state.push(paint(`занят: ${holder.busy.reason} (до ${shortTime(holder.busy.until)})`, 'cyan'))
    }
    const session = sessionByAgent.get(holder.executor)
    if (session) state.push(paint(sessionState(session), session.busy ? 'cyan' : 'gray'))
    // worker-0 может работать без задачи: пока идёт прогон, он занят
    if (state.length === 0) state.push(holder.working ? paint('работает', 'cyan') : paint('свободен', 'gray'))

    return `  ${holder.executor.padEnd(nameWidth)} ${state.join(' · ')}`
  })

  // живая сессия без исполнителя — такая же строка списка, а не отдельный блок
  const sessionRows = freeSessions.map(
    (session) => `  ${session.agent.padEnd(nameWidth)} ${paint(sessionState(session), session.busy ? 'cyan' : 'gray')}`,
  )
  const executors = [...holders, ...sessionRows]

  const plans = view.plans.map((plan) => `  ${plan.id.padEnd(5)} ${plan.requestId.padEnd(5)} ${plan.title}`)

  // фичи, слитые в dev, но ещё не выпущенные: владельцу видно, что просит релиза
  const waitingMain = view.waitingMain.map((feature) => `  ${feature.id}  ${feature.name}`)

  // пустая строка сверху и табуляция в начале каждой строки: вывод читается как блок, а не как эхо команды.
  const text =
    `Открытых запросов: ${view.requests.length}\n\n` +
    (features.length
      ? features.join('\n')
      : all
        ? 'фич нет'
        : 'фич в работе нет') +
    (view.plans.length ? '\n\nПЛАНЫ НА УТВЕРЖДЕНИЕ\n' + plans.join('\n') : '') +
    (waitingMain.length ? '\n\nЖДЁТ MAIN\n' + waitingMain.join('\n') : '') +
    (queue.length ? `\n\nОЧЕРЕДЬ\n` + queueLines.join('\n') : '') +
    (view.pool.length ? '\n\nПУЛ\n' + pool.join('\n') : '') +
    '\n\nИСПОЛНИТЕЛИ\n' +
    (executors.length ? executors.join('\n') : '  нет')

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




