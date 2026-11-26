import type { DatabaseSync } from 'node:sqlite'
import { readFileSync } from 'node:fs'
import { createCard, editCard, getCard, listCards, resolveCardId, type CardFilter, type CardPatch } from '../../core/cards.ts'
import { openDb, tx } from '../../core/db.ts'
import { addDep, isSatisfied, listDeps, removeDep } from '../../core/deps.ts'
import { listDiscussion, type Discussion } from '../../core/discussion.ts'
import { listEvents, type EventRecord } from '../../core/events.ts'
import {
  amendCard,
  applyShapeFile,
  approveCard,
  cancelCard,
  deferCard,
  addScope,
  ownerDone,
  rejectCard,
  reopenCard,
  resumeCard,
  shapeCard,
  submitCard,
  type ShapeFile,
} from '../../core/lifecycle.ts'
import { findProject } from '../../core/project.ts'
import { listGroups, normalizeGroupPrefix } from '../../core/groups.ts'
import { insertIntoQueue } from '../../core/queue.ts'
import { addRef, listRefs, removeRef, type Ref } from '../../core/refs.ts'
import { submitVerdict, waiveReview } from '../../core/review.ts'
import {
  modelContext,
  resolveReviewProfile,
  resolveSpecReviewMode,
  reviewReopensLimit,
} from '../../core/review-policy.ts'
import { getRun } from '../../core/runs.ts'
import { readSettings } from '../../core/settings.ts'
import { assertKnownTags } from '../../core/tags.ts'
import {
  latestSpecReview,
  listReviews,
  recordSpecReview,
  type SpecReviewGate,
} from '../../core/spec-review.ts'
import {
  addStep,
  doneStep,
  listSteps,
  removeStep,
  stepProgress,
  type Step,
} from '../../core/steps.ts'
import type { Card, CardPhase, CardStatus } from '../../core/types.ts'
import { boolFlag, numberFlag, stringFlag, stringsFlag, type ParsedArgs } from '../args.ts'
import { UserError } from '../errors.ts'
import { ok } from '../output.ts'

/** --no-review для мержа — решение владельца с причиной; иначе waiver не записать. */
function requireNoReview(args: ParsedArgs): string {
  const actor = stringFlag(args, 'as') ?? 'owner'
  const reason = stringFlag(args, 'reason')
  if (actor !== 'owner') {
    throw new UserError(3, '--no-review — решение владельца: --as owner')
  }
  if (!reason) {
    throw new UserError(3, '--no-review требует --reason «почему без ревью»')
  }
  return reason
}

export default async function command(args: ParsedArgs) {
  const project = findProject(process.cwd())
  if (!project) throw new UserError(3, 'проект не найден: выполните board init')
  const db = openDb(project.dbPath)
  const settings = readSettings(project.root)
  const reviewContext = modelContext(process.env)

  const specGate = (card: Card): { gate: SpecReviewGate; resolution: ReturnType<typeof resolveSpecReviewMode> } => {
    const resolution = resolveSpecReviewMode({
      settings,
      specLength: card.body.length + card.acceptance.length,
      specText: `${card.body}\n${card.acceptance}`,
      context: reviewContext,
    })
    return {
      gate: { mode: resolution.mode, reviewerModel: resolution.reviewerModel },
      resolution,
    }
  }

  const add = (args: ParsedArgs): number => {
    const groups = listGroups(db)
    const known = groups.map((item) => item.prefix)
    const groupFlag = stringFlag(args, 'group')
    const newGroup = boolFlag(args, 'new-group')

    let group: string
    if (!groupFlag) {
      // Пока областей нет, общий префикс — CARD.
      if (groups.length > 0) {
        throw new UserError(
          3,
          `нужен --group: в проекте уже есть ${known.join(', ')}; новая область — --group <P> --new-group`,
        )
      }
      group = 'CARD'
    } else {
      group = normalizeGroupPrefix(groupFlag)
      // Первый префикс в пустом проекте — это и есть определение области.
      if (!known.includes(group) && !newGroup && groups.length > 0) {
        throw new UserError(
          3,
          `префикс ${group} не заведён: есть ${known.join(', ')}; если это новая область — --new-group`,
        )
      }
    }

    const title = stringFlag(args, 'title')
    if (!title) throw new UserError(3, 'нужен --title «короткое название»')
    const skill = stringFlag(args, 'skill')
    if (!skill) throw new UserError(3, 'нужен --skill dev')

    // Оценки валидируются до создания: ошибка ввода не должна оставлять карточку.
    const importance = numberFlag(args, 'importance')
    if (importance !== undefined && (importance < 0 || importance > 3)) {
      throw new UserError(3, 'важность — целое число от 0 до 3')
    }
    const urgency = numberFlag(args, 'urgency')
    if (urgency !== undefined && (urgency < 0 || urgency > 3)) {
      throw new UserError(3, 'срочность — целое число от 0 до 3')
    }

    const card = createCard(db, {
      group,
      title,
      body: stringFlag(args, 'spec') ?? stringFlag(args, 'body'),
      acceptance: stringsFlag(args, 'acceptance'),
      tags: assertKnownTags(db, stringsFlag(args, 'tag')),
      skill,
      author: stringFlag(args, 'as') ?? 'owner',
      needsMerge: settings.git ? undefined : false,
    })
    const patch: CardPatch = {}
    if (importance !== undefined) patch.importance = importance
    if (urgency !== undefined) patch.urgency = urgency
    const scope = stringsFlag(args, 'scope')
    if (scope.length > 0) patch.scope = scope
    const reviewFlag = switchFlag(args, 'review', 'no-review')
    const needsMergeFlag = switchFlag(args, 'needs-merge', 'no-needs-merge')
    const effectiveNeedsMerge = needsMergeFlag ?? (skill !== 'owner' && settings.git)
    const profile = resolveReviewProfile(settings, reviewContext)
    const reviewDefault =
      profile.profile.card === 'always'
        ? true
        : profile.profile.card === 'never'
          ? false
          : effectiveNeedsMerge
    let waiverReason: string | null = null
    if (reviewFlag === undefined) {
      if (reviewDefault) patch.reviewRequired = true
      else if (profile.profile.card === 'never' && effectiveNeedsMerge) {
        waiverReason = `профиль ${profile.name}`
      }
    } else if (reviewFlag === false && effectiveNeedsMerge) {
      waiverReason = requireNoReview(args)
      patch.reviewRequired = false
    } else {
      patch.reviewRequired = reviewFlag
    }
    if (needsMergeFlag !== undefined) patch.needsMerge = needsMergeFlag
    const note = stringFlag(args, 'note')
    if (note !== undefined) patch.note = note
    if (Object.keys(patch).length > 0) {
      editCard(db, { id: card.id, actor: stringFlag(args, 'as') ?? 'owner', patch })
    }
    if (waiverReason) {
      waiveReview(db, { cardId: card.id, actor: 'owner', reason: waiverReason })
    }
    insertIntoQueue(db, card.id)
    const created = getCard(db, card.id)!
    ok(created, `${created.id} создана: ${created.title}`)
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

    const all = listCards(db, filter)
    const limit = numberFlag(args, 'limit')
    const cards = limit !== undefined && limit >= 0 ? all.slice(0, limit) : all
    ok(cards, cards.length === 0 ? 'карточек нет' : formatList(cards))
    return 0
  }

  const requireCard = (id: string | undefined, usage: string) => {
    if (!id) throw new UserError(3, `использование: ${usage}`)
    const card = getCard(db, id)
    if (!card) throw new UserError(3, `карточка ${id} не найдена`)
    return card
  }

  const tag = (args: ParsedArgs): number => {
    const [action, rawId, rawTag] = args.positionals
    const card = requireCard(rawId, 'board card tag add|remove|list <ID> [тег]')
    if (action === 'list') {
      ok(card.tags, card.tags.length > 0 ? card.tags.join(', ') : 'тегов нет')
      return 0
    }
    if (action !== 'add' && action !== 'remove') {
      throw new UserError(3, 'использование: board card tag add|remove|list <ID> [тег]')
    }
    const name = assertKnownTags(db, [rawTag ?? ''])[0]
    if (action === 'add') {
      if (card.tags.includes(name)) {
        ok(card, `${card.id}: тег ${name} уже стоит`)
        return 0
      }
      const updated = editCard(db, {
        id: card.id,
        actor: stringFlag(args, 'as') ?? 'owner',
        patch: { tags: [...card.tags, name] },
      })
      ok(updated, `${card.id}: + ${name}`)
      return 0
    }
    if (!card.tags.includes(name)) {
      ok(card, `${card.id}: тега ${name} нет`)
      return 0
    }
    const updated = editCard(db, {
      id: card.id,
      actor: stringFlag(args, 'as') ?? 'owner',
      patch: { tags: card.tags.filter((tagName) => tagName !== name) },
    })
    ok(updated, `${card.id}: − ${name}`)
    return 0
  }

  const show = (args: ParsedArgs): number => {
    const rawId = args.positionals[0]
    if (!rawId) throw new UserError(3, 'использование: board card show UI-1')
    const card = requireCard(resolveCardId(db, rawId) ?? rawId, 'board card show UI-1')
    const steps = listSteps(db, card.id)
    const { resolution } = specGate(card)
    // События — только по запросу: в каждом полный снимок before/after.
    const withEvents = args.flags['events'] === true
    const limit = numberFlag(args, 'limit') ?? 5
    if (limit < 0) throw new UserError(3, '--limit — целое число от 0')
    const events = withEvents ? listEvents(db, card.id).slice(-limit) : null
    const detail = {
      ...card,
      spec: card.body,
      plan: steps,
      specReview: {
        mode: resolution.mode,
        reason: resolution.reason,
        reviewerModel: resolution.reviewerModel,
      },
      specReviewLatest: latestSpecReview(db, card.id),
      reviews: listReviews(db, card.id),
      refs: listRefs(db, card.id),
      deps: listDeps(db, card.id),
      discussion: listDiscussion(db, card.id),
      ...(events ? { events } : {}),
    }

    ok(
      detail,
      formatCard(
        db,
        card,
        detail.deps,
        detail.plan,
        detail.refs,
        detail.discussion,
        detail.events ?? [],
      ),
    )
    return 0
  }

  const edit = (args: ParsedArgs): number => {
    const id = args.positionals[0]
    if (!id) throw new UserError(3, 'использование: board card edit UI-1 --title «...»')

    const patch: CardPatch = {}

    const title = stringFlag(args, 'title')
    if (title !== undefined) patch.title = title
    const body = stringFlag(args, 'spec') ?? stringFlag(args, 'body')
    if (body !== undefined) patch.body = body
    if (args.flags['acceptance'] !== undefined) patch.acceptance = stringsFlag(args, 'acceptance')
    const skill = stringFlag(args, 'skill')
    if (skill !== undefined) patch.skill = skill

    const importance = numberFlag(args, 'importance')
    if (importance !== undefined) patch.importance = importance
    const urgency = numberFlag(args, 'urgency')
    if (urgency !== undefined) patch.urgency = urgency

    const needsMerge = switchFlag(args, 'needs-merge', 'no-needs-merge')
    const reviewRequired = switchFlag(args, 'review', 'no-review')
    const existing = requireCard(id, 'board card edit UI-1')
    const effectiveNeedsMerge = needsMerge ?? existing.needsMerge
    const profile = resolveReviewProfile(settings, reviewContext)
    const reviewDefault =
      profile.profile.card === 'always'
        ? true
        : profile.profile.card === 'never'
          ? false
          : effectiveNeedsMerge
    let waiverReason: string | null = null
    if (reviewRequired === undefined) {
      if (needsMerge !== undefined) {
        patch.reviewRequired = reviewDefault
        if (!reviewDefault && profile.profile.card === 'never' && effectiveNeedsMerge) {
          waiverReason = `профиль ${profile.name}`
        }
      }
    } else if (reviewRequired === false && effectiveNeedsMerge) {
      waiverReason = requireNoReview(args)
      patch.reviewRequired = false
    } else {
      patch.reviewRequired = reviewRequired
    }
    if (needsMerge !== undefined) patch.needsMerge = needsMerge

    if (args.flags['scope'] !== undefined) patch.scope = stringsFlag(args, 'scope')
    if (args.flags.tag !== undefined) patch.tags = assertKnownTags(db, stringsFlag(args, 'tag'))
    if (args.flags['clear-tags'] !== undefined) patch.tags = []

    const note = stringFlag(args, 'note')
    if (note !== undefined) patch.note = note

    if (Object.keys(patch).length === 0) {
      throw new UserError(3, 'нечего менять: укажите хотя бы одно поле карточки')
    }

    const card = editCard(db, { id, actor: stringFlag(args, 'as') ?? 'owner', patch })
    if (waiverReason) {
      waiveReview(db, { cardId: card.id, actor: 'owner', reason: waiverReason })
    }
    ok(card, `${card.id} изменена: ${card.title}`)
    return 0
  }

  const step = (args: ParsedArgs): number => {
    const action = args.positionals[0]
    const card = requireCard(
      args.positionals[1],
      'использование: board card step add|done|remove|list UI-1 ...',
    )
    const actor = stringFlag(args, 'as')

    if (action === 'add') {
      const text = args.positionals.slice(2).join(' ')
      if (!text) {
        throw new UserError(3, 'использование: board card step add UI-1 "текст шага"')
      }
      const created = addStep(db, { cardId: card.id, text, actor })
      ok(created, `${card.id} · шаг ${created.seq} добавлен: ${created.text}`)
      return 0
    }

    if (action === 'done') {
      const updated = doneStep(db, {
        cardId: card.id,
        seq: positiveNumber(args.positionals[2], 'номер шага'),
        actor,
      })
      ok(
        updated,
        `${card.id} · шаг ${updated.seq} ${updated.done ? 'отмечен' : 'снова открыт'}: ${updated.text}`,
      )
      return 0
    }

    if (action === 'remove') {
      const removed = removeStep(db, {
        cardId: card.id,
        seq: positiveNumber(args.positionals[2], 'номер шага'),
        actor,
      })
      ok(removed, `${card.id} · шаг ${removed.seq} удалён: ${removed.text}`)
      return 0
    }

    if (action === 'list') {
      const steps = listSteps(db, card.id)
      ok(steps, formatSteps(steps, stepProgress(db, card.id)))
      return 0
    }

    throw new UserError(3, 'использование: board card step add|done|remove|list UI-1 ...')
  }

  const ref = (args: ParsedArgs): number => {
    const action = args.positionals[0]
    const card = requireCard(
      args.positionals[1],
      'использование: board card ref add|remove|list UI-1 ...',
    )
    const actor = stringFlag(args, 'as')

    if (action === 'add') {
      const kind = stringFlag(args, 'kind')
      if (!kind) throw new UserError(3, 'нужен --kind link|doc|spec')
      const value = stringFlag(args, 'value')
      if (!value) throw new UserError(3, 'нужен --value «ссылка или путь»')

      const added = addRef(db, {
        cardId: card.id,
        kind: kind as Ref['kind'],
        value,
        title: stringFlag(args, 'title'),
        actor,
      })
      ok(added, `${card.id} · ссылка #${added.id} добавлена: ${added.kind} ${added.value}`)
      return 0
    }

    if (action === 'remove') {
      const removed = removeRef(db, {
        cardId: card.id,
        id: positiveNumber(args.positionals[2], 'номер ссылки'),
        actor,
      })
      ok(removed, `${card.id} · ссылка #${removed.id} удалена: ${removed.value}`)
      return 0
    }

    if (action === 'list') {
      const refs = listRefs(db, card.id)
      ok(refs, formatRefs(refs))
      return 0
    }

    throw new UserError(3, 'использование: board card ref add|remove|list UI-1 ...')
  }

  const dep = (args: ParsedArgs): number => {
    const action = args.positionals[0]
    const card = requireCard(
      args.positionals[1],
      'использование: board card dep add|remove|list UI-1 UI-5',
    )
    const actor = stringFlag(args, 'as') ?? 'owner'
    const reason = stringFlag(args, 'reason')

    if (action === 'add' || action === 'remove') {
      const other = args.positionals[2]
      if (!other) {
        throw new UserError(3, `использование: board card dep ${action} ${card.id} UI-5`)
      }

      if (action === 'add') {
        addDep(db, card.id, other, actor, reason)
        ok({ from: card.id, to: other }, `${card.id} теперь зависит от ${other}`)
      } else {
        removeDep(db, card.id, other, actor, reason)
        ok({ from: card.id, to: other }, `${card.id} больше не зависит от ${other}`)
      }
      return 0
    }

    if (action === 'list') {
      const deps = listDeps(db, card.id)
      ok(deps, formatDeps(db, deps))
      return 0
    }

    throw new UserError(3, 'использование: board card dep add|remove|list UI-1 UI-5')
  }

  const shape = (args: ParsedArgs): number => {
    const id = args.positionals[0]
    if (!id) {
      throw new UserError(3, 'использование: board card shape UI-1 --as developer [--from card.json]')
    }
    const actor = stringFlag(args, 'as')
    if (!actor) throw new UserError(3, 'нужен --as <исполнитель>')

    // Разбираем и проверяем файл до любых изменений: невалидный JSON или
    // новая карточка без группы оставляют карточку в покое.
    const from = stringFlag(args, 'from')
    const file = from ? parseShapeFile(from) : undefined
    const tags = assertKnownTags(db, stringsFlag(args, 'tag'))
    if (file?.tags) assertKnownTags(db, file.tags)
    for (const item of file?.new_cards ?? []) {
      if (item.tags) assertKnownTags(db, item.tags)
    }

    // shape + apply — одна транзакция: ошибка внутри applyShapeFile
    // откатывает и переход в shaping.
    const result = tx(db, () => {
      const shaped = shapeCard(db, { id, actor })
      const applied = file
        ? applyShapeFile(db, { id, actor, file })
        : { card: shaped, newCards: [] as Card[] }
      if (tags.length > 0) {
        applied.card = editCard(db, { id, actor, patch: { tags } })
      }
      return applied
    })

    if (file) {
      const created = result.newCards.length > 0
        ? `; создано: ${result.newCards.map((item) => item.id).join(', ')}`
        : ''
      ok(result, `${result.card.id} разобрана из ${from}${created}`)
      return 0
    }

    ok(result.card, `${result.card.id} в разборе: ${result.card.title}`)
    return 0
  }

  const submit = (args: ParsedArgs): number => {
    const id = args.positionals[0]
    if (!id) throw new UserError(3, 'использование: board card submit UI-1 --as developer')
    const actor = stringFlag(args, 'as')
    if (!actor) throw new UserError(3, 'нужен --as <исполнитель>')

    const existing = requireCard(id, 'board card submit UI-1 --as developer')
    const { gate } = specGate(existing)
    const noDecisions = boolFlag(args, 'no-decisions')
    const card = submitCard(db, { id, actor, requiredSpecReview: gate, noDecisions })
    ok(
      card,
      noDecisions
        ? `${card.id} в очереди без утверждения: решений владельца нет`
        : `${card.id} на утверждении: ${card.title}`,
    )
    return 0
  }

  const specReview = (args: ParsedArgs): number => {
    const id = args.positionals[0]
    if (!id) {
      throw new UserError(
        3,
        'использование: board card spec-review UI-1 --as developer --mode self|subagent --verdict done|reopen',
      )
    }
    const actor = stringFlag(args, 'as')
    if (!actor) throw new UserError(3, 'нужен --as <ревьюер>')
    const mode = stringFlag(args, 'mode')
    if (mode !== 'self' && mode !== 'subagent') {
      throw new UserError(3, 'нужен --mode self|subagent')
    }
    const verdict = stringFlag(args, 'verdict')
    if (verdict !== 'done' && verdict !== 'reopen') {
      throw new UserError(3, 'нужен --verdict done|reopen')
    }

    const card = requireCard(id, 'board card spec-review UI-1 --as developer --mode self --verdict done')
    const { gate } = specGate(card)
    if (gate.mode === 'subagent' && mode !== 'subagent') {
      throw new UserError(2, `spec review для ${id} требует субагента`)
    }
    if (gate.mode === 'subagent' && gate.reviewerModel === null) {
      throw new UserError(2, 'reviewer.model не задан: board setup --reviewer-model или выберите self')
    }

    const review = recordSpecReview(db, {
      cardId: id,
      reviewer: actor,
      mode,
      verdict,
      note: stringFlag(args, 'note'),
    })
    ok(review, `${id} spec review: ${verdict} (${mode})`)
    return 0
  }

  const approve = (args: ParsedArgs): number => {
    const id = args.positionals[0]
    if (!id) throw new UserError(3, 'использование: board card approve UI-1')

    const existing = requireCard(id, 'board card approve UI-1')
    const { gate } = specGate(existing)
    const card = approveCard(db, {
      id,
      actor: stringFlag(args, 'as') ?? 'owner',
      requiredSpecReview: gate,
    })
    ok(card, `${card.id} утверждена: ${card.status}`)
    return 0
  }

  const reject = (args: ParsedArgs): number => {
    const id = args.positionals[0]
    if (!id) throw new UserError(3, 'использование: board card reject UI-1 --reason «...»')

    const card = rejectCard(db, {
      id,
      actor: stringFlag(args, 'as') ?? 'owner',
      reason: stringFlag(args, 'reason') ?? '',
    })
    ok(card, `${card.id} отклонена: ${card.status}`)
    return 0
  }

  const amend = (args: ParsedArgs): number => {
    const id = args.positionals[0]
    if (!id) {
      throw new UserError(3, 'использование: board card amend UI-1 --as developer --reason «...»')
    }
    const actor = stringFlag(args, 'as')
    if (!actor) throw new UserError(3, 'нужен --as <исполнитель>')
    const reason = stringFlag(args, 'reason')
    if (!reason) throw new UserError(3, 'нужна причина: --reason «...»')

    const card = amendCard(db, { id, actor, reason })
    ok(card, `${card.id} снова в разборе: spec_rev ${card.specRev}`)
    return 0
  }

  const done = (args: ParsedArgs): number => {
    const id = args.positionals[0]
    if (!id) throw new UserError(3, 'использование: board card done UI-9 --summary «...»')

    const card = ownerDone(db, {
      id,
      actor: stringFlag(args, 'as') ?? 'owner',
      summary: stringFlag(args, 'summary') ?? '',
    })
    ok(card, `${card.id} закрыта: ${card.title}`)
    return 0
  }

  const cancel = (args: ParsedArgs): number => {
    const id = args.positionals[0]
    if (!id) {
      throw new UserError(
        3,
        'использование: board card cancel UI-1 --reason «...» [--waive-dependents] --as ...',
      )
    }

    const card = cancelCard(db, {
      id,
      actor: stringFlag(args, 'as') ?? 'owner',
      reason: stringFlag(args, 'reason') ?? '',
      waiveDeps: boolFlag(args, 'waive-dependents'),
      root: project.root,
    })
    ok(card, `${card.id} отменена: ${card.title}`)
    return 0
  }

  const reopen = (args: ParsedArgs): number => {
    const id = args.positionals[0]
    if (!id) throw new UserError(3, 'использование: board card reopen UI-1 --reason «...»')

    const card = reopenCard(db, {
      id,
      actor: stringFlag(args, 'as') ?? 'owner',
      reason: stringFlag(args, 'reason') ?? '',
    })
    ok(card, `${card.id} переоткрыта: попытка ${card.attempt}`)
    return 0
  }

  const verdict = (args: ParsedArgs): number => {
    const id = args.positionals[0]
    if (!id) {
      throw new UserError(
        3,
        'использование: board card verdict UI-1 --done|--reopen --note «...» --as reviewer-1',
      )
    }
    const done = boolFlag(args, 'done')
    const reopened = boolFlag(args, 'reopen')
    if (done === reopened) {
      throw new UserError(3, 'укажите ровно одно: --done или --reopen')
    }
    const reviewer = stringFlag(args, 'as')
    if (!reviewer) throw new UserError(3, 'нужен --as <ревьюер>')
    const planCompliance = stringFlag(args, 'plan')
    if (planCompliance !== 'done' && planCompliance !== 'failed') {
      throw new UserError(3, 'нужен --plan done|failed')
    }
    const acceptance = stringFlag(args, 'acceptance')
    if (acceptance !== undefined && acceptance !== 'done' && acceptance !== 'failed') {
      throw new UserError(3, '--acceptance done|failed')
    }
    const requestedMode = stringFlag(args, 'mode')
    if (requestedMode !== undefined && requestedMode !== 'self' && requestedMode !== 'subagent') {
      throw new UserError(3, '--mode self|subagent')
    }
    const card = requireCard(id, 'board card verdict UI-1 --plan done --done --as reviewer-1')
    const run = card.runId ? getRun(db, card.runId) : null
    const mode =
      (requestedMode as 'self' | 'subagent' | undefined) ??
      (run?.reviewMode === 'self' || run?.reviewMode === 'subagent' ? run.reviewMode : undefined)

    const result = submitVerdict(db, {
      cardId: id,
      reviewer,
      verdict: done ? 'done' : 'reopen',
      note: stringFlag(args, 'note') ?? '',
      planCompliance,
      acceptance: acceptance as 'done' | 'failed' | undefined,
      reopensLimit: reviewReopensLimit(settings, reviewContext),
      mode,
    })
    ok(result, `${id} ${result.card.status} · plan ${planCompliance}`)
    return 0
  }

  const scope = (args: ParsedArgs): number => {
    const action = args.positionals[0]
    const usage = 'использование: board card scope add UI-1 src/x.ts [src/y.ts] --as <исполнитель>'
    if (action !== 'add') throw new UserError(3, usage)
    const card = requireCard(args.positionals[1], usage)
    const paths = args.positionals.slice(2)
    if (paths.length === 0) throw new UserError(3, 'нужен хотя бы один путь')
    const updated = addScope(db, {
      id: card.id,
      actor: stringFlag(args, 'as') ?? 'owner',
      paths,
    })
    ok(updated, `${updated.id} · scope: ${updated.scope.join(', ')}`)
    return 0
  }

  const defer = (args: ParsedArgs): number => {
    const card = requireCard(
      args.positionals[0],
      'использование: board card defer UI-1 --as <исполнитель>',
    )
    const updated = deferCard(db, {
      id: card.id,
      actor: stringFlag(args, 'as') ?? 'owner',
      note: stringFlag(args, 'note'),
    })
    ok(updated, `${updated.id} отложена: ${updated.title}`)
    return 0
  }

  const resume = (args: ParsedArgs): number => {
    const card = requireCard(
      args.positionals[0],
      'использование: board card resume UI-1 --as <исполнитель>',
    )
    const updated = resumeCard(db, {
      id: card.id,
      actor: stringFlag(args, 'as') ?? 'owner',
    })
    ok(updated, `${updated.id} возвращена: ${updated.status}`)
    return 0
  }

  try {
    if (args.sub === 'add') return add(args)
    if (args.sub === 'list') return list(args)
    if (args.sub === 'show') return show(args)
    if (args.sub === 'edit') return edit(args)
    if (args.sub === 'step') return step(args)
    if (args.sub === 'ref') return ref(args)
    if (args.sub === 'dep') return dep(args)
    if (args.sub === 'shape') return shape(args)
    if (args.sub === 'submit') return submit(args)
    if (args.sub === 'spec-review') return specReview(args)
    if (args.sub === 'approve') return approve(args)
    if (args.sub === 'amend') return amend(args)
    if (args.sub === 'reject') return reject(args)
    if (args.sub === 'verdict') return verdict(args)
    if (args.sub === 'done') return done(args)
    if (args.sub === 'cancel') return cancel(args)
    if (args.sub === 'reopen') return reopen(args)
    if (args.sub === 'defer') return defer(args)
    if (args.sub === 'scope') return scope(args)
    if (args.sub === 'resume') return resume(args)
    if (args.sub === 'tag') return tag(args)
    throw new UserError(
      3,
      'использование: board card add|list|show|edit|step|ref|dep|shape|submit|spec-review|approve|amend|reject|verdict|done|cancel|reopen|defer|resume|scope|tag',
    )
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

/** Читает и разбирает JSON пакетного разбора §10.1; ошибка — код 3. */
function parseShapeFile(path: string): ShapeFile {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    throw new UserError(3, `файл ${path} не найден`)
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new UserError(3, `файл ${path}: невалидный JSON`)
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new UserError(3, `файл ${path}: ожидался объект JSON`)
  }
  if ('steps' in parsed) {
    throw new UserError(3, `файл ${path}: steps пишутся при take, не при shape`)
  }

  const file = parsed as ShapeFile
  // Минимальная проверка до изменения карточки: новая карточка без группы
  // не должна оставлять карточку в shaping.
  for (const item of file.new_cards ?? []) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      throw new UserError(3, 'new_cards: каждая запись — объект')
    }
    if (typeof item.group !== 'string' || !item.group.trim()) {
      throw new UserError(3, 'у новой карточки нет группы')
    }
    if (typeof item.title !== 'string' || !item.title.trim()) {
      throw new UserError(3, `новая карточка в ${item.group}: нет title`)
    }
    for (const field of ['acceptance', 'scope', 'tags'] as const) {
      const value = item[field]
      if (value !== undefined && (!Array.isArray(value) || value.some((row) => typeof row !== 'string'))) {
        throw new UserError(3, `новая карточка ${item.key ?? item.group}: ${field} — массив строк`)
      }
    }
    for (const field of ['spec', 'body', 'skill'] as const) {
      const value = item[field]
      if (value !== undefined && typeof value !== 'string') {
        throw new UserError(3, `новая карточка ${item.key ?? item.group}: ${field} — строка`)
      }
    }
  }
  return file
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

function positiveNumber(raw: string | undefined, label: string): number {
  const value = Number(raw)
  if (raw === undefined || raw.trim() === '' || !Number.isInteger(value) || value < 1) {
    throw new UserError(3, `${label} — целое число от 1`)
  }
  return value
}

function value(text: string | number | null): string {
  return text === null || text === '' ? '—' : String(text)
}

function shortTime(iso: string): string {
  return iso.slice(0, 16).replace('T', ' ')
}

function formatCard(
  db: DatabaseSync,
  card: Card,
  deps: string[],
  steps: Step[],
  refs: Ref[],
  discussion: Discussion[],
  events: EventRecord[],
): string {
  const lines = [
    `${card.id} · ${card.title}`,
    `статус: ${card.status} · фаза: ${card.phase} · навык: ${value(card.skill)}`,
    `важность: ${value(card.importance)} · срочность: ${value(card.urgency)}`,
    `мерж: ${card.needsMerge ? 'да' : 'нет'} · ревью: ${card.reviewRequired ? 'да' : 'нет'}`,
    `scope: ${card.scope.length > 0 ? card.scope.join(', ') : '-'}`,
    `tags: ${card.tags.length > 0 ? card.tags.join(', ') : '-'}`,
  ]
  if (card.note !== null && card.note !== '') lines.push(`заметка: ${card.note}`)
  if (card.body !== '') lines.push('', card.body)
  if (card.acceptance !== '') {
    lines.push('', 'КРИТЕРИИ ПРИЁМКИ', ...card.acceptance.split('\n').map((line) => `  - ${line}`))
  }

  lines.push('', formatDeps(db, deps))
  lines.push('', formatSteps(steps, progressOf(steps)))
  lines.push('', formatRefs(refs))
  lines.push('', formatDiscussion(discussion))
  lines.push('', formatEvents(events))
  return lines.join('\n')
}

function formatDeps(db: DatabaseSync, deps: string[]): string {
  const lines = ['ЗАВИСИМОСТИ']
  if (deps.length === 0) lines.push('  зависимостей нет')
  for (const id of deps) {
    const card = getCard(db, id)
    if (!card) {
      lines.push(`  ${id} · не найдена`)
      continue
    }
    const satisfied = isSatisfied(db, id) ? 'закрыта' : 'не закрыта'
    lines.push(`  ${id} · ${card.status} · ${satisfied}`)
  }
  return lines.join('\n')
}

function progressOf(steps: Step[]): { done: number; total: number } {
  return { done: steps.filter((step) => step.done).length, total: steps.length }
}

function formatSteps(steps: Step[], progress: { done: number; total: number }): string {
  const lines = [`ШАГИ (${progress.done}/${progress.total})`]
  if (steps.length === 0) lines.push('  шагов нет')
  for (const step of steps) {
    lines.push(`  ${step.done ? '[x]' : '[ ]'} ${step.seq}. ${step.text}`)
  }
  return lines.join('\n')
}

function formatRefs(refs: Ref[]): string {
  const lines = ['ССЫЛКИ']
  if (refs.length === 0) lines.push('  ссылок нет')
  for (const ref of refs) {
    const title = ref.title === null ? '' : ` — ${ref.title}`
    lines.push(`  ${ref.id}. ${ref.kind} ${ref.value}${title}`)
  }
  return lines.join('\n')
}

function formatDiscussion(discussion: Discussion[]): string {
  const lines = ['ОБСУЖДЕНИЕ']
  if (discussion.length === 0) lines.push('  обсуждения нет')
  for (const item of discussion) {
    if (item.kind === 'answer') {
      lines.push(
        `  ответ #${item.id} → вопрос #${value(item.answerTo)} · ${item.author} · ${shortTime(item.createdAt)}`,
      )
    } else if (item.kind === 'question') {
      lines.push(
        `  вопрос #${item.id} · ${item.author} · ${shortTime(item.createdAt)} · ${item.status}`,
      )
    } else {
      lines.push(`  ${item.kind} #${item.id} · ${item.author} · ${shortTime(item.createdAt)}`)
    }
    lines.push(`      ${item.text}`)
  }
  return lines.join('\n')
}

function formatEvents(events: EventRecord[]): string {
  const lines = ['ЖУРНАЛ']
  if (events.length === 0) lines.push('  событий нет')
  for (const event of events) {
    const note = event.note === null ? '' : ` — ${event.note}`
    lines.push(`  ${shortTime(event.at)} ${event.type} ${event.actor}${note}`)
  }
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
