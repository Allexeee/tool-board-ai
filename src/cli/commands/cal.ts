import { findProject } from '../../core/project.ts'
import { openDb } from '../../core/db.ts'
import { cal } from '../../core/calendar.ts'
import { stringFlag, type ParsedArgs } from '../args.ts'
import { ok } from '../output.ts'
import { UserError } from '../errors.ts'

export default async function command(args: ParsedArgs) {
  const project = findProject(process.cwd())
  if (!project) throw new UserError(3, 'проект не найден: выполните toolbox-al init')
  const db = openDb(project.dbPath)

  const days = Number(stringFlag(args, 'days') ?? 7)
  const items = cal(db, { days })

  ok(
    items,
    items.length === 0
      ? 'на этот период ничего нет'
      : items
          .map((item) => {
            const at = new Date(item.at)
            const stamp = `${String(at.getDate()).padStart(2, '0')}.${String(at.getMonth() + 1).padStart(2, '0')} ${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`
            return `${stamp}  ${item.kind.padEnd(8)} ${item.title}${item.detail ? '  ' + item.detail : ''}`
          })
          .join('\n'),
  )
  return 0
}
