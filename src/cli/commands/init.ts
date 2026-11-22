import { writeReviewerAgent } from '../../core/opencode.ts'
import { initProject } from '../../core/project.ts'
import { ensureSettings, type BoardSettings } from '../../core/settings.ts'
import { runSetupWizard, shouldRunSetup } from '../setup-wizard.ts'
import { boolFlag, stringFlag, type ParsedArgs } from '../args.ts'
import { ok, isJsonMode } from '../output.ts'

export default async function command(args: ParsedArgs) {
  const dir = args.positionals[0] ?? process.cwd()
  const { created, updated, root, boardVersion } = initProject(dir, {
    refresh: boolFlag(args, 'refresh'),
    boardVersion: stringFlag(args, 'board-version'),
    boardSource: stringFlag(args, 'board-source'),
    allowDowngrade: boolFlag(args, 'allow-downgrade'),
  })

  let settings: BoardSettings = ensureSettings(root).settings
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

  const lines: string[] = []
  if (created.length > 0) {
    lines.push('Создано:', ...created.map((path) => '  ' + path))
  }
  if (updated.length > 0) {
    lines.push('Обновлено:', ...updated.map((path) => '  ' + path))
  }
  if (lines.length === 0) lines.push('Доска уже настроена, ничего не менялось.')

  lines.push(
    '',
    'Ревью spec: ' + settings.specReview.mode,
    'Ревью в конце забега: ' + settings.runReview.mode,
    'Модель ревьюера: ' + (settings.reviewer.model ?? 'не задана'),
    'Версия board: ' + (boardVersion ?? 'локальная'),
  )
  if (settings.setupAt === null) {
    lines.push('Мастер настроек: запустите board setup (или /setup в OpenCode)')
  }
  lines.push('', 'Проект: ' + root)

  const setupRequired = settings.setupAt === null
  ok({ root, created, updated, boardVersion, settings, setupRequired }, lines.join('\n'))
  return 0
}
