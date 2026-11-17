import { findProject } from '../../core/project.ts'
import { openDb } from '../../core/db.ts'
import { formatDigest, reviewDigest } from '../../core/digest.ts'
import { submitReview, type Verdict } from '../../core/reviews.ts'
import { stringFlag, type ParsedArgs } from '../args.ts'
import { ok } from '../output.ts'
import { UserError } from '../errors.ts'

export default async function command(args: ParsedArgs) {
  const project = findProject(process.cwd())
  if (!project) throw new UserError(3, 'проект не найден: выполните toolbox-al init')
  const db = openDb(project.dbPath)

  // digest — не вердикт, а карта ревью: что не выпущено и что в этом опасного
  if (args.positionals[0] === 'digest') {
    const stages = reviewDigest(db, { root: project.root, config: project.config })
    ok(stages, formatDigest(stages))
    return 0
  }

  const taskId = args.positionals[0]
  const reviewer = stringFlag(args, 'as')
  const verdict = stringFlag(args, 'verdict') as Verdict | undefined
  if (!taskId || !reviewer || !verdict) {
    throw new UserError(
      3,
      'использование: review digest | review F1.S1-1 --as w2 --verdict approved|rejected [--note]',
    )
  }

  const review = submitReview(db, { taskId, reviewer, verdict, note: stringFlag(args, 'note') })
  ok(review, `${review.taskId}  ${review.verdict}${review.comments ? ': ' + review.comments : ''}`)
  return 0
}
