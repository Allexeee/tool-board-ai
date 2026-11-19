import { findProject } from '../../core/project.ts'
import { addTerm, listTerms, showTerm, type Term } from '../../core/terminology.ts'
import { stringFlag, type ParsedArgs } from '../args.ts'
import { UserError } from '../errors.ts'
import { ok } from '../output.ts'

export default async function command(args: ParsedArgs) {
  const project = findProject(process.cwd())
  if (!project) throw new UserError(3, 'проект не найден: выполните board init')

  const add = (args: ParsedArgs): number => {
    const term = args.positionals[0]?.trim()
    const definition = args.positionals.slice(1).join(' ').trim()
    if (!term || !definition) {
      throw new UserError(
        3,
        'использование: board term add «термин» «значение» [--example «...»] --as developer',
      )
    }

    const result = addTerm(project.root, {
      term,
      definition,
      example: stringFlag(args, 'example'),
      author: stringFlag(args, 'as') ?? 'owner',
    })
    ok(
      result,
      result.duplicate
        ? `термин «${term}» уже есть — строка добавлена, выберите какую оставить`
        : `термин «${term}» добавлен`,
    )
    return 0
  }

  const list = (): number => {
    const terms = listTerms(project.root)
    ok(terms, formatTerms(terms))
    return 0
  }

  const show = (args: ParsedArgs): number => {
    const term = args.positionals[0]?.trim()
    if (!term) throw new UserError(3, 'использование: board term show «термин»')
    const found = showTerm(project.root, term)
    if (found) {
      ok(found, formatTerm(found))
      return 0
    }
    ok(null, `термин «${term}» не найден`)
    return 1
  }

  if (args.sub === 'add') return add(args)
  if (args.sub === 'list') return list()
  if (args.sub === 'show') return show(args)
  throw new UserError(3, 'использование: board term add|list|show')
}

function formatTerms(terms: Term[]): string {
  if (terms.length === 0) return 'терминов нет'
  return terms
    .map(
      (t) =>
        `${t.term} — ${t.definition}${t.example ? ` (пример: ${t.example})` : ''} · ${t.author} · ${t.date}`,
    )
    .join('\n')
}

function formatTerm(term: Term): string {
  const lines = [`${term.term} — ${term.definition}`]
  if (term.example) lines.push(`пример: ${term.example}`)
  lines.push(`автор: ${term.author} · ${term.date}`)
  return lines.join('\n')
}
