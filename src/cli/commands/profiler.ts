import { relative } from 'node:path'
import { findProject } from '../../core/project.ts'
import { openDb } from '../../core/db.ts'
import { endProfile, renderProfile, startProfile } from '../../core/profiler.ts'
import { stringFlag, type ParsedArgs } from '../args.ts'
import { ok } from '../output.ts'
import { UserError } from '../errors.ts'

const USAGE =
  'использование: profiler start [--label "2 агента"] · profiler end\n' +
  'метка нужна, чтобы сравнивать замеры: «1 агент», «2 агента», «3 агента»'

function stamp(iso: string): string {
  const at = new Date(iso)
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${pad(at.getDate())}.${pad(at.getMonth() + 1)} ${pad(at.getHours())}:${pad(at.getMinutes())}`
}

export default async function command(args: ParsedArgs) {
  const project = findProject(process.cwd())
  if (!project) throw new UserError(3, 'проект не найден: выполните toolbox-al init')

  // Подкоманда приходит args.sub, когда profiler внесён в COMMANDS_WITH_SUB, а
  // до этого — первым позиционным аргументом. Метка тоже: --label, а если флаг
  // ещё не объявлен в args.ts — вторым позиционным аргументом.
  const sub = args.sub ?? args.positionals[0] ?? null
  const rest = args.sub ? args.positionals : args.positionals.slice(1)

  if (sub === 'start') {
    const db = openDb(project.dbPath)
    const marker = startProfile(db, {
      root: project.root,
      label: stringFlag(args, 'label') ?? rest[0],
    })

    const shown = relative(process.cwd(), marker.path).replace(/\\/g, '/')
    const run = marker.run ? `прогон ${marker.run}` : 'прогона нет'
    const executors =
      marker.executors.length > 0
        ? `исполнители: ${marker.executors.map((executor) => executor.id).join(', ')}`
        : 'исполнителей нет'

    ok(
      { ...marker, path: shown },
      `замер «${marker.label}» начат ${stamp(marker.startedAt)} · ${run} · ${executors}\nмаркер: ${shown}`,
    )
    return 0
  }

  if (sub === 'end') {
    const end = endProfile({ root: project.root })
    ok(end, renderProfile(end))
    // нет базы — это не «нули»: отчёт напечатан, но считать нечего
    return end.available ? 0 : 1
  }

  throw new UserError(3, USAGE)
}
