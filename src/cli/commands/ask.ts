import { ask } from '../../core/discussion.ts'
import { openDb } from '../../core/db.ts'
import { findProject } from '../../core/project.ts'
import { stringFlag, type ParsedArgs } from '../args.ts'
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
      throw new UserError(3, 'использование: board ask UI-1 "вопрос" --as developer')
    }

    const question = ask(db, {
      cardId,
      author: stringFlag(args, 'as') ?? 'owner',
      text,
    })
    // --block подключится в Task 9: сейчас вопрос только записывается.
    ok(
      question,
      `${question.cardId} · вопрос #${question.id} задан: ${question.text} (спрашивает ${question.author})`,
    )
    return 0
  } finally {
    db.close()
  }
}
