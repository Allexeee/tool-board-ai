#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseArgs, boolFlag } from '../src/cli/args.ts'
import { setJsonMode } from '../src/cli/output.ts'
import { UserError } from '../src/cli/errors.ts'
import { findLocalBoardCli, findProjectRootForCli } from '../src/core/git.ts'

const VERSION = (JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as { version?: string }).version ?? '0.0.0'

const HELP = `board — доска карточек для людей и агентов

  init [каталог] [--yes] [--refresh]
                          создать .board/board.db и docs/board/; --refresh
                          перезаписывает сгенерированные .opencode-файлы
  upgrade <ref>|--latest [--allow-downgrade]
                          переключить tools/board на другую версию
  setup                   мастер настроек: --show, --review-after-run,
                          --no-review-after-run

  executor add|list|edit|remove
  group list|add|rename     области проекта (префиксы карточек)
  card add|list|show|edit  карточки
  card shape|submit|spec-review|approve|amend|reject|verdict
  card done|cancel|reopen|defer|resume
  card scope add <ID> <path>
  card step add|done|remove|list
  card ref add|remove|list
  card dep add|remove|list
  queue move|reorder
  run start|add|drop|next|end|release|note|list
  take / finish / block / touch
  ask / answer
  decision add|list|supersede|obsolete
  term add|list|show
  command add|list
  review list|package|finding|submit|waive
  idea add|list|edit|drop   идеи: карточки вне очереди, мержа и ревью
  tag add|list|rename|remove  реестр тегов карточек
  release [--package <executor|skill>] [--no-review --reason "..."] / now / doctor / backup / export / sync
  backlog [--out <path>] [--html] [--open]  md- или html-бэклог; --open — в браузере

  --json                  машинный вывод
  --version               версия инструмента
  --as <id>               кто действует (журнал и проверки)
  --scope <path>          файлы, которые карточке разрешено менять
  --acceptance "..."      критерий приёмки (можно несколько)
  --tag <tag>             тег карточки: new, improve, review
  --review / --no-review  обязательное ревью после finish
  --importance 0..3       важность
  --urgency 0..3          срочность

  «board card add --help» и подобные печатают справку по подкоманде.

  коды выхода: 0 — успех, 1 — делать нечего, 2 — нужно решение, 3 — ошибка ввода
`

const COMMAND_HELP: Record<string, string> = {
  'card add':
    'board card add [--group <P>] --title "<тип: заголовок>" --skill <s> [--new-group] [--spec "..."] [--acceptance "..."] [--tag new] [--importance 0..3] [--urgency 0..3] [--scope <path>] [--review|--no-review --reason "..."] [--no-needs-merge] [--as <id>]',
  'card edit':
    'board card edit <ID> [--title ...] [--spec ...] [--acceptance ...] [--scope <path>] [--importance 0..3] [--urgency 0..3] [--review|--no-review] [--needs-merge|--no-needs-merge] [--tag ...|--clear-tags] [--as <id>]',
  'card shape': 'board card shape <ID> --as <исполнитель> [--from card.json]',
  'card submit': 'board card submit <ID> --as <исполнитель> [--no-decisions]',
  'card spec-review':
    'board card spec-review <ID> --as <ревьюер> --mode self|subagent --verdict done|reopen --note "..."',
  'card approve': 'board card approve <ID>',
  'card reopen': 'board card reopen <ID> --reason "..."',
  'card step': 'board card step add <ID> "текст" | done <ID> <n> | remove <ID> <n> | list <ID>',
  'card scope': 'board card scope add <ID> <path> [<path>...] --as <исполнитель>',
  'take': 'board take <ID> --as <исполнитель>',
  'finish': 'board finish <ID> --as <исполнитель> --summary "..." [--no-merge] [--merge-commit <sha>]',
  'run start': 'board run start --as <исполнитель> (--cards ID,ID | --suggest 1|2|3)',
  'run note': 'board run note <RUN> --text "..." --as <ревьюер>',
  'queue move': 'board queue move <ID> --before <ID> | --top | --bottom',
  'group add': 'board group add <PREFIX> [--name <название>] [--as <id>]',
  'group rename':
    'board group rename <OLD> <NEW> [--merge] [--name <название>] [--dry-run] [--as <id>]',
  'review submit':
    'board review submit <ID> --plan done|failed [--acceptance done|failed] --verdict done|reopen --reviewer <id> --note "..."',
  'review package':
    'board review package [--since <ref>] [--verdict done|reopen --reviewer <id> --note "..." --findings findings.json]',
  'review waive': 'board review waive <ID> --reason "..." --as owner',
  'idea add': 'board idea add "текст" [--title "..."] [--as <id>]',
  'idea list': 'board idea list [--json]',
  'idea edit': 'board idea edit <ID> [--text "..."] [--title "..."] [--as <id>]',
  'idea drop': 'board idea drop <ID> [--as <id>]',
  'tag add': 'board tag add <name> [--description "..."] [--as <id>]',
  'tag list': 'board tag list [--json]',
  'tag rename': 'board tag rename <old> <new> [--as <id>]',
  'tag remove': 'board tag remove <name> [--as <id>]',
  'card tag': 'board card tag add|remove|list <ID> [тег] [--as <id>]',
  'release': 'board release [--package <executor|skill>] [--no-review --reason "..."] --as owner',
  setup:
    'board setup [--show] [--defaults] [--profile auto|low|default|high|max|custom] [--spec-review auto|none|self|subagent] [--max-spec N] [--large-spec N] [--branch-main NAME] [--branch-dev NAME] [--sync <git-url>] [--backlog-path <path>] [--backlog-refresh <sec>] [--backlog-auto|--no-backlog-auto] [--run-review ...] [--reviewer-model provider/model]',
  backup: 'board backup [path]',
  export: 'board export [--format json|md] [--out path] [--md]',
  'sync push': 'board sync push — копия базы в приватный git',
  'sync pull': 'board sync pull — обновить базу из приватного git (с бэкапом .pre-pull)',
  backlog:
    'board backlog [--out <path>] [--html] [--open] — md или HTML-снимок; --open открывает в браузере (BOARD_OPEN=echo — только URL)',
}

async function main(argv: string[]): Promise<number> {
  const args = parseArgs(argv)
  if (boolFlag(args, 'json')) setJsonMode(true)

  if (boolFlag(args, 'help') || args.command === 'help') {
    const key = args.sub ? `${args.command} ${args.sub}` : args.command
    const text = COMMAND_HELP[key] ?? HELP
    process.stdout.write(text.endsWith('\n') ? text : text + '\n')
    return 0
  }

  if (boolFlag(args, 'version') || args.command === 'version') {
    process.stdout.write(VERSION + '\n')
    return 0
  }

  const module = await loadCommand(args.command)
  if (!module) throw new UserError(3, `неизвестная команда ${args.command}`)
  return (await module.default(args)) ?? 0
}

const COMMANDS_DIR = fileURLToPath(new URL('../src/cli/commands/', import.meta.url))

async function loadCommand(command: string) {
  if (!command) return null
  const file = join(COMMANDS_DIR, `${command}.ts`)
  if (!existsSync(file)) return null

  try {
    return await import(pathToFileURL(file).href)
  } catch (error) {
    if ((error as { code?: string }).code !== 'ERR_MODULE_NOT_FOUND') throw error
    throw new UserError(
      3,
      `команда ${command} не загрузилась: её модуль не найден — ${(error as Error).message}`,
    )
  }
}

const rawArgs = process.argv.slice(2)
const globalFlag = rawArgs.includes('--global')
const argv = rawArgs.filter((arg) => arg !== '--global')
const allowGlobal = process.env.BOARD_ALLOW_GLOBAL === '1'
const self = realpathSync(fileURLToPath(import.meta.url))
const projectRoot = findProjectRootForCli(process.cwd())
const local = projectRoot ? findLocalBoardCli(projectRoot) : null
const installerOverride = argv[0] === 'init' && argv.includes('--board-version')

if (
  !globalFlag &&
  !allowGlobal &&
  !process.env.BOARD_DELEGATED &&
  local &&
  realpathSync(local) !== self &&
  !installerOverride
) {
  const result = spawnSync(process.execPath, [local, ...argv], {
    stdio: 'inherit',
    env: { ...process.env, BOARD_DELEGATED: '1' },
    windowsHide: true,
  })
  process.exit(result.status ?? 3)
}

if (!globalFlag && !allowGlobal && !process.env.BOARD_DELEGATED && !local) {
  const command = argv[0]
  const allowed =
    command === undefined ||
    ['init', 'doctor', 'help', 'version'].includes(command) ||
    argv.includes('--version') ||
    argv.includes('--help')
  if (!allowed) {
    process.stderr.write('board не установлен: выполните board init\n')
    process.exit(2)
  }
}

/** Команды, после которых бэклог заведомо не меняется. */
const NO_BACKLOG_FLUSH = new Set([
  'init',
  'backlog',
  'doctor',
  'now',
  'help',
  'version',
  'export',
  'backup',
])

/**
 * После успешной команды проверяет отметку бэклога и пересобирает файлы,
 * если доска изменилась. Ошибка пересборки — предупреждение, не код выхода.
 */
async function flushBacklogAfterCommand(argv: string[]): Promise<void> {
  const command = argv[0]
  if (!command || NO_BACKLOG_FLUSH.has(command)) return
  try {
    const { findProject } = await import('../src/core/project.ts')
    const project = findProject(process.cwd())
    if (!project) return
    const { openDb } = await import('../src/core/db.ts')
    const { flushBacklog } = await import('../src/core/backlog.ts')
    const db = openDb(project.dbPath, { allowOutdated: true, allowNewer: true })
    try {
      const result = flushBacklog(db, project.root)
      if (result.error) {
        process.stderr.write('бэклог не пересобран: ' + result.error + '\n')
      }
    } finally {
      db.close()
    }
  } catch (error) {
    process.stderr.write('бэклог не пересобран: ' + (error as Error).message + '\n')
  }
}

try {
  const code = await main(argv)
  if (code === 0) await flushBacklogAfterCommand(argv)
  process.exitCode = code
} catch (error) {
  if (error instanceof UserError) {
    process.stderr.write(error.message + '\n')
    process.exitCode = error.code
  } else {
    process.stderr.write(String((error as Error)?.stack ?? error) + '\n')
    process.exitCode = 3
  }
}
