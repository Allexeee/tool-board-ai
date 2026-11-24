import { createServer } from 'node:http'
import { execFile } from 'node:child_process'
import { buildBacklog, writeBacklog } from '../../core/backlog.ts'
import { renderBacklogHtml } from '../../core/backlog-view.ts'
import { openDb } from '../../core/db.ts'
import { findProject } from '../../core/project.ts'
import { readSettings } from '../../core/settings.ts'
import { boolFlag, numberFlag, stringFlag, type ParsedArgs } from '../args.ts'
import { UserError } from '../errors.ts'
import { ok } from '../output.ts'

const DEFAULT_PORT = 4317

export default async function command(args: ParsedArgs) {
  const project = findProject(process.cwd())
  if (!project) throw new UserError(3, 'проект не найден: выполните board init')

  const settings = readSettings(project.root)
  const out = stringFlag(args, 'out')
  if (out) settings.backlog = { ...settings.backlog, path: out }

  const db = openDb(project.dbPath, { allowOutdated: true, allowNewer: true })

  if (boolFlag(args, 'serve')) {
    return serve(db, args)
  }

  try {
    const path = writeBacklog(db, project.root, settings)
    ok({ path }, `бэклог собран: ${path}`)
    return 0
  } finally {
    db.close()
  }
}

async function serve(db: ReturnType<typeof openDb>, args: ParsedArgs): Promise<number> {
  const port = numberFlag(args, 'port') ?? DEFAULT_PORT
  const server = createServer((request, response) => {
    const url = request.url ?? '/'
    if (url.startsWith('/data.json')) {
      const body = JSON.stringify(buildBacklog(db))
      response.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
      })
      response.end(body)
      return
    }
    response.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
    })
    response.end(renderBacklogHtml())
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => resolve())
  })

  const url = `http://127.0.0.1:${port}/`
  ok({ url }, `бэклог: ${url} (Ctrl+C — остановить)`)
  if (boolFlag(args, 'open')) openBrowser(url)

  await new Promise<void>((resolve) => {
    const stop = () => resolve()
    process.once('SIGINT', stop)
    process.once('SIGTERM', stop)
  })
  await new Promise<void>((resolve) => server.close(() => resolve()))
  db.close()
  return 0
}

function openBrowser(url: string): void {
  const command =
    process.platform === 'win32' ? 'cmd' : process.platform === 'darwin' ? 'open' : 'xdg-open'
  const argv = process.platform === 'win32' ? ['/c', 'start', '', url] : [url]
  try {
    const child = execFile(command, argv, { windowsHide: true })
    child.unref()
  } catch {
    // браузер — удобство, а не часть работы сервера
  }
}
