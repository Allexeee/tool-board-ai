import { writeReviewerAgent } from '../../core/opencode.ts'
import { openDb } from '../../core/db.ts'
import { findProject } from '../../core/project.ts'
import { effectiveReviewerModel, modelContext, resolveReviewProfile } from '../../core/review-policy.ts'
import { applySetupDefaults } from '../../core/setup.ts'
import {
  readSettings,
  updateSettings,
  type BoardSettings,
  type RunReviewSetting,
  type SpecReviewSetting,
} from '../../core/settings.ts'
import { runSetupWizard } from '../setup-wizard.ts'
import { boolFlag, numberFlag, stringFlag, type ParsedArgs } from '../args.ts'
import { UserError } from '../errors.ts'
import { isJsonMode, ok } from '../output.ts'

function human(settings: BoardSettings, effectiveModel: string | null): string {
  const { name, profile } = resolveReviewProfile(settings, modelContext(process.env))
  const review =
    name === 'custom'
      ? [
          'Профиль ревью: custom (старые настройки)',
          `Ревью spec: ${settings.specReview.mode}`,
          `Порог max: ${settings.specReview.maxSpecChars} символов`,
          `Порог остальных: ${settings.specReview.largeSpecChars} символов`,
          `Ревью в конце забега: ${settings.runReview.mode}`,
        ]
      : [
          `Профиль ревью: ${settings.review.profile === 'auto' ? `auto → ${name}` : name}`,
          `Ревью spec: ${profile.spec}${
            profile.spec === 'auto' ? `, порог ${profile.specWords} слов` : ''
          }`,
          `Ревью в конце забега: ${profile.run}`,
          `Реревью: ${profile.reopens}`,
          `Находки: ${profile.findings === 'critical+important' ? 'critical + important' : 'critical'}`,
          `Пакет ревью: ${profile.package ? 'требуется' : 'не требуется'}`,
        ]
  const lines = [
    ...review,
    `Ветки: ${settings.branches.main ?? 'авто'} / ${settings.branches.dev ?? 'авто'}`,
    `Синхронизация базы: ${settings.sync.remote ?? 'не настроена'}`,
    `Бэклог: ${settings.backlog.path}${settings.backlog.auto ? ' (авто)' : ''}${
      settings.backlog.refreshSeconds > 0
        ? `, обновление ${settings.backlog.refreshSeconds} с`
        : ', без автообновления'
    }`,
    `Модель ревьюера: ${effectiveModel ?? 'не задана'} (default-вариант)`,
    settings.setupAt
      ? `Мастер настроек: ${settings.setupAt}`
      : 'Мастер настроек ещё не запускался',
  ]
  return lines.join('\n')
}

export default async function command(args: ParsedArgs) {
  const project = findProject(process.cwd())
  if (!project) throw new UserError(3, 'проект не найден: выполните board init')

  const current = readSettings(project.root)
  const context = modelContext(process.env)
  const currentReviewer = effectiveReviewerModel(current, context)
  const show = boolFlag(args, 'show')
  const defaults = boolFlag(args, 'defaults')

  const reviewAfterRun = boolFlag(args, 'review-after-run')
  const noReviewAfterRun = boolFlag(args, 'no-review-after-run')
  if (reviewAfterRun && noReviewAfterRun) {
    throw new UserError(3, 'укажите только один флаг: --review-after-run или --no-review-after-run')
  }

  const specMode = stringFlag(args, 'spec-review')
  const runMode = stringFlag(args, 'run-review')
  const largeSpec = numberFlag(args, 'large-spec')
  const maxSpec = numberFlag(args, 'max-spec')
  const branchMain = stringFlag(args, 'branch-main')
  const branchDev = stringFlag(args, 'branch-dev')
  const syncRemote = stringFlag(args, 'sync')
  const backlogPath = stringFlag(args, 'backlog-path')
  const backlogRefresh = numberFlag(args, 'backlog-refresh')
  const backlogAuto = boolFlag(args, 'backlog-auto')
  const noBacklogAuto = boolFlag(args, 'no-backlog-auto')
  const reviewerModel = stringFlag(args, 'reviewer-model')
  const profile = stringFlag(args, 'profile')

  if (runMode !== undefined && (reviewAfterRun || noReviewAfterRun)) {
    throw new UserError(3, 'не сочетайте --run-review с устаревшими --review-after-run/--no-review-after-run')
  }

  const changes =
    specMode !== undefined ||
    runMode !== undefined ||
    largeSpec !== undefined ||
    maxSpec !== undefined ||
    branchMain !== undefined ||
    branchDev !== undefined ||
    syncRemote !== undefined ||
    backlogPath !== undefined ||
    backlogRefresh !== undefined ||
    backlogAuto ||
    noBacklogAuto ||
    reviewerModel !== undefined ||
    profile !== undefined ||
    reviewAfterRun ||
    noReviewAfterRun

  if (defaults && (show || changes)) {
    throw new UserError(3, '--defaults не сочетается с другими флагами')
  }
  if (defaults) {
    const db = openDb(project.dbPath, { allowOutdated: true, allowNewer: true })
    try {
      const result = applySetupDefaults(db, project.root)
      const effective = effectiveReviewerModel(result.settings, context)
      const lines = [
        'Умолчания применены:',
        `  бэклог: ${result.path ?? result.settings.backlog.path}${
          result.error ? ` (ошибка пересборки: ${result.error})` : ''
        }`,
        `  исполнитель developer: ${result.executorCreated ? 'создан' : 'уже был'}`,
        `  ревью spec: ${result.settings.specReview.mode}, ревью забега: ${result.settings.runReview.mode}`,
        `  модель ревьюера: ${effective ?? 'не задана'}`,
      ]
      ok({ ...result, effectiveReviewerModel: effective }, lines.join('\n'))
      return 0
    } finally {
      db.close()
    }
  }

  if (show && changes) {
    throw new UserError(3, '--show не сочетается с изменением настроек')
  }

  if (show || (!changes && isJsonMode())) {
    ok({ ...current, effectiveReviewerModel: currentReviewer }, human(current, currentReviewer))
    return 0
  }

  const patch: Parameters<typeof updateSettings>[1] = {}
  if (reviewerModel !== undefined) patch.reviewer = { model: reviewerModel }
  if (profile !== undefined) patch.review = { profile }
  if (specMode !== undefined) patch.specReview = { mode: specMode as SpecReviewSetting }
  if (largeSpec !== undefined) {
    patch.specReview = { ...patch.specReview, largeSpecChars: largeSpec }
  }
  if (maxSpec !== undefined) {
    patch.specReview = { ...patch.specReview, maxSpecChars: maxSpec }
  }
  if (branchMain !== undefined) patch.branches = { ...patch.branches, main: branchMain }
  if (branchDev !== undefined) patch.branches = { ...patch.branches, dev: branchDev }
  if (syncRemote !== undefined) patch.sync = { remote: syncRemote }
  if (backlogPath !== undefined) patch.backlog = { ...patch.backlog, path: backlogPath }
  if (backlogRefresh !== undefined) {
    patch.backlog = { ...patch.backlog, refreshSeconds: backlogRefresh }
  }
  if (backlogAuto || noBacklogAuto) {
    patch.backlog = { ...patch.backlog, auto: backlogAuto }
  }
  if (runMode !== undefined) patch.runReview = { mode: runMode as RunReviewSetting }
  if (reviewAfterRun) patch.runReview = { mode: 'subagent' }
  if (noReviewAfterRun) patch.runReview = { mode: 'none' }

  // Старые отдельные флаги ревью переключают проект на custom-профиль.
  if (
    profile === undefined &&
    (specMode !== undefined ||
      runMode !== undefined ||
      largeSpec !== undefined ||
      maxSpec !== undefined ||
      reviewAfterRun ||
      noReviewAfterRun)
  ) {
    patch.review = { profile: 'custom' }
  }

  if (Object.keys(patch).length > 0) {
    const next = updateSettings(project.root, patch)
    writeReviewerAgent(project.root, next, true)
    const effective = effectiveReviewerModel(next, context)
    ok({ ...next, effectiveReviewerModel: effective }, human(next, effective))
    return 0
  }

  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    const lines = [human(current, currentReviewer), '', 'Запустите в терминале: board setup']
    ok({ ...current, effectiveReviewerModel: currentReviewer }, lines.join('\n'))
    return 0
  }

  const next = await runSetupWizard(project.root, current)
  writeReviewerAgent(project.root, next, true)
  const effective = effectiveReviewerModel(next, context)
  ok({ ...next, effectiveReviewerModel: effective }, human(next, effective))
  return 0
}
