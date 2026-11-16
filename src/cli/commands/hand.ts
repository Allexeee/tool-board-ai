import { findProject } from '../../core/project.ts'
import { openDb } from '../../core/db.ts'
import { fillHand, getHand, setHand } from '../../core/hands.ts'
import { stringFlag, type ParsedArgs } from '../args.ts'
import { ok } from '../output.ts'
import { UserError } from '../errors.ts'

export default async function command(args: ParsedArgs) {
  const project = findProject(process.cwd())
  if (!project) throw new UserError(3, 'проект не найден: выполните toolbox-al init')
  const db = openDb(project.dbPath)

  const executor = stringFlag(args, 'as') ?? args.positionals[0]
  if (!executor) throw new UserError(3, 'использование: hand show --as w1')

  if (args.sub === 'set') {
    const tasks = stringFlag(args, 'as') ? args.positionals : args.positionals.slice(1)
    const hand = setHand(db, executor, tasks, 'orchestrator')
    ok(hand, hand.map((task) => task.id).join(', ') || 'рука пуста')
    return 0
  }

  if (args.sub === 'add') {
    const tasks = stringFlag(args, 'as') ? args.positionals : args.positionals.slice(1)
    const current = getHand(db, executor).map((task) => task.id)
    const hand = setHand(db, executor, [...current, ...tasks], 'orchestrator')
    ok(hand, hand.map((task) => task.id).join(', ') || 'рука пуста')
    return 0
  }

  const hand = args.sub === 'show' || args.sub === null ? fillHand(db, executor) : getHand(db, executor)
  ok(hand, hand.length ? hand.map((task) => `${task.id}  ${task.title}`).join('\n') : 'рука пуста')
  return 0
}
