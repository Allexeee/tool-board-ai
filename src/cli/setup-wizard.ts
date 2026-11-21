import { createInterface } from 'node:readline/promises'
import { stdin, stdout } from 'node:process'
import { updateSettings, type BoardSettings } from '../core/settings.ts'

type TtyInput = NodeJS.ReadableStream & { isTTY?: boolean }
type TtyOutput = NodeJS.WritableStream & { isTTY?: boolean }

export interface SetupWizardIO {
  input?: TtyInput
  output?: TtyOutput
}

export interface SetupDecision {
  settings: BoardSettings
  json: boolean
  yes: boolean
  stdinIsTTY: boolean
  stdoutIsTTY: boolean
}

/** Мастер запускается только один раз после установки и только в живом терминале. */
export function shouldRunSetup(input: SetupDecision): boolean {
  return (
    input.settings.setupAt === null &&
    !input.json &&
    !input.yes &&
    input.stdinIsTTY &&
    input.stdoutIsTTY
  )
}

function parseAnswer(raw: string, current: boolean): boolean | undefined {
  const text = raw.trim().toLowerCase()
  if (text === '') return current
  if (['y', 'yes', 'д', 'да'].includes(text)) return true
  if (['n', 'no', 'н', 'нет'].includes(text)) return false
  return undefined
}

/**
 * Интерактивный мастер настроек. Один вопрос — ревью после каждого забега.
 * В не-TTY (агент, пайп) ничего не спрашивает и возвращает текущие настройки;
 * агент использует `board setup --review-after-run|--no-review-after-run`.
 * Потоки можно подменить в тестах.
 */
export async function runSetupWizard(
  root: string,
  current: BoardSettings,
  io: SetupWizardIO = {},
): Promise<BoardSettings> {
  const input = io.input ?? stdin
  const output = io.output ?? stdout
  if (!input.isTTY || !output.isTTY) return current

  const rl = createInterface({ input, output })
  try {
    for (;;) {
      const hint = current.reviewAfterRun ? 'Y/n' : 'y/N'
      const answer = await rl.question(`Ревью после каждого забега? [${hint}] `)
      const next = parseAnswer(answer, current.reviewAfterRun)
      if (next !== undefined) return updateSettings(root, { reviewAfterRun: next })
      output.write('Ответьте y/yes/д/да или n/no/н/нет.\n')
    }
  } finally {
    rl.close()
  }
}
