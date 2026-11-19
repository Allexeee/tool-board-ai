import { createCard, editCard, getCard, listCards, type CardFilter, type CardPatch } from '../../core/cards.ts'
import { openDb } from '../../core/db.ts'
import { findProject } from '../../core/project.ts'
import type { Card, CardPhase, CardStatus } from '../../core/types.ts'
import { boolFlag, numberFlag, stringFlag, stringsFlag, type ParsedArgs } from '../args.ts'
import { UserError } from '../errors.ts'
import { ok } from '../output.ts'

export default async function command(args: ParsedArgs) {
  const project = findProject(process.cwd())
  if (!project) throw new UserError(3, 'проект не найден: выполните board init')
  const db = openDb(project.dbPath)

  const add = (args: ParsedArgs): number => {
    const group = stringFlag(args, 'group')
    if (!group) throw new UserError(3, 'нужен --group, например --group UI')
    const title = stringFlag(args, 'title')
    if (!title) throw new UserError(3, 'нужен --title «короткое название»')
    const skill = stringFlag(args, 'skill')
    if (!skill) throw new UserError(3, 'нужен --skill dev')

    const card = createCard(db, {
      group,
      title,
      body: stringFlag(args, 'body'),
      skill,
      author: stringFlag(args, 'as') ?? 'owner',
    })
    ok(card, `${card.id} создана: ${card.title}`)
    return 0
  }

  const list = (args: ParsedArgs): number => {
    const filter: CardFilter = {}
    const phases = splitFlag(args, 'phase')
    if (phases.length > 0) filter.phase = phases as CardPhase[]
    const statuses = splitFlag(args, 'status')
    if (statuses.length > 0) filter.status = statuses as CardStatus[]

    const skill = stringFlag(args, 'skill')
    if (skill !== undefined) filter.skill = skill
    const holder = stringFlag(args, 'holder')
    if (holder !== undefined) filter.holder = holder
    const group = stringFlag(args, 'group')
    if (group !== undefined) filter.group = group

    const cards = listCards(db, filter)
    ok(cards, cards.length === 0 ? 'карточек нет' : formatList(cards))
    return 0
  }

  const show = (args: ParsedArgs): number => {
    const id = args.positionals[0]
    if (!id) throw new UserError(3, 'использование: board card show UI-1')

    const card = getCard(db, id)
    if (!card) throw new UserError(3, `карточка ${id} не найдена`)

    ok(card, formatCard(card))
    return 0
  }

  const edit = (args: ParsedArgs): number => {
    const id = args.positionals[0]
    if (!id) throw new UserError(3, 'использование: board card edit UI-1 --title «...»')

    const patch: CardPatch = {}

    const title = stringFlag(args, 'title')
    if (title !== undefined) patch.title = title
    const body = stringFlag(args, 'body')
    if (body !== undefined) patch.body = body
    const skill = stringFlag(args, 'skill')
    if (skill !== undefined) patch.skill = skill

    const importance = numberFlag(args, 'importance')
    if (importance !== undefined) patch.importance = importance
    const urgency = numberFlag(args, 'urgency')
    if (urgency !== undefined) patch.urgency = urgency

    const needsMerge = switchFlag(args, 'needs-merge', 'no-needs-merge')
    if (needsMerge !== undefined) patch.needsMerge = needsMerge
    const reviewRequired = switchFlag(args, 'review', 'no-review')
    if (reviewRequired !== undefined) patch.reviewRequired = reviewRequired

    if (args.flags['scope'] !== undefined) patch.scope = stringsFlag(args, 'scope')

    const note = stringFlag(args, 'note')
    if (note !== undefined) patch.note = note

    if (Object.keys(patch).length === 0) {
      throw new UserError(3, 'нечего менять: укажите хотя бы одно поле карточки')
    }

    const card = editCard(db, { id, actor: stringFlag(args, 'as') ?? 'owner', patch })
    ok(card, `${card.id} изменена: ${card.title}`)
    return 0
  }

  try {
    if (args.sub === 'add') return add(args)
    if (args.sub === 'list') return list(args)
    if (args.sub === 'show') return show(args)
    if (args.sub === 'edit') return edit(args)
    throw new UserError(3, 'использование: board card add|list|show|edit')
  } finally {
    db.close()
  }
}

function splitFlag(args: ParsedArgs, name: string): string[] {
  return stringsFlag(args, name)
    .flatMap((value) => value.split(','))
    .map((value) => value.trim())
    .filter(Boolean)
}

/** Пара --x/--no-x: одновременный вызов — ошибка, иначе непонятно, что выбрали. */
function switchFlag(args: ParsedArgs, positive: string, negative: string): boolean | undefined {
  const yes = boolFlag(args, positive)
  const no = boolFlag(args, negative)
  if (yes && no) {
    throw new UserError(3, `--${positive} и --${negative} взаимоисключающие`)
  }
  if (yes) return true
  if (no) return false
  return undefined
}

function value(text: string | number | null): string {
  return text === null || text === '' ? '—' : String(text)
}

function formatCard(card: Card): string {
  const lines = [
    `${card.id} · ${card.title}`,
    `статус: ${card.status} · фаза: ${card.phase} · навык: ${value(card.skill)}`,
    `важность: ${value(card.importance)} · срочность: ${value(card.urgency)}`,
    `мерж: ${card.needsMerge ? 'да' : 'нет'} · ревью: ${card.reviewRequired ? 'да' : 'нет'}`,
    `scope: ${card.scope.length > 0 ? card.scope.join(', ') : '—'}`,
  ]
  if (card.note !== null && card.note !== '') lines.push(`заметка: ${card.note}`)
  if (card.body !== '') lines.push('', card.body)
  return lines.join('\n')
}

function formatList(cards: Card[]): string {
  const rows = cards.map(
    (card) =>
      `${card.id.padEnd(8)} ${card.status.padEnd(12)} ${card.phase.padEnd(8)} ` +
      `${value(card.skill).padEnd(10)} ${card.title}`,
  )
  return [...rows, '', `всего: ${cards.length}`].join('\n')
}
