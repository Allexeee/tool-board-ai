import { findProject } from '../../core/project.ts'
import { openDb } from '../../core/db.ts'
import { nowData, renderNow, type NowFilters, type NowViewKind } from '../../core/now.ts'
import type { CardPhase, CardStatus } from '../../core/types.ts'
import { boolFlag, numberFlag, stringFlag, stringsFlag, type ParsedArgs } from '../args.ts'
import { UserError } from '../errors.ts'
import { colorEnabled, ok } from '../output.ts'

export default async function command(args: ParsedArgs) {
  const project = findProject(process.cwd())
  if (!project) throw new UserError(3, 'проект не найден: выполните board init')
  const db = openDb(project.dbPath)

  try {
    const view = parseView(args.positionals[0])
    const executorId = stringFlag(args, 'as') ?? 'owner'
    const filters = parseFilters(args)

    const data = nowData(db, { view, executorId, filters, root: project.root })
    ok(data, renderNow(data, { color: colorEnabled() }))
    return 0
  } finally {
    db.close()
  }
}

/** `board now [0|1|2|3]`; без номера — вкладка 0 (задачи владельца). */
function parseView(raw: string | undefined): NowViewKind {
  if (raw === undefined) return 0
  if (raw === '0' || raw === '1' || raw === '2' || raw === '3') {
    return Number(raw) as NowViewKind
  }
  throw new UserError(3, `вкладка now — 0, 1, 2 или 3, а не «${raw}»`)
}

function parseFilters(args: ParsedArgs): NowFilters {
  const filters: NowFilters = {}

  const group = stringFlag(args, 'group')
  if (group !== undefined) filters.group = group

  const skill = stringFlag(args, 'skill')
  if (skill !== undefined) filters.skill = skill

  const statuses = splitFlag(args, 'status')
  if (statuses.length > 0) filters.status = statuses as CardStatus[]

  const phase = stringFlag(args, 'phase')
  if (phase !== undefined) filters.phase = parsePhase(phase)

  if (boolFlag(args, 'mine')) filters.mine = true

  const limit = numberFlag(args, 'limit')
  if (limit !== undefined) {
    if (limit < 0) throw new UserError(3, '--limit — целое число от 0')
    filters.limit = limit
  }

  if (boolFlag(args, 'all')) filters.all = true

  return filters
}

function parsePhase(raw: string): CardPhase {
  if (raw === 'request' || raw === 'task') return raw
  throw new UserError(3, `--phase — request или task, а не «${raw}»`)
}

function splitFlag(args: ParsedArgs, name: string): string[] {
  return stringsFlag(args, name)
    .flatMap((value) => value.split(','))
    .map((value) => value.trim())
    .filter(Boolean)
}
