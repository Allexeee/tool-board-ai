import { writeReviewerAgent } from '../../core/opencode.ts'
import { findProject } from '../../core/project.ts'
import { effectiveReviewerModel, modelContext } from '../../core/review-policy.ts'
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
  const lines = [
    `Ревью spec: ${settings.specReview.mode} (порог max: ${settings.specReview.maxSpecChars}, остальные: ${settings.specReview.largeSpecChars} символов)`,
    `Ветки: ${settings.branches.main ?? 'авто'} / ${settings.branches.dev ?? 'авто'}`,
    `Ревью в конце забега: ${settings.runReview.mode}`,
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
  const reviewerModel = stringFlag(args, 'reviewer-model')

  if (runMode !== undefined && (reviewAfterRun || noReviewAfterRun)) {
    throw new UserError(3, 'не сочетайте --run-review с устаревшими --review-after-run/--no-review-after-run')
  }
  if (show && (specMode !== undefined || runMode !== undefined || largeSpec !== undefined || maxSpec !== undefined || branchMain !== undefined || branchDev !== undefined || reviewerModel !== undefined || reviewAfterRun || noReviewAfterRun)) {
    throw new UserError(3, '--show не сочетается с изменением настроек')
  }

  if (show || (!specMode && runMode === undefined && largeSpec === undefined && maxSpec === undefined && branchMain === undefined && branchDev === undefined && reviewerModel === undefined && !reviewAfterRun && !noReviewAfterRun && isJsonMode())) {
    ok({ ...current, effectiveReviewerModel: currentReviewer }, human(current, currentReviewer))
    return 0
  }

  const patch: Parameters<typeof updateSettings>[1] = {}
  if (reviewerModel !== undefined) patch.reviewer = { model: reviewerModel }
  if (specMode !== undefined) patch.specReview = { mode: specMode as SpecReviewSetting }
  if (largeSpec !== undefined) {
    patch.specReview = { ...patch.specReview, largeSpecChars: largeSpec }
  }
  if (maxSpec !== undefined) {
    patch.specReview = { ...patch.specReview, maxSpecChars: maxSpec }
  }
  if (branchMain !== undefined) patch.branches = { ...patch.branches, main: branchMain }
  if (branchDev !== undefined) patch.branches = { ...patch.branches, dev: branchDev }
  if (runMode !== undefined) patch.runReview = { mode: runMode as RunReviewSetting }
  if (reviewAfterRun) patch.runReview = { mode: 'subagent' }
  if (noReviewAfterRun) patch.runReview = { mode: 'none' }

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
