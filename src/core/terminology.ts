import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { UserError } from '../cli/errors.ts'
import { nowIso } from './clock.ts'
import { withFileLock } from './lock.ts'

export interface Term {
  term: string
  definition: string
  example: string
  author: string
  date: string
}

export interface OwnerCommand {
  command: string
  action: string
}

export interface AddResult {
  added: boolean
  duplicate: boolean
}

const DOC = 'terminology.md'
const TERMS_SECTION = '## Термины'
const COMMANDS_SECTION = '## Команды владельца'

const INITIAL = [
  '# Терминология',
  '',
  TERMS_SECTION,
  '',
  '| Термин | Значение | Пример | Автор | Дата |',
  '|---|---|---|---|---|',
  '',
  COMMANDS_SECTION,
  '',
  '| Команда | Что делает агент |',
  '|---|---|',
  '',
].join('\n')

function docsDir(root: string): string {
  return join(root, 'docs', 'board')
}

function docPath(root: string): string {
  return join(docsDir(root), DOC)
}

function lockPath(root: string): string {
  return join(root, '.board', 'terminology.lock')
}

/** Создаёт документ, если его нет; существующее содержимое не трогает. */
export function ensureTerminology(root: string): void {
  mkdirSync(docsDir(root), { recursive: true })
  const path = docPath(root)
  if (existsSync(path)) return
  writeFileSync(path, INITIAL, 'utf8')
}

function readText(root: string): string {
  const path = docPath(root)
  return existsSync(path) ? readFileSync(path, 'utf8') : ''
}

/** Строки данных таблицы раздела (без заголовка и разделителя), каждая — ячейки. */
function tableRows(text: string, section: string): string[][] {
  const lines = text.split(/\r?\n/)
  const sectionIdx = lines.findIndex((line) => line.trim() === section)
  if (sectionIdx === -1) return []

  let headerIdx = -1
  for (let i = sectionIdx + 1; i < lines.length; i++) {
    if (lines[i].trim().startsWith('|')) {
      headerIdx = i
      break
    }
  }
  if (headerIdx === -1) return []

  let sepIdx = -1
  for (let i = headerIdx + 1; i < lines.length; i++) {
    if (lines[i].trim().startsWith('|')) {
      sepIdx = i
      break
    }
  }
  if (sepIdx === -1) return []

  const rows: string[][] = []
  for (let i = sepIdx + 1; i < lines.length; i++) {
    const line = lines[i].trim()
    if (/^##\s/.test(line)) break
    if (!line.startsWith('|')) continue
    const cells = line.split('|').slice(1, -1).map((cell) => cell.trim())
    if (cells.length > 0) rows.push(cells)
  }
  return rows
}

/** Вставляет строку после последней строки таблицы раздела, сохраняя остальное. */
function appendRow(text: string, section: string, row: string): string {
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  const lines = text.split(/\r?\n/)

  const sectionIdx = lines.findIndex((line) => line.trim() === section)
  if (sectionIdx === -1) {
    throw new UserError(3, `раздел «${section}» не найден в terminology.md`)
  }

  // Первая строка таблицы — заголовок, вторая — разделитель.
  let headerIdx = -1
  for (let i = sectionIdx + 1; i < lines.length; i++) {
    if (lines[i].trim().startsWith('|')) {
      headerIdx = i
      break
    }
  }
  if (headerIdx === -1) throw new UserError(3, `таблица раздела «${section}» не найдена`)

  let sepIdx = -1
  for (let i = headerIdx + 1; i < lines.length; i++) {
    if (lines[i].trim().startsWith('|')) {
      sepIdx = i
      break
    }
  }
  if (sepIdx === -1) throw new UserError(3, `таблица раздела «${section}» не найдена`)

  let endIdx = lines.length
  for (let i = sectionIdx + 1; i < lines.length; i++) {
    if (/^##\s/.test(lines[i])) {
      endIdx = i
      break
    }
  }

  let insertIdx = sepIdx
  for (let i = sepIdx + 1; i < endIdx; i++) {
    if (lines[i].trim().startsWith('|')) insertIdx = i
  }

  lines.splice(insertIdx + 1, 0, row)
  return lines.join(eol)
}

function escapeCell(value: string): string {
  return value.replace(/\r?\n/g, ' ').replace(/\|/g, '\\|')
}

export function addTerm(
  root: string,
  input: { term: string; definition: string; example?: string; author: string },
): AddResult {
  const term = input.term.trim()
  const definition = input.definition.trim()
  const author = input.author.trim()
  if (!term) throw new UserError(3, 'нужен термин')
  if (!definition) throw new UserError(3, 'нужно значение термина')
  if (!author) throw new UserError(3, 'нужен автор термина')

  ensureTerminology(root)
  return withFileLock(lockPath(root), () => {
    const text = readText(root)
    const duplicate = tableRows(text, TERMS_SECTION).some((cells) => cells[0] === term)
    const cells = [term, definition, input.example?.trim() ?? '', author, nowIso().slice(0, 10)]
    const row = `| ${cells.map(escapeCell).join(' | ')} |`
    writeFileSync(docPath(root), appendRow(text, TERMS_SECTION, row), 'utf8')
    return { added: true, duplicate }
  })
}

export function listTerms(root: string): Term[] {
  return tableRows(readText(root), TERMS_SECTION).map((cells) => ({
    term: cells[0] ?? '',
    definition: cells[1] ?? '',
    example: cells[2] ?? '',
    author: cells[3] ?? '',
    date: cells[4] ?? '',
  }))
}

export function showTerm(root: string, term: string): Term | null {
  return listTerms(root).find((item) => item.term === term) ?? null
}

export function addOwnerCommand(
  root: string,
  input: { command: string; action: string; author: string },
): AddResult {
  if (input.author !== 'owner') {
    throw new UserError(3, 'команды владельца может добавлять только owner')
  }
  const command = input.command.trim()
  const action = input.action.trim()
  if (!command) throw new UserError(3, 'нужна команда')
  if (!action) throw new UserError(3, 'нужно описание команды')

  ensureTerminology(root)
  return withFileLock(lockPath(root), () => {
    const text = readText(root)
    const duplicate = tableRows(text, COMMANDS_SECTION).some((cells) => cells[0] === command)
    const row = `| ${escapeCell(command)} | ${escapeCell(action)} |`
    writeFileSync(docPath(root), appendRow(text, COMMANDS_SECTION, row), 'utf8')
    return { added: true, duplicate }
  })
}

export function listOwnerCommands(root: string): OwnerCommand[] {
  return tableRows(readText(root), COMMANDS_SECTION).map((cells) => ({
    command: cells[0] ?? '',
    action: cells[1] ?? '',
  }))
}
