import { findProject } from '../../core/project.ts'
import { openDb } from '../../core/db.ts'
import { ask, type Addressee, type SubjectType } from '../../core/questions.ts'
import { listFlag, stringFlag, type ParsedArgs } from '../args.ts'
import { ok } from '../output.ts'
import { UserError } from '../errors.ts'

export default async function command(args: ParsedArgs) {
  const project = findProject(process.cwd())
  if (!project) throw new UserError(3, 'проект не найден: выполните toolbox-al init')
  const db = openDb(project.dbPath)

  const subjectId = args.positionals[0]
  const text = args.positionals[1] ?? stringFlag(args, 'text')
  if (!subjectId || !text) throw new UserError(3, 'использование: ask F1.S1-1 "вопрос" --to owner')

  const subjectType = (stringFlag(args, 'kind') ?? inferType(subjectId)) as SubjectType
  const question = ask(db, {
    addressee: (stringFlag(args, 'to') as Addressee) ?? 'owner',
    text,
    options: listFlag(args, 'options').flatMap((value) => value.split(',')).map((v) => v.trim()),
    subjectType,
    subjectId,
    deadline: stringFlag(args, 'deadline'),
    timeoutPolicy: (stringFlag(args, 'policy') as 'block' | 'proceed') ?? 'block',
  })

  ok(question, `${question.id}  вопрос для ${question.addressee}: ${question.text}`)
  return 0
}

function inferType(id: string): SubjectType {
  if (id.startsWith('R')) return 'request'
  return 'task'
}
