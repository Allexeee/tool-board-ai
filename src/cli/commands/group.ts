import { openDb } from '../../core/db.ts'
import { addGroup, listGroups } from '../../core/groups.ts'
import { findProject } from '../../core/project.ts'
import { stringFlag, type ParsedArgs } from '../args.ts'
import { UserError } from '../errors.ts'
import { ok } from '../output.ts'

const USAGE = 'board group list | board group add <PREFIX> [--name <название>] [--as <id>]'

export default async function command(args: ParsedArgs) {
  const project = findProject(process.cwd())
  if (!project) throw new UserError(3, 'проект не найден: выполните board init')
  if (args.sub !== null && args.sub !== 'list' && args.sub !== 'add') {
    throw new UserError(3, USAGE)
  }

  const db = openDb(project.dbPath, { allowOutdated: true, allowNewer: true })
  try {
    if (args.sub === 'add') {
      const prefix = args.positionals[0]
      if (!prefix) throw new UserError(3, USAGE)
      const group = addGroup(db, {
        prefix,
        name: stringFlag(args, 'name'),
        actor: stringFlag(args, 'as') ?? 'owner',
      })
      ok(group, `${group.prefix} добавлен${group.name ? ': ' + group.name : ''}`)
      return 0
    }

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
