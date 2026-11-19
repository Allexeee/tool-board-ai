import { findProject } from '../../core/project.ts'
import { readSettings, updateSettings, type BoardSettings } from '../../core/settings.ts'
import { runSetupWizard } from '../setup-wizard.ts'
import { boolFlag, type ParsedArgs } from '../args.ts'
import { UserError } from '../errors.ts'
import { isJsonMode, ok } from '../output.ts'

function human(settings: BoardSettings): string {
  const lines = [
    `Ревью после каждого забега: ${settings.reviewAfterRun ? 'включено' : 'выключено'}`,
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
  const reviewOn = boolFlag(args, 'review-after-run')
  const reviewOff = boolFlag(args, 'no-review-after-run')
  if (reviewOn && reviewOff) {
    throw new UserError(3, 'укажите только один флаг: --review-after-run или --no-review-after-run')
  }

  const show = boolFlag(args, 'show')
  if (show && (reviewOn || reviewOff)) {
    throw new UserError(3, '--show не сочетается с переключением настройки')
  }
  if (show || (!reviewOn && !reviewOff && isJsonMode())) {
    ok(current, human(current))
    return 0
  }

  if (reviewOn || reviewOff) {
    const next = updateSettings(project.root, { reviewAfterRun: reviewOn })
    ok(next, human(next))
    return 0
  }

  if (!process.stdin.isTTY) {
    const lines = [human(current), '', 'Запустите в терминале: board setup']
    ok(current, lines.join('\n'))
    return 0
  }

  const next = await runSetupWizard(project.root, current)
  ok(next, human(next))
  return 0
}
