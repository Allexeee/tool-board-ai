import { findProject, runLocalInit } from '../../core/project.ts'
import {
  boardSubmoduleSource,
  checkoutBoardRef,
  currentBoardVersion,
  latestBoardTag,
} from '../../core/git.ts'
import {
  collectWhatsNew,
  markAnnouncedVersion,
  readAnnouncedVersion,
  whatsNewDir,
  whatsNewLines,
} from '../../core/whats-new.ts'
import { boolFlag, type ParsedArgs } from '../args.ts'
import { UserError } from '../errors.ts'
import { ok } from '../output.ts'

export default async function command(args: ParsedArgs) {
  const project = findProject(process.cwd())
  if (!project) throw new UserError(3, 'проект не найден: выполните board init')

  const explicit = args.positionals[0]
  const latest = boolFlag(args, 'latest')
  if (explicit && latest) throw new UserError(3, 'укажите ref или --latest, но не оба')

  const source = boardSubmoduleSource(project.root)
  if (latest && !source) throw new UserError(2, 'tools/board не submodule: выполните board init')
  const ref = explicit ?? (latest ? latestBoardTag(source!) : null)
  if (!ref) throw new UserError(3, 'использование: board upgrade <ref>|--latest [--allow-downgrade]')

  const allowDowngrade = boolFlag(args, 'allow-downgrade')
  if (allowDowngrade) {
    process.stderr.write(
      'внимание: даунгрейд может не открыть более новую схему .board/board.db; сделайте бэкап базы\n',
    )
  }

  // Заметки читаем уже из новой версии, а точку отсчёта берём до checkout:
  // последнюю показанную или установленную версию.
  const from = readAnnouncedVersion(project.root) ?? currentBoardVersion(project.root)
  checkoutBoardRef(project.root, ref, { allowDowngrade })
  const result = runLocalInit(project.root)

  const to = currentBoardVersion(project.root)
  const whatsNew = collectWhatsNew(from, to, whatsNewDir(project.root))
  markAnnouncedVersion(project.root, to ?? '')

  ok(
    {
      root: project.root,
      ref,
      boardVersion: to,
      from: whatsNew.from,
      to: whatsNew.to,
      whatsNew: whatsNew.whatsNew,
      created: result.created,
      updated: result.updated,
    },
    [
      `tools/board → ${ref} (${to ?? '?'})`,
      `Создано: ${result.created.length}, обновлено: ${result.updated.length}`,
      '',
      ...whatsNewLines(whatsNew),
    ].join('\n'),
  )
  return 0
}
