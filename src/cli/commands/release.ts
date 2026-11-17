import { findProject } from '../../core/project.ts'
import { openDb } from '../../core/db.ts'
import { deferredInRelease, pendingRelease, release, suggestLevel, type ReleaseLevel } from '../../core/git/release.ts'
import { boolFlag, stringFlag, type ParsedArgs } from '../args.ts'
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
  // dry-run — это отчёт о том, что войдёт в релиз: ничего не пишет и не мержит
  const dryRun = boolFlag(args, 'dry-run')

  if (!requested || dryRun) {
    const suggestion = suggestLevel(db, project.root)
    if (!suggestion) {
      ok({ suggestion: null }, 'нет слитых этапов с прошлого релиза: релизить нечего')
      return 1
    }

    const pending = pendingRelease(db)
    const deferred = deferredInRelease(db)
    const changes = pending.map((stage) => `  ${stage.featureId}  ${stage.featureName} — ${stage.stageName}`)
    const level: ReleaseLevel = words.includes(requested as ReleaseLevel)
      ? (requested as ReleaseLevel)
      : suggestion.level
    const reason =
      level === 'minor'
        ? `есть новые возможности: ${suggestion.features} задач`
        : `только исправления: ${suggestion.fixes} задач`

    ok(
      { suggestion, pending, deferred },
      [
        `после v${suggestion.version}: задач ${suggestion.tasks}, из них новых возможностей ${suggestion.features}, дефектов и инцидентов ${suggestion.fixes}`,
        `предлагаю: ${level} — ${reason}`,
        '',
        'ИЗМЕНЕНИЯ РЕЛИЗА',
        ...changes,
        ...(deferred.length === 0
          ? []
          : [
              '',
              'НЕ ВОШЛО, ЖДЁТ РЕШЕНИЯ',
              ...deferred.map((task) => `  ${task.id}  ${task.reason ?? 'без причины'}`),
            ]),
        '',
        'РЕВЬЮ (смотрит только эти изменения):',
        `  1. тот же агент-оркестратор — дешевле, точность ниже: release ${level} --reason "почему" --review same`,
        `  2. свежий агент — дороже, точнее:                    release ${level} --reason "почему" --review fresh`,
        `  3. без ревью:                                        release ${level} --reason "почему" --review none`,
        '',
        'ПОСЛЕ РЕВЬЮ:',
        '  критические находки — исправить до релиза (или владелец явно откладывает)',
        '  остальные — записать запросом: request add "Ревью релиза: замечания"',
        '  затем слияние: release ' + level + ' --reason "…" --review …',
      ].join('\n'),
    )
    return 0
  }

  const level = requested as ReleaseLevel
  if (!words.includes(level)) {
    throw new UserError(3, 'использование: release major|minor|patch --reason "почему" --review same|fresh|none')
  }

  const reason = stringFlag(args, 'reason')
  if (!reason?.trim()) {
    throw new UserError(3, `нужна причина уровня: release ${level} --reason "почему именно так"`)
  }

  const review = stringFlag(args, 'review')
  if (!review) {
    throw new UserError(
      3,
      `выберите ревью перед релизом: --review same (тот же агент), fresh (свежий агент) или none (без ревью)`,
    )
  }
  if (!['same', 'fresh', 'none'].includes(review)) {
    throw new UserError(3, `неизвестный вариант ревью ${review}: same, fresh или none`)
  }

  const result = release(db, {
    root: project.root,
    level,
    reason: reason.trim(),
    review: review as 'same' | 'fresh' | 'none',
    config: project.config,
    actor: 'owner',
  })
  ok(result, result.released ? `${result.tag}\n\n${result.changelog}` : `релиза нет: ${result.reason}`)
  return result.released ? 0 : 1
}


