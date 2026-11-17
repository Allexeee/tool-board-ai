import { findProject } from '../../core/project.ts'
import { openDb } from '../../core/db.ts'
import { pendingRelease, release, suggestLevel, type ReleaseLevel } from '../../core/git/release.ts'
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

  const words = ['major', 'minor', 'patch'] as const
  const requested = args.sub ?? (args.positionals[0] ?? stringFlag(args, 'kind'))

  if (!requested) {
    const suggestion = suggestLevel(db, project.root)
    if (!suggestion) {
      ok({ suggestion: null }, 'нет слитых этапов с прошлого релиза: релизить нечего')
      return 1
    }

    const reason =
      suggestion.level === 'minor'
        ? `есть новые возможности: ${suggestion.features} задач`
        : `только исправления: ${suggestion.fixes} задач`

    ok(
      { suggestion },
      [
        `после v${suggestion.version}: задач ${suggestion.tasks}, из них новых возможностей ${suggestion.features}, дефектов и инцидентов ${suggestion.fixes}`,
        `предлагаю: ${suggestion.level} — ${reason}`,
        '',
        `подтвердите уровень: release ${suggestion.level} --reason "почему"`,
      ].join('\n'),
    )
    return 0
  }

  const level = requested as ReleaseLevel
  if (!words.includes(level)) {
    throw new UserError(3, 'использование: release major|minor|patch --reason "почему"')
  }

  const reason = stringFlag(args, 'reason')
  if (!reason?.trim()) {
    throw new UserError(3, `нужна причина уровня: release ${level} --reason "почему именно так"`)
  }

  const result = release(db, {
    root: project.root,
    level,
    reason: reason.trim(),
    config: project.config,
    actor: 'owner',
  })
  ok(result, result.released ? `${result.tag}\n\n${result.changelog}` : `релиза нет: ${result.reason}`)
  return result.released ? 0 : 1
}


