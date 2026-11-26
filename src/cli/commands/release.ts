import { openDb } from '../../core/db.ts'
import { findProject } from '../../core/project.ts'
import { release } from '../../core/release.ts'
import type { Card } from '../../core/types.ts'
import { boolFlag, stringFlag, type ParsedArgs } from '../args.ts'
import { UserError } from '../errors.ts'
import { ok } from '../output.ts'

export default async function command(args: ParsedArgs) {
  const project = findProject(process.cwd())
  if (!project) throw new UserError(3, 'проект не найден: выполните board init')
  const db = openDb(project.dbPath)

  try {
    const actor = stringFlag(args, 'as') ?? 'owner'
    const result = release(db, project.root, actor, {
      noReview: boolFlag(args, 'no-review'),
      reason: stringFlag(args, 'reason'),
      package: stringFlag(args, 'package'),
    })
    ok(result, formatRelease(result))
    return 0
  } finally {
    db.close()
  }
}

function formatRelease(result: { commit: string; cards: Card[]; reviewWaived: boolean }): string {
  const lines = [`main ← dev: ${result.commit}`]
  if (result.reviewWaived) lines.push('  ревью пропущено владельцем')
  if (result.cards.length === 0) {
    lines.push('  карточек в main нет')
  } else {
    for (const card of result.cards) lines.push(`  ${card.id}  ${card.title}`)
  }
  return lines.join('\n')
}
