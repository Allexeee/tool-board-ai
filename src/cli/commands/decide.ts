import { findProject } from '../../core/project.ts'
import { openDb } from '../../core/db.ts'
import { addDecision, listDecisions } from '../../core/decisions.ts'
import { stringFlag, type ParsedArgs } from '../args.ts'
import { ok } from '../output.ts'
import { UserError } from '../errors.ts'

export default async function command(args: ParsedArgs) {
  const project = findProject(process.cwd())
  if (!project) throw new UserError(3, 'проект не найден: выполните toolbox-al init')
  const db = openDb(project.dbPath)

  if (args.sub === 'add') {
    const question = args.positionals[0] ?? stringFlag(args, 'text')
    const choice = stringFlag(args, 'choice')
    const reason = stringFlag(args, 'reason')
    if (!question || !choice || !reason) {
      throw new UserError(3, 'использование: decide add "вопрос" --choice "что выбрали" --reason "почему"')
    }

    const decision = addDecision(db, {
      question,
      choice,
      reason,
      subjectId: stringFlag(args, 'subject') ?? null,
      author: stringFlag(args, 'as') ?? 'owner',
    })
    ok(decision, `${decision.id}  ${decision.question} → ${decision.choice}`)
    return 0
  }

  const decisions = listDecisions(db, { subjectId: stringFlag(args, 'subject') })
  ok(
    decisions,
    decisions.length === 0
      ? 'решений нет'
      : decisions.map((d) => `${d.id.padEnd(4)} ${d.subjectId ?? '—'}  ${d.question} → ${d.choice}`).join('\n'),
  )
  return 0
}
