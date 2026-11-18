import { findProject } from '../../core/project.ts'
import { openDb } from '../../core/db.ts'
import { clearHand, getHand, setHand } from '../../core/hands.ts'
import { advanceTime } from '../../core/clock.ts'
import { stringFlag, type ParsedArgs } from '../args.ts'
import { ok } from '../output.ts'
import { UserError } from '../errors.ts'

export default async function command(args: ParsedArgs) {
  const project = findProject(process.cwd())
  if (!project) throw new UserError(3, 'проект не найден: выполните toolbox-al init')
  const db = openDb(project.dbPath)

  const executor = stringFlag(args, 'as') ?? args.positionals[0]
  if (!executor) throw new UserError(3, 'использование: hand show|set|add|clear <id> --as w1')

  if (args.sub === 'set') {
    const tasks = stringFlag(args, 'as') ? args.positionals : args.positionals.slice(1)
    const hand = setHand(db, executor, tasks, 'orchestrator')
    ok(hand, hand.map((task) => task.id).join(', ') || 'рука пуста')
    return 0
  }

  if (args.sub === 'add') {
    const tasks = stringFlag(args, 'as') ? args.positionals : args.positionals.slice(1)
    const current = getHand(db, executor).map((task) => task.id)
    const have = new Set(current)
    const already = tasks.filter((id) => have.has(id))
    const fresh = tasks.filter((id) => !have.has(id))
    const hand = setHand(db, executor, [...current, ...fresh], 'orchestrator')
    const list = hand.map((task) => task.id).join(', ') || 'рука пуста'
    const repeated = [...new Set(already)]
    const note = repeated.length > 0 ? `\nуже в руке, повтор не добавлен: ${repeated.join(', ')}` : ''
    ok(hand, list + note)
    return 0
  }

  // снять руку целиком: бронь без исполнителя иначе не снять, а задачи из очереди пропадают
  if (args.sub === 'clear') {
    const freed = clearHand(db, executor, 'orchestrator')
    ok(freed, freed.length ? `рука освобождена: ${freed.join(', ')}` : 'рука уже пуста')
    return 0
  }

  // показ ничего не резервирует: рука пополняется в dispatch/next, а не при чтении
  advanceTime(db)
  const hand = getHand(db, executor)
  ok(hand, hand.length ? hand.map((task) => `${task.id}  ${task.title}`).join('\n') : 'рука пуста')
  return 0
}
