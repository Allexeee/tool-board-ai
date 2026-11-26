import { getCard } from '../../core/cards.ts'
import { openDb } from '../../core/db.ts'
import { findProject } from '../../core/project.ts'
import { cardQueueClass, listQueue, moveCard, reorderQueue } from '../../core/queue.ts'
import type { Card } from '../../core/types.ts'
import { boolFlag, stringFlag, type ParsedArgs } from '../args.ts'
import { UserError } from '../errors.ts'
import { ok } from '../output.ts'

const USAGE = 'использование: board queue move UI-4 --before UI-2|--top|--bottom'

export default async function command(args: ParsedArgs) {
  const project = findProject(process.cwd())
  if (!project) throw new UserError(3, 'проект не найден: выполните board init')
  const db = openDb(project.dbPath)

  const move = (args: ParsedArgs): number => {
    const id = args.positionals[0]
    if (!id) throw new UserError(3, USAGE)

    const before = stringFlag(args, 'before')
    if (args.flags['before'] !== undefined && before === undefined) {
      throw new UserError(3, '--before требует ID карточки')
    }

    moveCard(db, id, { before, top: boolFlag(args, 'top'), bottom: boolFlag(args, 'bottom') })

    const card = getCard(db, id)!
    const queueClass = cardQueueClass(card) === 'owner' ? 'owner' : 'исполнители'
    ok(card, `${card.id} · позиция ${card.position} · ${queueClass}`)
    return 0
  }

  const reorder = (): number => {
    reorderQueue(db)
    const cards = listQueue(db)
    const requests = listQueue(db, {}, 'request')
    ok(
      [...cards, ...requests],
      [
        `очередь пересобрана: ${cards.length}`,
        ...cards.map(formatQueueRow),
        `запросы: ${requests.length}`,
        ...requests.map(formatQueueRow),
      ].join('\n'),
    )
    return 0
  }

  try {
    if (args.sub === 'move') return move(args)
    if (args.sub === 'reorder') return reorder()
    throw new UserError(3, USAGE)
  } finally {
    db.close()
  }
}

function formatQueueRow(card: Card): string {
  return `  ${String(card.position).padStart(2)}  ${card.id.padEnd(8)} ${card.status}`
}
