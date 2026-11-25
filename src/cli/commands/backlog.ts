import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { writeBacklog, writeBacklogHtml } from '../../core/backlog.ts'
import { openDb } from '../../core/db.ts'
import { findProject } from '../../core/project.ts'
import { readSettings } from '../../core/settings.ts'
import { boolFlag, stringFlag, type ParsedArgs } from '../args.ts'
import { UserError } from '../errors.ts'
import { ok } from '../output.ts'

/** Открывалка страницы: системный браузер. BOARD_OPEN=echo — только печать URL. */
function openInBrowser(url: string): { error?: string } {
  if (process.env.BOARD_OPEN === 'echo') return {}

  const command =
    process.platform === 'win32' ? 'cmd' : process.platform === 'darwin' ? 'open' : 'xdg-open'
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url]
  const result = spawnSync(command, args, { stdio: 'ignore', windowsHide: true })
  if (result.error) return { error: result.error.message }
  if (result.status !== 0) return { error: `код ${result.status ?? '—'}` }
  return {}
}

export default async function command(args: ParsedArgs) {
  const project = findProject(process.cwd())
  if (!project) throw new UserError(3, 'проект не найден: выполните board init')

  const settings = readSettings(project.root)
  const out = stringFlag(args, 'out')
  if (out) settings.backlog = { ...settings.backlog, path: out }

  const db = openDb(project.dbPath, { allowOutdated: true, allowNewer: true })
  try {
    const open = boolFlag(args, 'open')
    const htmlOnly = boolFlag(args, 'html') || open
    const path = htmlOnly
      ? writeBacklogHtml(db, project.root, settings)
      : writeBacklog(db, project.root, settings)
    if (!open) {
      ok({ path }, `бэклог собран: ${path}`)
      return 0
    }

    const url = pathToFileURL(path).href
    const opened = openInBrowser(url)
    if (opened.error) {
      ok(
        { path, url, opened: false, error: opened.error },
        `бэклог собран: ${path}\nоткрыть вручную: ${url}\nбраузер не открылся: ${opened.error}`,
      )
      return 0
    }

    ok({ path, url, opened: true }, `бэклог открыт: ${url}`)
    return 0
  } finally {
    db.close()
  }
}
