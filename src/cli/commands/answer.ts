import type { DatabaseSync } from 'node:sqlite'
import { answer, openQuestions } from '../../core/discussion.ts'
import { openDb } from '../../core/db.ts'
import { findProject } from '../../core/project.ts'
import { resumeAfterAnswer } from '../../core/lifecycle.ts'
import { numberFlag, stringFlag, type ParsedArgs } from '../args.ts'
import { UserError } from '../errors.ts'
import { ok } from '../output.ts'

export default async function command(args: ParsedArgs) {
  const project = findProject(process.cwd())
  if (!project) throw new UserError(3, 'проект не найден: выполните board init')
  const db = openDb(project.dbPath)

  try {
    const cardId = args.positionals[0]
    const text = args.positionals.slice(1).join(' ')
    if (!cardId || !text) {
      throw new UserError(3, 'использование: board answer UI-1 "ответ" --as owner')
    }

    const actor = stringFlag(args, 'as') ?? 'owner'
    const reply = answer(db, {
      cardId,
      actor,
      questionId: resolveQuestion(db, cardId, numberFlag(args, 'question')),
      text,
    })
    // Ответ на последний открытый вопрос снимает блокировку карточки (§4.1).
    resumeAfterAnswer(db, cardId, actor)

    ok(
      reply,
      `${reply.cardId} · ответ #${reply.id} на вопрос #${reply.answerTo}: ${reply.text}`,
    )
    return 0
  } finally {
    db.close()
  }
}

/** Без --question отвечаем единственному открытому вопросу; иначе просим номер. */
function resolveQuestion(
  db: DatabaseSync,
  cardId: string,
  explicit: number | undefined,
): number {
  if (explicit !== undefined) return explicit

  const open = openQuestions(db, cardId)
  if (open.length === 0) {
    throw new UserError(3, `у карточки ${cardId} открытых вопросов нет`)
  }
  if (open.length > 1) {
    throw new UserError(
      3,
      `у карточки ${cardId} несколько открытых вопросов: укажите --question <id>`,
    )
  }
  return open[0]!.id
}
