import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, posix, relative, resolve, sep } from 'node:path'

/** Куда пишется карта по `map --write`. */
export const MAP_FILE = 'docs/toolbox-al/map.md'

export interface MapFile {
  /** Путь от корня карты, всегда через `/`. */
  path: string
  /** Размер файла на диске в байтах. */
  size: number
  /** Экспортируемые имена в порядке объявления. */
  exports: string[]
  /** Пути модулей внутри карты, на которые ссылается файл. */
  imports: string[]
}

export interface RepoMap {
  root: string
  files: MapFile[]
  /** Число связей импортов между модулями карты. */
  edges: number
}

export interface MapOptions {
  /** Каталоги от корня; по умолчанию `src` и `bin`, а если их нет — весь корень. */
  dirs?: string[]
}

const SOURCE_EXTENSIONS = ['.ts', '.tsx']
const SKIP_DIRS = new Set(['node_modules', '.git', '.worktrees', '.toolbox-al', 'dist', 'coverage'])
const DEFAULT_DIRS = ['src', 'bin']

const EXPORT_PATTERN =
  /^\s*export\s+(?:(?:declare\s+)?(?:default\s+)?(?:async\s+)?(?:abstract\s+)?(?:function\*?|class|const|let|var|interface|type|enum)\s+([A-Za-z_$][\w$]*)|(?:type\s+)?\{([^}]*)\}|\*\s+as\s+([A-Za-z_$][\w$]*)|default\b)/gm

const IMPORT_PATTERNS = [
  /^\s*import\s+(?:type\s+)?(?:[^;'"]*?\s+from\s+)?['"]([^'"]+)['"]/gm,
  /^\s*export\s+[^\n;'"]*\s+from\s+['"]([^'"]+)['"]/gm,
  /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
]

export function buildMap(root: string, options: MapOptions = {}): RepoMap {
  const base = resolve(root)
  const dirs = options.dirs && options.dirs.length > 0 ? options.dirs : defaultDirs(base)
  const paths = collectFiles(base, dirs)

  const parsed = paths.map((path) => {
    const source = readFileSync(join(base, path), 'utf8')
    return {
      path,
      size: statSync(join(base, path)).size,
      exports: parseExports(source),
      specs: parseImports(source),
    }
  })

  const known = new Set(parsed.map((file) => file.path))
  const files = parsed.map((file) => {
    const imports: string[] = []
    for (const spec of file.specs) {
      const target = resolveSpecifier(file.path, spec)
      if (!target || target === file.path) continue
      if (!known.has(target)) continue
      if (!imports.includes(target)) imports.push(target)
    }
    return { path: file.path, size: file.size, exports: file.exports, imports }
  })

  return { root: base, files, edges: files.reduce((sum, file) => sum + file.imports.length, 0) }
}

export function parseExports(source: string): string[] {
  const names: string[] = []
  const add = (name: string) => {
    if (name && !names.includes(name)) names.push(name)
  }

  for (const match of source.matchAll(EXPORT_PATTERN)) {
    if (match[1]) add(match[1])
    else if (match[2]) {
      for (const part of match[2].split(',')) {
        const name = part
          .trim()
          .replace(/^type\s+/, '')
          .split(/\s+as\s+/)
          .pop()
          ?.trim()
        if (name) add(name)
      }
    } else if (match[3]) add(match[3])
    else add('default')
  }

  return names
}

export function parseImports(source: string): string[] {
  const specs: string[] = []
  for (const pattern of IMPORT_PATTERNS) {
    for (const match of source.matchAll(pattern)) {
      const spec = match[1]
      if (spec && !specs.includes(spec)) specs.push(spec)
    }
  }
  return specs
}

/** Приводит спецификатор импорта к пути модуля карты; внешние пакеты отбрасывает. */
export function resolveSpecifier(fromPath: string, spec: string): string | null {
  if (!spec.startsWith('.')) return null
  return posix.normalize(posix.join(posix.dirname(fromPath), spec))
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  return `${(bytes / 1024).toFixed(1)} KB`
}

export function renderMap(map: RepoMap): string {
  if (map.files.length === 0) return 'модулей не найдено'

  const width = Math.max(...map.files.map((file) => file.path.length))
  const lines = [`модулей: ${map.files.length}, связей: ${map.edges}`, '']

  for (const file of map.files) {
    lines.push(`${file.path.padEnd(width)}  ${formatSize(file.size)}`)
    lines.push(`  экспорт: ${file.exports.length > 0 ? file.exports.join(', ') : '—'}`)
    if (file.imports.length > 0) lines.push(`  импорт: ${file.imports.join(', ')}`)
  }

  return lines.join('\n')
}

export function renderMarkdown(map: RepoMap): string {
  const lines = [
    '# Карта репозитория',
    '',
    `Модулей: ${map.files.length}, связей: ${map.edges}.`,
    '',
    'Файл создан командой `toolbox-al map --write`; правки руками затрутся.',
    '',
    '| Файл | Размер | Экспорт | Импортирует |',
    '| --- | ---: | --- | --- |',
  ]

  for (const file of map.files) {
    lines.push(
      `| \`${file.path}\` | ${formatSize(file.size)} | ${cell(file.exports)} | ${cell(file.imports, '`')} |`,
    )
  }

  return lines.join('\n') + '\n'
}

export function writeMap(map: RepoMap, target: string): string {
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, renderMarkdown(map), 'utf8')
  return target
}

function cell(values: string[], quote = ''): string {
  if (values.length === 0) return '—'
  return values.map((value) => `${quote}${value}${quote}`).join(', ')
}

function defaultDirs(root: string): string[] {
  const found = DEFAULT_DIRS.filter((dir) => existsSync(join(root, dir)))
  return found.length > 0 ? found : ['.']
}

function collectFiles(root: string, dirs: string[]): string[] {
  const found = new Set<string>()
  for (const dir of dirs) {
    const abs = resolve(root, dir)
    if (!existsSync(abs)) continue
    walk(root, abs, found)
  }
  return [...found].sort()
}

function walk(root: string, dir: string, found: Set<string>): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue
      walk(root, join(dir, entry.name), found)
      continue
    }
    if (!entry.isFile()) continue
    if (!SOURCE_EXTENSIONS.some((ext) => entry.name.endsWith(ext))) continue
    found.add(relative(root, join(dir, entry.name)).split(sep).join('/'))
  }
}
