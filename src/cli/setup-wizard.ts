import { createInterface } from 'node:readline/promises'
import { stdin, stdout } from 'node:process'
import { updateSettings, type BoardSettings } from '../core/settings.ts'

function parseAnswer(raw: string, current: boolean): boolean {
  const text = raw.trim().toLowerCase()
  if (text === '') return current
  if (['y', 'yes', 'д', 'да'].includes(text)) return true
  if (['n', 'no', 'н', 'нет'].includes(text)) return false
  return current
}

/**
 * Интерактивный мастер настроек. Один вопрос — ревью после каждого забега.
 * В не-TTY (агент, пайп) ничего не спрашивает и возвращает текущие настройки;
 * агент использует `board setup --review-after-run|--no-review-after-run`.
 */
export async function runSetupWizard(root: string, current: BoardSettings): Promise<BoardSettings> {
  if (!stdin.isTTY) return current

  const rl = createInterface({ input: stdin, output: stdout })
  try {
    const hint = current.reviewAfterRun ? 'Y/n' : 'y/N'
    const answer = await rl.question(`Ревью после каждого забега? [${hint}] `)
    return updateSettings(root, { reviewAfterRun: parseAnswer(answer, current.reviewAfterRun) })
  } finally {
    rl.close()
  }
}
