import { openDb } from '../../core/db.ts'
import { listGroups } from '../../core/groups.ts'
import { findProject } from '../../core/project.ts'
import type { ParsedArgs } from '../args.ts'
import { UserError } from '../errors.ts'
import { ok } from '../output.ts'

const USAGE = 'board group list'

export default async function command(args: ParsedArgs) {
  const project = findProject(process.cwd())
  if (!project) throw new UserError(3, 'проект не найден: выполните board init')
  if (args.sub !== null && args.sub !== 'list') throw new UserError(3, USAGE)

  const db = openDb(project.dbPath, { allowOutdated: true, allowNewer: true })
  try {
    const groups = listGroups(db)
    const human =
      groups.length === 0
        ? 'префиксов нет: первый card add без --group возьмёт CARD'
        : groups
            .map((group) => `${group.prefix.padEnd(8)} ${String(group.count).padStart(4)}  ${group.name ?? ''}`.trimEnd())
            .join('\n')
    ok(groups, human)
    return 0
  } finally {
    db.close()
  }
}
