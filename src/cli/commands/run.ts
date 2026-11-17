import { findProject } from '../../core/project.ts'
import { openDb } from '../../core/db.ts'
import { activeRun, lastClosedRun, startRun, type RunPower, type RunRecord } from '../../core/runs.ts'
import { boolFlag, listFlag, stringFlag, type ParsedArgs } from '../args.ts'
import { ok } from '../output.ts'
import { UserError } from '../errors.ts'

const MODE_LABEL = { plan: 'по плану', all: 'доталово' } as const
const POWER_LABEL = { none: 'не трогать', hibernate: 'гибернация', shutdown: 'выключение' } as const

const USAGE =
  'использование: run start --mode plan|all [--request R1 …] [--nearest] [--approve] ' +
  '[--power none|hibernate|shutdown] · run show'

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

  if (args.sub === 'show' || args.sub === null) {
    const active = activeRun(db)
    const lastClosed = lastClosedRun(db)

    const lines: string[] = []
    if (active) lines.push(`${active.id}  идёт с ${stamp(active.startedAt)}  ${describe(active)}`)
    if (lastClosed) {
      const reason = lastClosed.endReason ? `  причина: ${lastClosed.endReason}` : ''
      lines.push(`${lastClosed.id}  закрыт ${stamp(lastClosed.endedAt ?? lastClosed.startedAt)}  ${describe(lastClosed)}${reason}`)
    }

    ok(
      { active, lastClosed },
      lines.length > 0 ? lines.join('\n') : 'прогонов ещё не было',
    )
    return 0
  }

  throw new UserError(3, USAGE)
}
