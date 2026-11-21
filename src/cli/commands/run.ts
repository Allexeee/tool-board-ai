import {
  addToRun,
  dropFromRun,
  endRun,
  getActiveRun,
  listRunCards,
  listRuns,
  nextCard,
  reclaimExpired,
  releaseRun,
  startRun,
  suggestRuns,
} from '../../core/runs.ts'
import { getCard } from '../../core/cards.ts'
import { openDb } from '../../core/db.ts'
import { findProject } from '../../core/project.ts'
import { readSettings } from '../../core/settings.ts'
import type { Run } from '../../core/types.ts'
import {
  boolFlag,
  numberFlag,
  stringFlag,
  stringsFlag,
  type ParsedArgs,
} from '../args.ts'
import { UserError } from '../errors.ts'
import { fail, ok } from '../output.ts'

const USAGE =
  'использование: board run start --as developer --cards UI-1,UI-2 | --suggest 1; ' +
  'run add|drop UI-1 --as developer; run next --as developer; ' +
  'run end --as developer [--review|--no-review]; run release RUN-1 --reason "..."; run list'

export default async function command(args: ParsedArgs) {
  const project = findProject(process.cwd())
  if (!project) throw new UserError(3, 'проект не найден: выполните board init')
  const db = openDb(project.dbPath)

  // Любая команда забега снимает просроченные lease (§8.5).
  reclaimExpired(db)

  const actorOf = (args: ParsedArgs): string => {
    const actor = stringFlag(args, 'as')
    if (!actor) throw new UserError(3, 'нужен --as <исполнитель>')
    return actor
  }

  const cardArgument = (args: ParsedArgs, usage: string): string => {
    const id = args.positionals[0]
    if (!id) throw new UserError(3, `использование: ${usage}`)
    return id
  }

  const start = (args: ParsedArgs): number => {
    const executorId = actorOf(args)
    const cardFlags = stringsFlag(args, 'cards')
      .flatMap((value) => value.split(','))
      .map((id) => id.trim())
      .filter(Boolean)
    const suggest = args.flags['suggest'] === undefined ? undefined : numberFlag(args, 'suggest')

    if ((cardFlags.length === 0) === (suggest === undefined)) {
      throw new UserError(3, 'укажите одно из: --cards UI-1,UI-2 или --suggest 1')
    }

    let cardIds: string[]
    if (suggest !== undefined) {
      if (suggest < 1) throw new UserError(3, '--suggest — целое число от 1')
      const [suggestion] = suggestRuns(db, executorId, suggest)
      if (!suggestion) fail(1, 'подходящих карточек нет: забег не начат')
      cardIds = suggestion.cards.map((card) => card.id)
    } else {
      cardIds = cardFlags
    }

    const run = startRun(db, { executorId, cardIds, actor: executorId })
    ok(run, `${run.id} · ${run.executorId} · ${cardIds.join(', ')}`)
    return 0
  }

  const add = (args: ParsedArgs): number => {
    const executorId = actorOf(args)
    const cardId = cardArgument(args, 'board run add UI-12 --as developer')
    addToRun(db, { executorId, cardId, actor: executorId })

    const run = getActiveRun(db, executorId)!
    const card = getCard(db, cardId)!
    ok({ run, card }, `${card.id} добавлена в ${run.id}`)
    return 0
  }

  const drop = (args: ParsedArgs): number => {
    const executorId = actorOf(args)
    const cardId = cardArgument(args, 'board run drop UI-12 --as developer')
    dropFromRun(db, { executorId, cardId, actor: executorId })

    const run = getActiveRun(db, executorId)!
    const card = getCard(db, cardId)!
    ok({ run, card }, `${card.id} снята с ${run.id}: снова ${card.status}`)
    return 0
  }

  const next = (args: ParsedArgs): number => {
    const executorId = actorOf(args)
    const card = nextCard(db, { executorId })
    if (!card) {
      const run = getActiveRun(db, executorId)
      fail(
        1,
        run
          ? `в забеге ${run.id} нет доступных карточек`
          : `у исполнителя ${executorId} нет активного забега`,
      )
    }
    ok(card, `${card.id} · ${card.title}`)
    return 0
  }

  const end = (args: ParsedArgs): number => {
    const executorId = actorOf(args)
    const run = getActiveRun(db, executorId)
    if (!run) {
      throw new UserError(3, `у исполнителя ${executorId} нет активного забега`)
    }

    const count = listRunCards(db, run.id).length
    const strictBoolean = (name: string): boolean => {
      const value = args.flags[name]
      if (value === undefined) return false
      if (value === true) return true
      throw new UserError(3, `флаг --${name} не принимает значение`)
    }
    const reviewFlag = strictBoolean('review')
    const noReviewFlag = strictBoolean('no-review')
    if (reviewFlag && noReviewFlag) {
      throw new UserError(3, 'укажите только один флаг: --review или --no-review')
    }
    const explicitReview = reviewFlag ? true : noReviewFlag ? false : undefined
    const review = explicitReview ?? readSettings(project.root).runReview.mode !== 'none'
    const ended = endRun(db, { executorId, actor: executorId, review })

    const human = [
      `${ended.id} закрыт · карточек ${count}`,
      ended.review
        ? 'ревью включено: выполните board review list или /review'
        : 'ревью после забега выключено',
    ].join('\n')
    ok(ended, human)
    return 0
  }

  const release = (args: ParsedArgs): number => {
    const runId = cardArgument(args, 'board run release RUN-1 --reason "..."')
    const reason = stringFlag(args, 'reason')
    if (reason === undefined) {
      throw new UserError(3, 'нужна причина снятия забега: --reason «...»')
    }

    const released = releaseRun(db, {
      runId,
      actor: stringFlag(args, 'as') ?? 'owner',
      reason,
    })
    ok(released, `${released.id} снят · причина: ${released.note}`)
    return 0
  }

  const list = (): number => {
    const runs = listRuns(db).map((run) => ({
      ...run,
      cards: listRunCards(db, run.id),
    }))
    ok(runs, runs.length === 0 ? 'забегов нет' : runs.map(formatRun).join('\n'))
    return 0
  }

  try {
    if (args.sub === 'start') return start(args)
    if (args.sub === 'add') return add(args)
    if (args.sub === 'drop') return drop(args)
    if (args.sub === 'next') return next(args)
    if (args.sub === 'end') return end(args)
    if (args.sub === 'release') return release(args)
    if (args.sub === 'list') return list()
    throw new UserError(3, USAGE)
  } finally {
    db.close()
  }
}

function formatRun(run: Run & { cards: Array<{ cardId: string }> }): string {
  const cards = run.cards.length === 0 ? '—' : run.cards.map((card) => card.cardId).join(', ')
  return `  ${run.id.padEnd(7)} ${run.status.padEnd(14)} ${run.executorId.padEnd(12)} ${cards}`
}
