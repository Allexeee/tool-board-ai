import { writeFileSync } from 'node:fs'
import { listCards } from '../../core/cards.ts'
import { openDb } from '../../core/db.ts'
import { findProject } from '../../core/project.ts'
import type { Card } from '../../core/types.ts'
import { boolFlag, stringFlag, type ParsedArgs } from '../args.ts'
import { UserError } from '../errors.ts'

export default async function command(args: ParsedArgs): Promise<number> {
  const project = findProject(process.cwd())
  if (!project) throw new UserError(3, 'проект не найден: выполните board init')
  const db = openDb(project.dbPath)

  try {
    const cards = listCards(db)
    const markdown = boolFlag(args, 'md') || stringFlag(args, 'format') === 'md'
    const payload = markdown ? renderMarkdown(cards) : JSON.stringify({ cards }, null, 2)

    const out = stringFlag(args, 'out')
    if (out) {
      writeFileSync(out, payload + (markdown ? '' : '\n'), 'utf8')
      return 0
    }

    process.stdout.write(payload + '\n')
    return 0
  } finally {
    db.close()
  }
}

function renderMarkdown(cards: Card[]): string {
  const lines: string[] = ['# Доска', '']
  for (const card of cards) {
    lines.push(`## ${card.id} — ${card.title}`)
    const skill = card.skill ? `, навык: ${card.skill}` : ''
    lines.push(`- статус: ${card.status}${skill}`)
    if (card.body.trim()) {
      lines.push('', card.body.trim())
    }
    const acceptance = card.acceptance
      .split('\n')
      .map((item) => item.trim())
      .filter(Boolean)
    if (acceptance.length > 0) {
      lines.push('', 'Критерии приёмки:')
      for (const item of acceptance) lines.push(`- [ ] ${item}`)
    }
    if (card.scope.length > 0) {
      lines.push('', `Scope: ${card.scope.join(', ')}`)
    }
    lines.push('')
  }
  return lines.join('\n')
}
