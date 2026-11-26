import { getCard } from '../../core/cards.ts'
import { openDb } from '../../core/db.ts'
import { findProject } from '../../core/project.ts'
import { readSettings, updateSettings, type AcceptanceRule } from '../../core/settings.ts'
import { assertKnownTags } from '../../core/tags.ts'
import { explainAcceptance } from '../../core/acceptance.ts'
import { groupExists, normalizeGroupPrefix } from '../../core/groups.ts'
import { stringsFlag, stringFlag, type ParsedArgs } from '../args.ts'
import { UserError } from '../errors.ts'
import { ok } from '../output.ts'

const USAGE =
  'board acceptance rule add <name> [--include-group G] [--include-tag T] [--include-skill S] [--include-path P] ' +
  '[--exclude-group G] [--exclude-tag T] [--exclude-skill S] [--exclude-path P] | rule list | rule remove <name> | check <ID>'

function conditions(db: ReturnType<typeof openDb>, args: ParsedArgs, prefix: string) {
  const groups = stringsFlag(args, `${prefix}-group`).map((group) => normalizeGroupPrefix(group))
  for (const group of groups) {
    if (!groupExists(db, group)) throw new UserError(3, `группы ${group} нет: board group add ${group}`)
  }
  const tags = assertKnownTags(db, stringsFlag(args, `${prefix}-tag`))
  const skills = stringsFlag(args, `${prefix}-skill`)
  const paths = stringsFlag(args, `${prefix}-path`)
  const result: AcceptanceRule['include'] = {}
  if (groups.length > 0) result.groups = groups
  if (tags.length > 0) result.tags = tags
  if (skills.length > 0) result.skills = skills
  if (paths.length > 0) result.paths = paths
  return result
}

function renderRule(rule: AcceptanceRule): string {
  const parts = (prefix: string, conditions: AcceptanceRule['include']) =>
    [
      conditions.groups?.length ? `${prefix}group: ${conditions.groups.join(',')}` : '',
      conditions.tags?.length ? `${prefix}tag: ${conditions.tags.join(',')}` : '',
      conditions.skills?.length ? `${prefix}skill: ${conditions.skills.join(',')}` : '',
      conditions.paths?.length ? `${prefix}path: ${conditions.paths.join(',')}` : '',
    ]
      .filter(Boolean)
      .join('; ')
  const include = parts('', rule.include)
  const exclude = rule.exclude ? parts('−', rule.exclude) : ''
  return `${rule.name}${include ? ` [${include}]` : ''}${exclude ? ` [${exclude}]` : ''}`
}

export default async function command(args: ParsedArgs) {
  const project = findProject(process.cwd())
  if (!project) throw new UserError(3, 'проект не найден: выполните board init')
  const db = openDb(project.dbPath)
  const settings = readSettings(project.root)

  const save = (rules: AcceptanceRule[]): void => {
    updateSettings(project.root, {
      acceptance: { ...settings.acceptance, rules },
    })
  }

  const rule = (args: ParsedArgs): number => {
    const action = args.positionals[0]
    if (action === 'list') {
      const rules = settings.acceptance.rules
      ok(rules, rules.length > 0 ? rules.map(renderRule).join('\n') : 'правил приёмки нет')
      return 0
    }
    if (action === 'add') {
      const name = args.positionals[1]?.trim()
      if (!name) throw new UserError(3, USAGE)
      if (settings.acceptance.rules.some((item) => item.name === name)) {
        throw new UserError(3, `правило ${name} уже есть`)
      }
      const include = conditions(db, args, 'include')
      if (Object.keys(include).length === 0) {
        throw new UserError(3, 'нужно хотя бы одно include-условие')
      }
      const exclude = conditions(db, args, 'exclude')
      const next: AcceptanceRule = { name, include }
      if (Object.keys(exclude).length > 0) next.exclude = exclude
      save([...settings.acceptance.rules, next])
      ok(next, `правило ${name} добавлено`)
      return 0
    }
    if (action === 'remove') {
      const name = args.positionals[1]?.trim()
      if (!name) throw new UserError(3, USAGE)
      if (!settings.acceptance.rules.some((item) => item.name === name)) {
        throw new UserError(3, `правила ${name} нет`)
      }
      save(settings.acceptance.rules.filter((item) => item.name !== name))
      ok({ name }, `правило ${name} удалено`)
      return 0
    }
    throw new UserError(3, USAGE)
  }

  const check = (args: ParsedArgs): number => {
    const id = args.positionals[0]
    if (!id) throw new UserError(3, 'использование: board acceptance check UI-1')
    const card = getCard(db, id)
    if (!card) throw new UserError(3, `карточка ${id} не найдена`)
    const decision = explainAcceptance(db, project.root, card, settings)
    const lines = [
      `${card.id}: ${decision.required ? 'нужна приёмка' : 'приёмка не нужна'}`,
      `  правила: ${decision.matched.length > 0 ? decision.matched.join(', ') : '—'}`,
      `  исключено: ${decision.excluded.length > 0 ? decision.excluded.join(', ') : '—'}`,
      `  ручной флаг: ${decision.manual ? 'да' : 'нет'}`,
      `  owner_acceptance: ${card.ownerAcceptance ? 'да' : 'нет'}`,
    ]
    ok({ ...decision, ownerAcceptance: card.ownerAcceptance }, lines.join('\n'))
    return 0
  }

  try {
    if (args.sub === 'rule') return rule(args)
    if (args.sub === 'check') return check(args)
    throw new UserError(3, USAGE)
  } finally {
    db.close()
  }
}
