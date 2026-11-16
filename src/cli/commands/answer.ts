import { findProject } from '../../core/project.ts'
import { openDb } from '../../core/db.ts'
import { answer } from '../../core/questions.ts'
import { stringFlag, type ParsedArgs } from '../args.ts'
import { ok } from '../output.ts'
import { UserError } from '../errors.ts'

export default async function command(args: ParsedArgs) {
  const project = findProject(process.cwd())
  if (!project) throw new UserError(3, 'проект не найден: выполните toolbox-al init')
  const db = openDb(project.dbPath)

  const id = args.positionals[0]
  const text = args.positionals.slice(1).join(' ') || stringFlag(args, 'text')
  const actor = stringFlag(args, 'as') ?? 'owner'

  if (!id || !text) throw new UserError(3, 'использование: answer Q1 "ответ"')

  const question = answer(db, { id, answer: text, actor })
  ok(question, `${question.id}  ответ принят: ${question.answer}`)
  return 0
}
