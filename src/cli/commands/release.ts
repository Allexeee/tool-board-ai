import { findProject } from '../../core/project.ts'
import { openDb } from '../../core/db.ts'
import type { DatabaseSync } from 'node:sqlite'
import { deferredInRelease, deferredInReleased, pendingRelease, release, suggestLevel, type ReleaseLevel } from '../../core/git/release.ts'
import { unreviewedRun } from '../../core/runs.ts'
import { boolFlag, stringFlag, type ParsedArgs } from '../args.ts'
import { ok } from '../output.ts'
import { UserError } from '../errors.ts'

/** «1 этап не проверялся», «2 этапа не проверялись», «5 этапов не проверялись». */
function unreviewedStages(count: number): string {
  const tail = count % 100
  const last = count % 10
  if (last === 1 && tail !== 11) return `${count} этап не проверялся`
  if (last >= 2 && last <= 4 && (tail < 12 || tail > 14)) return `${count} этапа не проверялись`
  return `${count} этапов не проверялись`
}

/**
 * Предупреждение о долге ревью: последний прогон закрыт, ревью требует, а
 * вердикта ok нет. Релиз этим не отменяется — владелец решает сам, — но
 * молчать об этом нельзя: в main поедет непроверенное.
 */
function reviewGapWarning(db: DatabaseSync, pendingCount: number): string | null {
  const gap = unreviewedRun(db)
  if (!gap) return null

  const stages = unreviewedStages(pendingCount)
  if (gap.state === 'found') {
    return (
      `ревью прогона ${gap.run.id} нашло замечания: ${stages} до конца, ` +
      `предлагаю повторить run review ${gap.run.id}`
    )
  }

  return `ревью не было: ${stages}, предлагаю run review ${gap.run.id}`
}

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
    const releasedDeferred = deferredInReleased(db)
    const warning = reviewGapWarning(db, pending.length)
    const changes = pending.map((stage) => `  ${stage.featureId}  ${stage.featureName} — ${stage.stageName}`)
    const level: ReleaseLevel = words.includes(requested as ReleaseLevel)
      ? (requested as ReleaseLevel)
      : suggestion.level
    const reason =
      level === 'minor'
        ? `есть новые возможности: ${suggestion.features} задач`
        : `только исправления: ${suggestion.fixes} задач`

    ok(
      { suggestion, pending, deferred, reviewWarning: warning },
      [
        `после v${suggestion.version}: задач ${suggestion.tasks}, из них новых возможностей ${suggestion.features}, дефектов и инцидентов ${suggestion.fixes}`,
        `предлагаю: ${level} — ${reason}`,
        '',
        'ИЗМЕНЕНИЯ РЕЛИЗА',
        ...changes,
        ...(warning ? ['', 'РЕВЬЮ ПРОГОНА:', `  ${warning}`] : []),
        ...(deferred.length === 0
          ? []
          : [
              '',
              'НЕ ВОШЛО, ЖДЁТ РЕШЕНИЯ',
              ...deferred.map((task) => `  ${task.id}  ${task.reason ?? 'без причины'}`),
            ]),
        ...(releasedDeferred.length === 0
          ? []
          : [
              '',
              'ОТЛОЖЕНО В ПРОШЛЫХ РЕЛИЗАХ',
              ...releasedDeferred.map(
                (task) => `  ${task.id}  ${task.version ? `v${task.version}` : 'без версии'}  ${task.reason ?? 'без причины'}`,
              ),
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

  // предупреждение не отменяет релиз: владелец увидит долг ревью, но решение его
  const warning = reviewGapWarning(db, pendingRelease(db).length)
  if (warning) process.stderr.write(warning + '\n')

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



