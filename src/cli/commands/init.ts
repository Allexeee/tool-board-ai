import { initProject } from '../../core/project.ts'
import type { ParsedArgs } from '../args.ts'
import { ok } from '../output.ts'

export default async function command(args: ParsedArgs) {
  const dir = args.positionals[0] ?? process.cwd()
  const { created, root } = initProject(dir)

  const lines =
    created.length > 0
      ? ['Создано:', ...created.map((path) => '  ' + path)]
      : ['Доска уже настроена, ничего не менялось.']
  lines.push('', 'Проект: ' + root)

  ok({ root, created }, lines.join('\n'))
  return 0
}
