import { initProject } from '../../core/project.ts'
import { ensureSettings, type BoardSettings } from '../../core/settings.ts'
import { runSetupWizard, shouldRunSetup } from '../setup-wizard.ts'
import { boolFlag, type ParsedArgs } from '../args.ts'
import { ok, isJsonMode } from '../output.ts'

export default async function command(args: ParsedArgs) {
  const dir = args.positionals[0] ?? process.cwd()
  const { created, updated, root } = initProject(dir, {
    refresh: boolFlag(args, 'refresh'),
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
  )
  if (settings.setupAt === null) {
    lines.push('Мастер настроек: запустите board setup (или /setup в OpenCode)')
  }
  lines.push('', 'Проект: ' + root)

  const setupRequired = settings.setupAt === null
  ok({ root, created, updated, settings, setupRequired }, lines.join('\n'))
  return 0
}
