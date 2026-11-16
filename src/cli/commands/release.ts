import { findProject } from '../../core/project.ts'
import { openDb } from '../../core/db.ts'
import { release, type ReleaseLevel } from '../../core/git/release.ts'
import { stringFlag, type ParsedArgs } from '../args.ts'
import { ok } from '../output.ts'
import { UserError } from '../errors.ts'

export default async function command(args: ParsedArgs) {
  const project = findProject(process.cwd())
  if (!project) throw new UserError(3, 'проект не найден: выполните toolbox-al init')
  const db = openDb(project.dbPath)

  const level = (args.positionals[0] ?? stringFlag(args, 'kind') ?? 'patch') as ReleaseLevel
  if (!['major', 'minor', 'patch'].includes(level)) {
    throw new UserError(3, 'использование: release major|minor|patch')
  }

  const result = release(db, { root: project.root, level, config: project.config, actor: 'owner' })
  ok(result, result.released ? `${result.tag}\n\n${result.changelog}` : `релиза нет: ${result.reason}`)
  return result.released ? 0 : 1
}
