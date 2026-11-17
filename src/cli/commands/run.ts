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
import { boolFlag, listFlag, stringFlag, type ParsedArgs } from '../args.ts'
import { ok } from '../output.ts'
import { UserError } from '../errors.ts'
import { renderRunReport, writeRunReport } from '../../core/run-report.ts'
import { relative } from 'node:path'

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
  '[--power none|hibernate|shutdown] · run end <id> --reason owner|tasks|decision · ' +
  'run review <id> --verdict ok|found [--note "…"] · run report <id> · run show'

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
    if (!id || !reason) {
      throw new UserError(3, 'использование: run end RUN1 --reason owner|tasks|decision')
    }

    const run = endRun(db, {
      id,
      reason: reason as RunEndReason,
      actor: stringFlag(args, 'as') ?? 'owner',
    })

    const state = reviewState(run, reviewOf(db, run.id))
    ok(run, `${run.id}  закрыт · причина: ${reasonText(run)} · ${REVIEW_LABEL[state] ?? ''}`.trim())
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
