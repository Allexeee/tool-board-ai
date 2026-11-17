import { initProject } from '../../core/project.ts'
import { branchExists, isRepo, runGit } from '../../core/git/git.ts'
import { boolFlag, type ParsedArgs } from '../args.ts'

const PLAN = [
  '.toolbox-al/config.json и tracker.db',
  '.opencode/plugins/toolbox-al/index.ts',
  '.opencode/skills/toolbox-al/SKILL.md',
  '.opencode/skills/toolbox-al-setup/SKILL.md',
  'блок в AGENTS.md между маркерами',
  'записи .toolbox-al/ и .worktrees/ в .gitignore',
  'pre-commit хук, если это git-репозиторий',
]

export function runInit(dir: string, options: { dryRun?: boolean } = {}): string {
  if (options.dryRun) {
    return ['Ничего не изменено. Было бы создано:', ...PLAN.map((line) => '  - ' + line)].join('\n')
  }

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

  if (isRepo(root) && !branchExists(root, 'dev')) {
    lines.push('')
    lines.push('Ветки dev нет: создайте её перед первой фичей — git branch dev')
  }

  if (isRepo(root) && runGit(root, ['status', '--porcelain']).length > 0) {
    lines.push('')
    lines.push('Скелет инструмента ещё не закоммичен. Закоммитьте его, чтобы первая задача не спотыкалась:')
    lines.push('  git add .gitignore AGENTS.md .opencode .toolbox-al && git commit -m "toolbox-al: init"')
  }

  return lines.join('\n')
}

export default async function command(args: ParsedArgs) {
  const dir = args.positionals[0] ?? process.cwd()
  process.stdout.write(runInit(dir, { dryRun: boolFlag(args, 'dry-run') }) + '\n')
  return 0
}


