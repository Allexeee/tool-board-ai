import { initProject } from '../../core/project.ts'

export function runInit(dir: string): string {
  const { created, root } = initProject(dir)

  const lines: string[] = []
  lines.push(created.length > 0 ? 'Создано: ' + created.join(', ') : 'Настройка уже существует, ничего не менялось.')
  lines.push('')
  lines.push('Первичную настройку выполняет агент — он знает проект, CLI нет.')
  lines.push('')
  lines.push('В OpenCode скажите оркестратору:')
  lines.push('  «выполни первичную настройку toolbox-al»')
  lines.push('')
  lines.push('Проект: ' + root)

  return lines.join('\n')
}

export default async function command(args: { flags: Record<string, unknown>; positionals: string[] }) {
  const dir = args.positionals[0] ?? process.cwd()
  process.stdout.write(runInit(dir) + '\n')
  return 0
}
