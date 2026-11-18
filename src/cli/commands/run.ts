import { findProject } from '../../core/project.ts'
import { openDb } from '../../core/db.ts'
import {
  activeRun,
  endRun,
  lastClosedRun,
  reviewOf,
  reviewRun,
  reviewState,
  startRun,
  type RunEndReason,
  type RunPower,
  type RunRecord,
  type RunReviewState,
} from '../../core/runs.ts'
import {
  HIBERNATE_COUNTDOWN_SECONDS,
  SHUTDOWN_CANCEL,
  hibernateInstalled,
  orderRunPower,
  planRunPower,
  schedulePower,
  type CommandRunner,
  type PowerOutcome,
} from '../../core/power.ts'
import { boolFlag, listFlag, stringFlag, type ParsedArgs } from '../args.ts'
import { isJsonMode, ok } from '../output.ts'
import { UserError } from '../errors.ts'
import { renderRunReport, writeRunReport } from '../../core/run-report.ts'
import { renderHandoffSummary, renderResumeBrief, resumeRun, writeHandoff } from '../../core/handoff.ts'
import { appendPowerLog } from '../../core/power.ts'
import { readUsage, type Pricing, type UsageReport } from '../../core/usage.ts'
import type { Config } from '../../core/config.ts'
import { relative } from 'node:path'
import { spawnSync } from 'node:child_process'

const MODE_LABEL = { plan: 'по плану', all: 'доталово' } as const
const POWER_LABEL = { none: 'не трогать', hibernate: 'гибернация', shutdown: 'выключение' } as const
const REASON_LABEL = { owner: 'владелец', tasks: 'задачи', decision: 'решение' } as const

// «ревью не было» и «готов к релизу» — не украшение, а разное право на релиз
const REVIEW_LABEL: Record<RunReviewState, string | null> = {
  open: null,
  not_required: 'ревью не было',
  needs_review: 'нужно ревью',
  found: 'ревью нашло замечания',
  ready: 'готов к релизу',
}

const USAGE =
  'использование: run start --mode plan|all [--request R1 …] [--nearest] [--approve] ' +
  '[--power none|hibernate|shutdown] · run end <id> --reason owner|tasks|decision ' +
  '[--power hibernate|shutdown] · run review <id> --verdict ok|found [--note "…"] · ' +
  'run handoff [<id>] · run resume · run report <id> · run power <id> [--power hibernate|shutdown] · run usage [бюджет] · run show'

/** Настоящие системные команды: только из CLI, в тестах runner подменяется. */
const systemRunner: CommandRunner = (command, args) => {
  const result = spawnSync(command, args, { encoding: 'utf8', windowsHide: true })
  return {
    status: result.status ?? null,
    output: `${result.stdout ?? ''}${result.stderr ?? ''}`,
  }
}


function stamp(iso: string): string {
  const at = new Date(iso)
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${pad(at.getDate())}.${pad(at.getMonth() + 1)} ${pad(at.getHours())}:${pad(at.getMinutes())}`
}

function describe(run: RunRecord): string {
  const requests = run.requests.length > 0 ? run.requests.join(', ') : 'не выбраны'
  const parts: string[] = [MODE_LABEL[run.mode], `запросы: ${requests}`]

  // «ближайшие» — это добор сверху списка, поэтому и называем его рядом с запросами
  if (run.nearest) parts.push('плюс ближайшие')
  parts.push(`утверждение: ${run.approve ? 'да' : 'нет'}`)
  parts.push(`питание: ${POWER_LABEL[run.power]}`)

  return parts.join(' · ')
}

function reasonText(run: RunRecord): string {
  if (!run.endReason) return 'не указана'
  return REASON_LABEL[run.endReason] ?? run.endReason
}

/** Число с пробелами между разрядами: 7 307 361 читается, 7307361 — нет. */
function num(value: number): string {
  return Math.round(value).toLocaleString('ru-RU').replace(/\u00A0/g, ' ')
}

function money(value: number): string {
  return value.toFixed(2)
}

function percentText(value: number | null): string {
  if (value === null) return '—'
  return `${Number(value.toFixed(1))}%`
}

/** «1 сессия», «2 сессии», «5 сессий»: счёт без кривого падежа. */
function sessionsWord(count: number): string {
  const tail = count % 100
  if (tail >= 11 && tail <= 14) return 'сессий'
  switch (count % 10) {
    case 1:
      return 'сессия'
    case 2:
    case 3:
    case 4:
      return 'сессии'
    default:
      return 'сессий'
  }
}

/** Бюджет из позиции (`run usage 60`) или известного флага `--limit`. */
function budgetOf(args: ParsedArgs): number | null {
  const raw = args.positionals[0] ?? stringFlag(args, 'limit')
  if (raw === undefined) return null
  const value = Number(raw.replace(',', '.'))
  if (!Number.isFinite(value) || value <= 0) {
    throw new UserError(3, `бюджет должен быть положительным числом: ${raw}`)
  }
  return value
}

function renderUsage(report: UsageReport): string {
  const sessions = report.totals.sessions
  const lines = [`учёт токенов: ${num(sessions)} ${sessionsWord(sessions)} · база ${report.dbPath}`]

  if (report.agents.length === 0) {
    lines.push('сессий в базе нет: считать нечего')
    return lines.join('\n')
  }

  const header = ['агент', 'сессий', 'вход', 'выход', 'разум', 'кеш чт', 'кеш за', 'cost', '%']
  const rows = report.agents.map((agent) => [
    agent.agent,
    num(agent.sessions),
    num(agent.input),
    num(agent.output),
    num(agent.reasoning),
    num(agent.cacheRead),
    num(agent.cacheWrite),
    money(agent.cost),
    percentText(agent.percent),
  ])

  const totalPercent =
    report.budget === null || report.basis === 'share'
      ? 100
      : report.basis === 'cost'
        ? (report.totals.cost / report.budget) * 100
        : (report.totals.amount / report.budget) * 100
  rows.push([
    'итого',
    num(report.totals.sessions),
    num(report.totals.input),
    num(report.totals.output),
    num(report.totals.reasoning),
    num(report.totals.cacheRead),
    num(report.totals.cacheWrite),
    money(report.totals.cost),
    percentText(totalPercent),
  ])

  // ширины считаем по содержимому: цифры не должны разъезжаться на длинных числах
  const widths = header.map((title, index) =>
    Math.max(title.length, ...rows.map((row) => row[index]?.length ?? 0)),
  )

  const render = (row: string[]) =>
    row
      .map((cell, index) => (index === 0 ? cell.padEnd(widths[index]!) : cell.padStart(widths[index]!)))
      .join('  ')

  lines.push(render(header), ...rows.map(render))

  const basis =
    report.basis === 'cost'
      ? report.budget === null
        ? 'процент: доля агента от общего cost (бюджет не задан)'
        : `процент: cost из базы от бюджета ${money(report.budget)}`
      : report.basis === 'tariff'
        ? report.budget === null
          ? 'процент: доля агента от общего расхода по тарифу (бюджет не задан)'
          : `процент: цена токенов по тарифу проекта от бюджета ${money(report.budget)}`
        : 'процент: доля агента от общего расхода токенов (тариф не задан)'

  lines.push(basis)
  return lines.join('\n')
}

export default async function command(args: ParsedArgs) {
  const project = findProject(process.cwd())
  if (!project) throw new UserError(3, 'проект не найден: выполните toolbox-al init')
  const db = openDb(project.dbPath)

  if (args.sub === 'start') {
    const run = startRun(db, {
      mode: (stringFlag(args, 'mode') ?? 'plan') as 'plan' | 'all',
      requests: listFlag(args, 'request'),
      nearest: boolFlag(args, 'nearest'),
      approve: boolFlag(args, 'approve'),
      power: (stringFlag(args, 'power') ?? 'none') as RunPower,
      actor: stringFlag(args, 'as') ?? 'owner',
    })

    ok(run, `${run.id}  ${describe(run)}`)
    return 0
  }

  if (args.sub === 'end') {
    const id = args.positionals[0]
    const reason = stringFlag(args, 'reason')
    const power = stringFlag(args, 'power')
    if (!id || !reason) {
      throw new UserError(3, 'использование: run end RUN1 --reason owner|tasks|decision')
    }

    const actor = stringFlag(args, 'as') ?? 'owner'
    // питание идёт в тот же коммит, что и конец: неверный заказ прогон не закрывает
    const run = endRun(db, {
      id,
      reason: reason as RunEndReason,
      power: power === undefined ? undefined : (power as RunPower),
      actor,
    })

    const state = reviewState(run, reviewOf(db, run.id))
    const lines = [`${run.id}  закрыт · причина: ${reasonText(run)} · ${REVIEW_LABEL[state] ?? ''}`.trim()]
    if (power) {
      lines.push(`питание: ${POWER_LABEL[run.power]} после отчёта, выполнит run power ${run.id}`)
    }

    ok(run, lines.join('\n'))
    return 0
  }

  if (args.sub === 'review') {
    const id = args.positionals[0]
    const verdict = stringFlag(args, 'verdict')
    if (!id || !verdict) {
      throw new UserError(3, 'использование: run review RUN1 --verdict ok|found [--note "…"]')
    }

    const run = reviewRun(db, {
      id,
      verdict: verdict as 'ok' | 'found',
      note: stringFlag(args, 'note'),
      actor: stringFlag(args, 'as') ?? 'owner',
    })

    const review = reviewOf(db, run.id)
    const state = reviewState(run, review)
    const note = review?.note ? ` · замечания: ${review.note}` : ''
    ok(
      { run, review },
      `${run.id}  ревью: ${verdict} · ${REVIEW_LABEL[state] ?? ''}${note}`.trim(),
    )
    return 0
  }

  if (args.sub === 'report') {
    const id = args.positionals[0]
    if (!id) throw new UserError(3, 'использование: run report RUN1')

    // отчёт пишется файлом: владелец читает его утром, а не листает чат
    const report = writeRunReport(db, id, { root: project.root })
    const shown = relative(process.cwd(), report.path).replace(/\\/g, '/')

    ok(
      { ...report, path: shown },
      `${renderRunReport(report)}\nотчёт: ${shown}`,
    )
    return 0
  }

  if (args.sub === 'handoff') {
    // по умолчанию — идущий прогон: эстафета нужна ровно тогда, когда он идёт
    const id = args.positionals[0] ?? activeRun(db)?.id
    if (!id) {
      throw new UserError(1, 'открытого прогона нет: эстафета пишется по идущему прогону, сначала run start')
    }

    const handoff = writeHandoff(db, id, {
      root: project.root,
      actor: stringFlag(args, 'as') ?? 'orchestrator',
    })
    const json = relative(process.cwd(), handoff.jsonPath).replace(/\\/g, '/')
    const md = relative(process.cwd(), handoff.mdPath).replace(/\\/g, '/')

    ok(
      { ...handoff, jsonPath: json, mdPath: md },
      `${renderHandoffSummary(handoff)}\nфайлы: ${md} · ${json}`,
    )
    return 0
  }

  if (args.sub === 'resume') {
    // новая сессия начинает с файла: он свежее памяти и чата
    const brief = resumeRun(db, {
      root: project.root,
      actor: stringFlag(args, 'as') ?? 'orchestrator',
    })

    ok(brief, renderResumeBrief(brief))
    return 0
  }

  if (args.sub === 'power') {
    const id = args.positionals[0]
    if (!id) throw new UserError(3, 'использование: run power RUN1 [--power hibernate|shutdown]')
    if (process.platform !== 'win32') {
      throw new UserError(1, 'питание после прогона сделано для Windows: hiberfil.sys и shutdown')
    }

    // заказ можно поставить и на уже закрытом прогоне: подсказка run power --power не тупик
    const requested = stringFlag(args, 'power')
    if (requested !== undefined) {
      orderRunPower(db, {
        runId: id,
        power: requested as RunPower,
        actor: stringFlag(args, 'as') ?? 'owner',
      })
    }

    // гибернации может не быть: тогда честно выключаемся, а не ждём ночь впустую.
    // Признак один — hiberfil.sys; текст powercfg /a врёт и больше не читается.
    const plan = planRunPower(db, project.root, id, {
      hibernateAvailable: hibernateInstalled(),
    })

    const shown = relative(process.cwd(), plan.reportPath).replace(/\\/g, '/')
    const lines = [`${plan.run.id}  ${POWER_LABEL[plan.requested]} после отчёта`, `отчёт: ${shown}`]
    if (plan.note) lines.push(plan.note)

    // Ctrl+C успевает отменить только отсчёт гибернации: `shutdown /h` не умеет
    // таймер. У выключения отсчёт живёт в Windows, и отмена у него своя —
    // `shutdown /a`, поэтому ждать в процессе нечего.
    const controller = new AbortController()
    const onSigint = () => controller.abort()
    if (plan.action === 'hibernate') process.once('SIGINT', onSigint)
    else if (!isJsonMode()) {
      process.stdout.write(
        `выключение через ${HIBERNATE_COUNTDOWN_SECONDS} с — таймер Windows, отмена: ${SHUTDOWN_CANCEL}\n`,
      )
    }

    // каждый вызов и его код — в журнал: иначе неудачный shutdown выглядит как успех
    let failed = 0
    const loggedRunner: CommandRunner = (command, args) => {
      const result = systemRunner(command, args)
      const status = result.status ?? 'null'
      if (result.status !== 0) failed += 1
      appendPowerLog(
        project.root,
        `${command} ${args.join(' ')} → ${status}${result.output.trim() ? ` · ${result.output.trim()}` : ''}`,
      )
      return result
    }

    let outcome: PowerOutcome
    try {
      outcome = await schedulePower({
        action: plan.action,
        runner: loggedRunner,
        seconds: HIBERNATE_COUNTDOWN_SECONDS,
        signal: controller.signal,
        onTick: (left) => {
          if (isJsonMode()) return
          process.stdout.write(`\rгибернация через ${left} с, Ctrl+C отменяет   `)
        },
      })
    } finally {
      process.off('SIGINT', onSigint)
    }

    // отсчёт гибернации печатался в одну строку через \r — закрываем её
    if (!isJsonMode() && plan.action === 'hibernate') process.stdout.write('\n')

    appendPowerLog(project.root, `итог: ${outcome}, действие ${plan.action}, отчет ${shown}`)

    const performed = POWER_LABEL[outcome as 'hibernate' | 'shutdown'] ?? 'питание'
    lines.push(
      outcome === 'cancelled'
        ? 'питание отменено: машина остаётся включённой'
        : failed > 0
          ? `питание: ${performed} не подтверждена — код возврата записан в журнал`
          : outcome === 'shutdown'
            ? `питание: выключение запланировано через ${HIBERNATE_COUNTDOWN_SECONDS} с, отмена: ${SHUTDOWN_CANCEL}`
            : `питание: ${performed} выполнена`,
    )

    ok(
      {
        run: plan.run,
        requested: plan.requested,
        action: plan.action,
        reportPath: shown,
        outcome,
        cancel: plan.action === 'shutdown' ? SHUTDOWN_CANCEL : null,
      },
      lines.join('\n'),
    )
    return 0
  }

  if (args.sub === 'usage') {
    const pricing = (project.config as Config & { pricing?: Pricing }).pricing ?? null
    // чужой расход не считаем: только сессии этого проекта и, если прогон идёт, его окно
    const active = activeRun(db)
    const startedAt = active ? Date.parse(active.startedAt) : Number.NaN
    const window = Number.isFinite(startedAt) ? { from: startedAt } : null
    const result = readUsage({ pricing, budget: budgetOf(args), projectDir: project.root, window })

    if (!result.available) {
      ok(result, result.reason)
      return 1
    }

    ok(result, renderUsage(result))
    return 0
  }

  if (args.sub === 'show' || args.sub === null) {
    const active = activeRun(db)
    const lastClosed = lastClosedRun(db)
    const review = lastClosed ? reviewOf(db, lastClosed.id) : null
    const state = lastClosed ? reviewState(lastClosed, review) : null

    const lines: string[] = []
    if (active) lines.push(`${active.id}  идёт с ${stamp(active.startedAt)}  ${describe(active)}`)
    if (lastClosed) {
      const verdict = state ? REVIEW_LABEL[state] : null
      const tail = [lastClosed.endReason ? `причина: ${reasonText(lastClosed)}` : null, verdict]
        .filter((part): part is string => Boolean(part))
        .join(' · ')
      lines.push(
        `${lastClosed.id}  закрыт ${stamp(lastClosed.endedAt ?? lastClosed.startedAt)}  ` +
          `${describe(lastClosed)}${tail ? '  ' + tail : ''}`,
      )
    }

    ok(
      { active, lastClosed, review, state },
      lines.length > 0 ? lines.join('\n') : 'прогонов ещё не было',
    )
    return 0
  }

  throw new UserError(3, USAGE)
}

