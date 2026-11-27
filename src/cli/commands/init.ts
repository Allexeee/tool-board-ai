import { writeReviewerAgent } from '../../core/opencode.ts'
import { openDb } from '../../core/db.ts'
import { join, resolve } from 'node:path'
import { initProject } from '../../core/project.ts'
import { effectiveReviewerModel, modelContext } from '../../core/review-policy.ts'
import { buildSetupProposal, type SetupProposal } from '../../core/setup.ts'
import { ensureSettings, updateSettings, type BoardSettings } from '../../core/settings.ts'
import { SUPERPOWERS_ADVICE, superpowersConfigured } from '../../core/superpowers.ts'
import { runSetupWizard, shouldRunSetup } from '../setup-wizard.ts'
import {
  collectWhatsNew,
  markAnnouncedVersion,
  readAnnouncedVersion,
  whatsNewDir,
  whatsNewLines,
} from '../../core/whats-new.ts'
import { boolFlag, stringFlag, type ParsedArgs } from '../args.ts'
import { ok, isJsonMode } from '../output.ts'

export default async function command(args: ParsedArgs) {
  const dir = args.positionals[0] ?? process.cwd()
  // Читаем отметку до initProject: установка может сразу записать новую версию.
  const announced = readAnnouncedVersion(resolve(dir))
  const { created, updated, warnings, root, boardVersion } = initProject(dir, {
    refresh: boolFlag(args, 'refresh'),
    boardVersion: stringFlag(args, 'board-version'),
    boardSource: stringFlag(args, 'board-source'),
    allowDowngrade: boolFlag(args, 'allow-downgrade'),
    noGit: boolFlag(args, 'no-git') || boolFlag(args, 'standalone'),
  })

  let settings: BoardSettings = ensureSettings(root).settings
  const noGit = boolFlag(args, 'no-git') || boolFlag(args, 'standalone')
  if (noGit && settings.git) {
    settings = updateSettings(root, { git: false })
  }
  if (
    shouldRunSetup({
      settings,
      json: isJsonMode(),
      yes: boolFlag(args, 'yes'),
      stdinIsTTY: Boolean(process.stdin.isTTY),
      stdoutIsTTY: Boolean(process.stdout.isTTY),
    })
  ) {
    settings = await runSetupWizard(root, settings)
    writeReviewerAgent(root, settings, true)
  }

  // Отметку пишет каждый вызов init: upgrade заранее запоминает from и не теряет
  // диапазон, даже если вложенный init уже отметил новую версию.
  const whatsNew = collectWhatsNew(announced, boardVersion, whatsNewDir(root))
  markAnnouncedVersion(root, boardVersion ?? '')

  const lines: string[] = []
  if (created.length > 0) {
    lines.push('Создано:', ...created.map((path) => '  ' + path))
  }
  if (updated.length > 0) {
    lines.push('Обновлено:', ...updated.map((path) => '  ' + path))
  }
  if (lines.length === 0) lines.push('Доска уже настроена, ничего не менялось.')

  const db = openDb(join(root, '.board', 'board.db'), {
    allowOutdated: true,
    allowNewer: true,
  })
  let proposal: SetupProposal | null = null
  let proposalWarning: string | null = null
  try {
    proposal = buildSetupProposal(db, root, settings)
  } catch (error) {
    proposalWarning = `мастер настроек недоступен: база не совместима — ${(error as Error).message}`
  } finally {
    db.close()
  }
  if (proposal) lines.push('', ...proposalLines(proposal))

  const effectiveReviewer = effectiveReviewerModel(settings, modelContext(process.env))
  lines.push(
    '',
    'Ревью spec: ' + settings.specReview.mode,
    'Ревью в конце забега: ' + settings.runReview.mode,
    'Модель ревьюера: ' + (effectiveReviewer ?? 'не задана'),
    'Версия board: ' + (boardVersion ?? 'локальная'),
  )
  if (settings.setupAt === null) {
    lines.push('Мастер настроек ещё не применялся: board setup --defaults')
  }
  const recommendations = [
    ...warnings,
    ...(proposalWarning ? [proposalWarning] : []),
    ...(superpowersConfigured(root) ? [] : [SUPERPOWERS_ADVICE]),
  ]
  if (recommendations.length > 0) {
    lines.push('', ...recommendations.map((item) => '*   ' + item))
  }
  if (boardVersion !== null) lines.push('', ...whatsNewLines(whatsNew))
  lines.push('', 'Проект: ' + root)
  lines.push('Если сессия уже была открыта и доска не появилась, перезагрузите сессию.')

  const setupRequired = settings.setupAt === null
  ok(
    {
      root,
      created,
      updated,
      boardVersion,
      from: whatsNew.from,
      to: whatsNew.to,
      whatsNew: whatsNew.whatsNew,
      settings,
      setupRequired,
      recommendations,
      proposal,
      proposalWarning,
    },
    lines.join('\n'),
  )
  return 0
}

function proposalLines(proposal: SetupProposal): string[] {
  const { defaults, missing, superpowers } = proposal
  const skills = !superpowers.configured
    ? 'superpowers не подключён'
    : superpowers.conflictsDisabled
      ? 'конкурирующие навыки выключены'
      : 'конкурирующие навыки не выключены — board init --refresh'
  return [
    'Мастер первичной настройки:',
    `  бэклог: ${defaults.backlog.path} (+ .html), авто ${defaults.backlog.refreshSeconds} с`,
    `  ревью spec: ${defaults.specReview}, ревью забега: ${defaults.runReview}`,
    `  модель ревьюера: ${defaults.reviewer ?? 'не задана'}`,
    `  исполнитель: ${
      missing.executors.length > 0
        ? `добавить ${missing.executors.join(', ')} (агент, dev)`
        : 'developer уже есть'
    }`,
    `  области проекта: ${missing.groups ? 'нет — предложи владельцу 2–4 префикса' : 'уже есть'}`,
    `  ${skills}`,
    'Оставить умолчания: board setup --defaults',
    'Поменять: окно выбора по каждому пункту; области — board group add <PREFIX> --name <название>',
  ]
}
