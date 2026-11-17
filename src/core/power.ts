import type { DatabaseSync } from 'node:sqlite'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { UserError } from '../cli/errors.ts'
import { appendEvent } from './events.ts'
import { getRunRecord, runPowerOf, type RunPower, type RunRecord } from './runs.ts'

// ─── питание после прогона ───────────────────────────────────────────────────
//
// Ночной прогон освобождает машину сам, но только если владелец попросил об
// этом явно (run start/end --power …) и только после отчёта на диске: сначала
// бумаги, потом выключение. Гибернация не вырубает питание сразу — даёт 90
// секунд на «ой, я ещё тут» с отменой по Ctrl+C.

export const HIBERNATE_COUNTDOWN_SECONDS = 90

/** Что печатается и выполняется: одна точка правды для команды и для тестов. */
export const POWER_COMMANDS = {
  hibernate: { command: 'shutdown', args: ['/h'] },
  shutdown: { command: 'shutdown', args: ['/s', '/t', '0'] },
} as const

export type PowerAction = 'hibernate' | 'shutdown' | 'none'
export type PowerOutcome = 'hibernate' | 'shutdown' | 'none' | 'cancelled'

export interface CommandResult {
  status: number | null
  output: string
}

/** Любой исполнитель команд: настоящий spawnSync в CLI, шпион в тестах. */
export type CommandRunner = (command: string, args: string[]) => CommandResult

/**
 * Есть ли гибернация: `powercfg /a` перечисляет состояния сна, и слово
 * «hibernate» (на русской системе «гибернация») в выводе — достаточный признак.
 * Если признак обманет, `shutdown /h` просто не сработает: машина останется
 * включённой, а отчёт уже на диске — данные не теряются.
 */
export function hibernateSupported(output: string): boolean {
  const text = output.toLowerCase()
  return text.includes('hibernate') || text.includes('гибернация')
}

/** Гибернации нет — значит выключение: молча остаться с ноутбуком на ночь хуже. */
export function effectivePower(power: PowerAction, hibernateAvailable: boolean): PowerAction {
  if (power !== 'hibernate') return power
  return hibernateAvailable ? 'hibernate' : 'shutdown'
}

export interface RunPowerPlan {
  run: RunRecord
  /** Что записано в прогоне. */
  requested: PowerAction
  /** Что реально будет выполнено на этой машине. */
  action: PowerAction
  /** Отчёт, после которого питание разрешено. */
  reportPath: string
  /** Почему действие отличается от заказанного. */
  note: string | null
}

/**
 * Файл отчёта прогона. Имя собирает run-report, поэтому ищем по префиксу:
 * питание зависит от факта «отчёт на диске», а не от формата имени.
 */
export function reportFile(root: string, runId: string): string | null {
  const dir = join(root, '.toolbox-al', 'reports')
  if (!existsSync(dir)) return null

  const file = readdirSync(dir).find((name) => name.startsWith(`${runId}-`) && name.endsWith('.md'))
  return file ? join(dir, file) : null
}

/**
 * Допуск на свежесть: отчёт, записанный с точностью до секунды, не должен
 * считаться старым из-за округления mtime файловой системы.
 */
export const REPORT_FRESHNESS_TOLERANCE_MS = 1000

/** Когда отчёт записан: mtime файла, а не дата в имени и не содержимое. */
function reportWrittenAt(path: string): number | null {
  try {
    return statSync(path).mtimeMs
  } catch {
    return null
  }
}

/** Старше ли отчёт конца прогона: по такой бумаге питание не выполняется. */
function reportIsStale(writtenAt: number, endedAt: string): boolean {
  const ended = Date.parse(endedAt)
  if (Number.isNaN(ended)) return false

  // конец из будущего (сбитые часы) — сверяемся с текущим моментом: иначе
  // отчёт, написанный прямо сейчас, был бы «старым» всегда и питание не сработало бы
  const reference = Math.min(ended, Date.now())
  return writtenAt + REPORT_FRESHNESS_TOLERANCE_MS < reference
}

/**
 * План питания: прогон закрыт, питание заказано, отчёт записан после конца.
 * Иначе отказ с подсказкой — что именно ещё не сделано.
 */
export function planRunPower(
  db: DatabaseSync,
  root: string,
  runId: string,
  options: { hibernateAvailable: boolean },
): RunPowerPlan {
  const run = getRunRecord(db, runId)
  if (!run) throw new UserError(3, `прогон ${runId} не найден`)

  if (!run.endedAt) {
    throw new UserError(
      1,
      `прогон ${run.id} ещё идёт: питание выполняется после прогона, сначала run end ${run.id}`,
    )
  }

  const reportPath = reportFile(root, run.id)

  // «не заказано» отвечаем раньше отчёта: иначе подсказка ведёт в два шага —
  // сначала run report, потом всё равно run power --power
  const requested = run.power as PowerAction
  if (requested === 'none') {
    throw new UserError(
      1,
      `у прогона ${run.id} питание не заказано: run power ${run.id} --power hibernate|shutdown`,
    )
  }

  if (!reportPath) {
    throw new UserError(
      1,
      `отчёта прогона ${run.id} нет: питание срабатывает только после отчёта, сначала run report ${run.id}`,
    )
  }

  // отчёт до конца прогона — это бумага без всего, что слилось после: её переписывают
  const writtenAt = reportWrittenAt(reportPath)
  if (writtenAt === null) {
    throw new UserError(
      1,
      `отчёта прогона ${run.id} нет: питание срабатывает только после отчёта, сначала run report ${run.id}`,
    )
  }
  if (reportIsStale(writtenAt, run.endedAt)) {
    throw new UserError(
      1,
      `отчёт прогона ${run.id} старше конца прогона: в нём нет того, что случилось позже, ` +
        `перепишите его — run report ${run.id}`,
    )
  }

  const action = effectivePower(requested, options.hibernateAvailable)

  return {
    run,
    requested,
    action,
    reportPath,
    note:
      action === requested
        ? null
        : 'гибернация недоступна на этой машине: после отчёта выключаюсь',
  }
}

/** Питание, заказанное на конце прогона, ложится в ту же запись. */
export function setRunPower(
  db: DatabaseSync,
  input: { runId: string; power: RunPower; actor?: string },
): RunRecord {
  const power = runPowerOf(input.power)

  const run = getRunRecord(db, input.runId)
  if (!run) throw new UserError(3, `прогон ${input.runId} не найден`)

  if (run.power !== power) {
    db.prepare('update runs set power = ? where id = ?').run(power, run.id)
    appendEvent(db, {
      type: 'run.power',
      actor: input.actor ?? 'owner',
      subject: run.id,
      before: { power: run.power },
      after: { power },
    })
  }

  return getRunRecord(db, run.id)!
}

/**
 * Заказать питание закрытому прогону: `run power RUN1 --power hibernate`.
 * Открытому прогону заказ не ставится — там сначала run end (питание в нём же),
 * иначе «ой, я ещё тут» превращалось бы в выключение посреди работы.
 * Отчёт здесь не проверяется: заказ — это намерение, исполнение ждёт отчёта.
 */
export function orderRunPower(
  db: DatabaseSync,
  input: { runId: string; power: RunPower; actor?: string },
): RunRecord {
  const power = runPowerOf(input.power)

  const run = getRunRecord(db, input.runId)
  if (!run) throw new UserError(3, `прогон ${input.runId} не найден`)

  if (!run.endedAt) {
    throw new UserError(
      1,
      `прогон ${run.id} ещё идёт: питание заказывается закрытому прогону, ` +
        `сначала run end ${run.id} --power hibernate|shutdown`,
    )
  }

  return setRunPower(db, { runId: run.id, power, actor: input.actor })
}

/** Ждём секунду; отмена будит сразу, чтобы Ctrl+C не ждал конца отсчёта. */
function wait(ms: number, signal?: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve(false)
      return
    }

    const finish = (waited: boolean) => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      resolve(waited)
    }
    const onAbort = () => finish(false)
    const timer = setTimeout(() => finish(true), ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

export interface SchedulePowerInput {
  action: PowerAction
  /** Настоящая команда в CLI, шпион в тестах: реальные shutdown не зовём никогда в тестах. */
  runner: CommandRunner
  /** Сколько секунд отсчитывать перед гибернацией; выключение не ждёт. */
  seconds?: number
  onTick?: (secondsLeft: number) => void
  signal?: AbortSignal
}

/**
 * Выполнить питание. Гибернация сначала отсчитывает seconds (по умолчанию 90)
 * и уважает отмену; выключение не ждёт и не отменяется.
 */
export async function schedulePower(input: SchedulePowerInput): Promise<PowerOutcome> {
  if (input.action === 'none') return 'none'

  if (input.action === 'hibernate') {
    const seconds = Math.max(0, Math.trunc(input.seconds ?? HIBERNATE_COUNTDOWN_SECONDS))

    for (let left = seconds; left > 0; left--) {
      input.onTick?.(left)
      const ticked = await wait(1000, input.signal)
      if (!ticked) return 'cancelled'
    }
  }

  const command = POWER_COMMANDS[input.action]
  input.runner(command.command, [...command.args])
  return input.action
}
