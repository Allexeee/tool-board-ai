import { createInterface } from 'node:readline/promises'
import { stdin, stdout } from 'node:process'
import {
  updateSettings,
  validateReviewerModel,
  type BoardSettings,
  type RunReviewSetting,
  type SpecReviewSetting,
} from '../core/settings.ts'

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

function oneOf<T extends string>(raw: string, values: readonly T[]): T | undefined {
  const value = raw.trim().toLowerCase()
  return values.includes(value as T) ? (value as T) : undefined
}

async function ask<T>(
  question: (prompt: string) => Promise<string>,
  output: NodeJS.WritableStream,
  prompt: string,
  invalid: string,
  parse: (answer: string) => T | undefined,
): Promise<T> {
  for (;;) {
    const answer = await question(prompt)
    const parsed = parse(answer)
    if (parsed !== undefined) return parsed
    output.write(invalid + '\n')
  }
}

/**
 * Интерактивный мастер настроек. Пять вопросов: spec review, порог для max,
 * порог большого spec, run review и модель ревьюера. В не-TTY ничего не спрашивает.
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
    const specModes: readonly SpecReviewSetting[] = ['auto', 'none', 'self', 'subagent']
    const runModes: readonly RunReviewSetting[] = ['auto', 'none', 'self', 'subagent']

    const specMode = await ask(
      (prompt) => rl.question(prompt),
      output,
      `Ревью spec [${current.specReview.mode}] (auto|none|self|subagent): `,
      'Допустимо: auto, none, self, subagent.',
      (answer) => (answer.trim() === '' ? current.specReview.mode : oneOf(answer, specModes)),
    )

    const maxSpecChars = await ask(
      (prompt) => rl.question(prompt),
      output,
      `Порог для max, символов [${current.specReview.maxSpecChars}] (0 — выкл.): `,
      'Нужно целое число от 0.',
      (answer) => {
        if (answer.trim() === '') return current.specReview.maxSpecChars
        const value = Number(answer.trim())
        return Number.isInteger(value) && value >= 0 ? value : undefined
      },
    )

    const largeSpecChars = await ask(
      (prompt) => rl.question(prompt),
      output,
      `Большой spec, символов [${current.specReview.largeSpecChars}] (0 — выкл.): `,
      'Нужно целое число от 0.',
      (answer) => {
        if (answer.trim() === '') return current.specReview.largeSpecChars
        const value = Number(answer.trim())
        return Number.isInteger(value) && value >= 0 ? value : undefined
      },
    )

    const runMode = await ask(
      (prompt) => rl.question(prompt),
      output,
      `Ревью в конце забега [${current.runReview.mode}] (auto|none|self|subagent): `,
      'Допустимо: auto, none, self, subagent.',
      (answer) => (answer.trim() === '' ? current.runReview.mode : oneOf(answer, runModes)),
    )

    const reviewerModel = await ask(
      (prompt) => rl.question(prompt),
      output,
      `Модель ревьюера [${current.reviewer.model ?? 'не задана'}] (provider/model без #variant): `,
      'Нужна модель вида provider/model без #variant.',
      (answer) => {
        if (answer.trim() === '') return current.reviewer.model
        try {
          return validateReviewerModel(answer)
        } catch {
          return undefined
        }
      },
    )

    const changed =
      specMode !== current.specReview.mode ||
      maxSpecChars !== current.specReview.maxSpecChars ||
      largeSpecChars !== current.specReview.largeSpecChars ||
      runMode !== current.runReview.mode ||
      reviewerModel !== current.reviewer.model

    return updateSettings(root, {
      reviewer: { model: reviewerModel },
      specReview: { mode: specMode, maxSpecChars, largeSpecChars },
      runReview: { mode: runMode },
      ...(changed ? { review: { profile: 'custom' } } : {}),
    })
  } finally {
    rl.close()
  }
}
