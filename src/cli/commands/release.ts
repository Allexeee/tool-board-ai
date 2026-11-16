import { findProject } from '../../core/project.ts'
import { openDb } from '../../core/db.ts'
import { release, pendingRelease, type ReleaseLevel } from '../../core/git/release.ts'
import { stringFlag, type ParsedArgs } from '../args.ts'
import { ok } from '../output.ts'
import { UserError } from '../errors.ts'

export default async function command(args: ParsedArgs) {
  const project = findProject(process.cwd())
  if (!project) throw new UserError(3, 'проект не найден: выполните toolbox-al init')
  const db = openDb(project.dbPath)

  if (args.sub === 'pending') {
    const pending = pendingRelease(db)
    if (pending.length === 0) {
      ok(pending, 'нечего релизить')
      return 0
    }

    const lines: string[] = []
    let featureId = ''
    for (const stage of pending) {
      if (stage.featureId !== featureId) {
        featureId = stage.featureId
        lines.push(`${stage.featureId}  ${stage.featureName}`)
      }
      lines.push(`  ${stage.stageId}  ${stage.stageName}`)
    }

    ok(pending, lines.join('\n'))
    return 0
  }

  const level = (args.sub ?? args.positionals[0] ?? stringFlag(args, 'kind') ?? 'patch') as ReleaseLevel
  if (!['major', 'minor', 'patch'].includes(level)) {
    throw new UserError(3, 'использование: release major|minor|patch')
  }

  const result = release(db, { root: project.root, level, config: project.config, actor: 'owner' })
  ok(result, result.released ? `${result.tag}\n\n${result.changelog}` : `релиза нет: ${result.reason}`)
  return result.released ? 0 : 1
}
