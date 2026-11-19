import { openDb } from '../../core/db.ts'
import {
  addDecision,
  listDecisions,
  obsoleteDecision,
  renderDecisions,
  supersedeDecision,
  type Decision,
  type DecisionKind,
} from '../../core/decisions.ts'
import { findProject } from '../../core/project.ts'
import { stringFlag, type ParsedArgs } from '../args.ts'
import { UserError } from '../errors.ts'
import { ok } from '../output.ts'

export default async function command(args: ParsedArgs) {
  const project = findProject(process.cwd())
  if (!project) throw new UserError(3, 'проект не найден: выполните board init')
  const db = openDb(project.dbPath)

  const add = (args: ParsedArgs): number => {
    const positionals = args.positionals
    let cardId: string | undefined
    let text: string
    if (positionals.length >= 2) {
      cardId = positionals[0]
      text = positionals.slice(1).join(' ').trim()
    } else {
      cardId = undefined
      text = positionals[0]?.trim() ?? ''
    }
    if (!text) {
      throw new UserError(
        3,
        'использование: board decision add [UI-1] «текст» --kind decision|assumption --as developer',
      )
    }

    const kind = stringFlag(args, 'kind') === 'assumption' ? 'assumption' : 'decision'
    const decision = addDecision(db, {
      cardId,
      kind: kind as DecisionKind,
      text,
      author: stringFlag(args, 'as') ?? 'owner',
    })
    renderDecisions(db, project.docsDir)
    ok(decision, `${decision.id} ${decision.kind}: ${decision.text}`)
    return 0
  }

  const list = (): number => {
    const decisions = listDecisions(db)
    ok(decisions, formatList(decisions))
    return 0
  }

  const supersede = (args: ParsedArgs): number => {
    const id = args.positionals[0]
    if (!id) throw new UserError(3, 'использование: board decision supersede D12 --by D15 --reason «...»')
    const by = stringFlag(args, 'by')
    if (!by) throw new UserError(3, 'нужен --by D<n>')

    const decision = supersedeDecision(db, {
      id,
      by,
      reason: stringFlag(args, 'reason') ?? '',
      actor: stringFlag(args, 'as') ?? 'owner',
    })
    renderDecisions(db, project.docsDir)
    ok(decision, `${decision.id} отменено, заменено ${decision.supersededBy}`)
    return 0
  }

  const obsolete = (args: ParsedArgs): number => {
    const id = args.positionals[0]
    if (!id) throw new UserError(3, 'использование: board decision obsolete D7 --reason «...»')

    const decision = obsoleteDecision(db, {
      id,
      reason: stringFlag(args, 'reason') ?? '',
      actor: stringFlag(args, 'as') ?? 'owner',
    })
    renderDecisions(db, project.docsDir)
    ok(decision, `${decision.id} неактуально`)
    return 0
  }

  try {
    if (args.sub === 'add') return add(args)
    if (args.sub === 'list') return list()
    if (args.sub === 'supersede') return supersede(args)
    if (args.sub === 'obsolete') return obsolete(args)
    throw new UserError(3, 'использование: board decision add|list|supersede|obsolete')
  } finally {
    db.close()
  }
}

function formatList(decisions: Decision[]): string {
  if (decisions.length === 0) return 'решений нет'
  return decisions
    .map((d) => {
      const card = d.cardId ? ` · ${d.cardId}` : ''
      const superseded = d.supersededBy ? ` · заменено ${d.supersededBy}` : ''
      return `${d.id} [${d.status}] ${d.kind}${card} ${d.author}: ${d.text}${superseded}`
    })
    .join('\n')
}
