import { findProject } from '../../core/project.ts'
import { addOwnerCommand, listOwnerCommands, type OwnerCommand } from '../../core/terminology.ts'
import { stringFlag, type ParsedArgs } from '../args.ts'
import { UserError } from '../errors.ts'
import { ok } from '../output.ts'

export default async function command(args: ParsedArgs) {
  const project = findProject(process.cwd())
  if (!project) throw new UserError(3, 'проект не найден: выполните board init')

  const add = (args: ParsedArgs): number => {
    const command = args.positionals[0]?.trim()
    const action = args.positionals.slice(1).join(' ').trim()
    if (!command || !action) {
      throw new UserError(3, 'использование: board command add «RUN» «начать забег» --as owner')
    }

    const result = addOwnerCommand(project.root, {
      command,
      action,
      author: stringFlag(args, 'as') ?? 'owner',
    })
    ok(
      result,
      result.duplicate
        ? `команда «${command}» уже есть — строка добавлена`
        : `команда «${command}» добавлена`,
    )
    return 0
  }

  const list = (): number => {
    const commands = listOwnerCommands(project.root)
    ok(commands, formatCommands(commands))
    return 0
  }

  if (args.sub === 'add') return add(args)
  if (args.sub === 'list') return list()
  throw new UserError(3, 'использование: board command add|list')
}

function formatCommands(commands: OwnerCommand[]): string {
  if (commands.length === 0) return 'команд владельца нет'
  return commands.map((c) => `${c.command} — ${c.action}`).join('\n')
}
