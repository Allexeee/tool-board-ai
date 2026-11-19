import { initProject } from '../../core/project.ts'
import { ensureSettings, type BoardSettings } from '../../core/settings.ts'
import { runSetupWizard } from '../setup-wizard.ts'
import { boolFlag, type ParsedArgs } from '../args.ts'
import { ok, isJsonMode } from '../output.ts'

export default async function command(args: ParsedArgs) {
  const dir = args.positionals[0] ?? process.cwd()
  const { created, root } = initProject(dir)

  let settings: BoardSettings = ensureSettings(root).settings
  if (settings.setupAt === null && !isJsonMode() && !boolFlag(args, 'yes') && process.stdin.isTTY) {
    settings = await runSetupWizard(root, settings)
  }

  const lines =
    created.length > 0
      ? ['Создано:', ...created.map((path) => '  ' + path)]
      : ['Доска уже настроена, ничего не менялось.']
  lines.push(
    '',
    'Ревью после каждого забега: ' + (settings.reviewAfterRun ? 'включено' : 'выключено'),
  )
  if (settings.setupAt === null) {
    lines.push('Мастер настроек: запустите board setup (или /setup в OpenCode)')
  }
  lines.push('', 'Проект: ' + root)

  ok({ root, created, settings }, lines.join('\n'))
  return 0
}
