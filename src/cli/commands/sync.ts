import { openDb } from '../../core/db.ts'
import { findProject } from '../../core/project.ts'
import { readSettings } from '../../core/settings.ts'
import { syncPull, syncPush } from '../../core/sync.ts'
import type { ParsedArgs } from '../args.ts'
import { UserError } from '../errors.ts'
import { ok } from '../output.ts'

const USAGE = 'board sync push|pull'

export default async function command(args: ParsedArgs) {
  const project = findProject(process.cwd())
  if (!project) throw new UserError(3, 'проект не найден: выполните board init')
  const action = args.sub
  if (action !== 'push' && action !== 'pull') throw new UserError(3, USAGE)

  const remote = readSettings(project.root).sync.remote

  if (action === 'pull') {
    const result = syncPull(project.root, project.dbPath, remote)
    ok({ ...result }, `база обновлена${result.backup ? `, копия: ${result.backup}` : ''}`)
    return 0
  }

  // checkpoint WAL: копируем согласованный файл, а не базу с открытым журналом.
  const db = openDb(project.dbPath, { allowOutdated: true, allowNewer: true })
  try {
    db.exec('pragma wal_checkpoint(truncate)')
  } finally {
    db.close()
  }

  const result = syncPush(project.root, project.dbPath, remote)
  ok(result, result.changed ? `база отправлена в ${project.root}` : 'без изменений')
  return 0
}
