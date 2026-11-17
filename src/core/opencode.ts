import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { toolVersion as currentToolVersion } from './version.ts'

const here = dirname(fileURLToPath(import.meta.url))

export const AGENTS_BEGIN = '<!-- toolbox-al:begin -->'
export const AGENTS_END = '<!-- toolbox-al:end -->'

export const AGENTS_BLOCK = [
  AGENTS_BEGIN,
  '## toolbox-al',
  '',
  'Работа ведётся через очередь: `node bin/toolbox-al.ts`.',
  '',
  '- Порядок решает приложение, не модель: `dispatch` выдаёт, кому что.',
  '- Коммит делает приложение командой `done`; агент в git не пишет.',
  '- Задача без DoD не создаётся; неполный план не применяется.',
  '- Ревью задач не проводим; перед релизом владелец выбирает ревью изменений.',
  '- Работай в ветке фичи или dev; main меняется только релизом.',
  '- «Добавь задачу» и «добавь в план» — это запрос в inbox; «запиши идею» и «добавь идею» — идея.',
  '- Скилл `toolbox-al` описывает порядок работы, `toolbox-al-setup` — первичную настройку.',
  AGENTS_END,
].join('\n')

function asset(name: string): string {
  return readFileSync(join(here, name), 'utf8').replace(/^\uFEFF/, '')
}

export function pluginSource(toolVersion = currentToolVersion()): string {
  return asset('opencode-plugin.txt').replace('__VERSION__', toolVersion)
}

export function skillSource(): string {
  return asset('opencode-skill.txt')
}

export function setupSkillSource(): string {
  return asset('opencode-setup.txt')
}

function writeFile(path: string, content: string, created: string[], skipped: string[], relative: string): void {
  if (existsSync(path)) {
    skipped.push(relative)
    return
  }
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content, 'utf8')
  created.push(relative)
}

export function writeOpenCodeFiles(
  root: string,
  toolVersion = currentToolVersion(),
): { created: string[]; skipped: string[] } {
  const created: string[] = []
  const skipped: string[] = []

  writeFile(
    join(root, '.opencode/plugins/toolbox-al/index.ts'),
    pluginSource(toolVersion),
    created,
    skipped,
    '.opencode/plugins/toolbox-al/index.ts',
  )
  writeFile(
    join(root, '.opencode/skills/toolbox-al/SKILL.md'),
    skillSource(),
    created,
    skipped,
    '.opencode/skills/toolbox-al/SKILL.md',
  )
  writeFile(
    join(root, '.opencode/skills/toolbox-al-setup/SKILL.md'),
    setupSkillSource(),
    created,
    skipped,
    '.opencode/skills/toolbox-al-setup/SKILL.md',
  )

  const agentsPath = join(root, 'AGENTS.md')
  const current = existsSync(agentsPath) ? readFileSync(agentsPath, 'utf8') : ''

  if (!current.includes(AGENTS_BEGIN)) {
    const next = current.trimEnd() ? current.trimEnd() + '\n\n' + AGENTS_BLOCK + '\n' : AGENTS_BLOCK + '\n'
    mkdirSync(dirname(agentsPath), { recursive: true })
    writeFileSync(agentsPath, next, 'utf8')
    created.push('AGENTS.md (блок)')
  } else {
    skipped.push('AGENTS.md (блок уже есть)')
  }

  return { created, skipped }
}

export function openCodeFilesPresent(root: string): {
  plugin: boolean
  skill: boolean
  setupSkill: boolean
  agentsBlock: boolean
} {
  const agentsPath = join(root, 'AGENTS.md')

  return {
    plugin: existsSync(join(root, '.opencode/plugins/toolbox-al/index.ts')),
    skill: existsSync(join(root, '.opencode/skills/toolbox-al/SKILL.md')),
    setupSkill: existsSync(join(root, '.opencode/skills/toolbox-al-setup/SKILL.md')),
    agentsBlock: existsSync(agentsPath) && readFileSync(agentsPath, 'utf8').includes(AGENTS_BEGIN),
  }
}

export function pluginVersion(root: string): string | null {
  const path = join(root, '.opencode/plugins/toolbox-al/index.ts')
  if (!existsSync(path)) return null
  const match = /toolbox-al-plugin-version:\s*(\S+)/.exec(readFileSync(path, 'utf8'))
  return match ? match[1] : null
}

export interface ManagedUpdate {
  path: string
  status: 'same' | 'updated' | 'pending' | 'missing'
}

export interface ManagedPlanItem {
  path: string
  status: 'same' | 'update' | 'missing' | 'blocked'
  diff?: string
}

/** Построчный дифф без библиотек: файлы маленькие, хватает LCS. */
export function lineDiff(current: string, next: string): string {
  const a = current.split('\n')
  const b = next.split('\n')
  const lcs: number[][] = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0))

  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1])
    }
  }

  const lines: string[] = []
  let i = 0
  let j = 0
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      i++
      j++
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      lines.push(`- ${a[i++]}`)
    } else {
      lines.push(`+ ${b[j++]}`)
    }
  }
  while (i < a.length) lines.push(`- ${a[i++]}`)
  while (j < b.length) lines.push(`+ ${b[j++]}`)

  return lines.join('\n')
}

/** Что случится с управляемыми файлами, если применить обновление. Ничего не пишет. */
export function planOpenCode(root: string, toolVersion: string): ManagedPlanItem[] {
  const files: Array<[string, string, boolean]> = [
    ['.opencode/plugins/toolbox-al/index.ts', pluginSource(toolVersion), false],
    ['.opencode/skills/toolbox-al/SKILL.md', skillSource(), true],
    ['.opencode/skills/toolbox-al-setup/SKILL.md', setupSkillSource(), true],
    ['AGENTS.md', AGENTS_BLOCK, true],
  ]

  return files.map(([relative, next, merge]) => {
    const path = join(root, relative)
    if (!existsSync(path)) return { path: relative, status: 'missing' }

    const current = readFileSync(path, 'utf8')

    if (!merge) {
      return current === next ? { path: relative, status: 'same' } : { path: relative, status: 'update', diff: lineDiff(current, next) }
    }

    const merged = mergeManaged(current, next)
    if (merged === null) return { path: relative, status: 'blocked' }
    if (merged === current) return { path: relative, status: 'same' }
    return { path: relative, status: 'update', diff: lineDiff(current, merged) }
  })
}

/** Меняет только блок между маркерами, оставляя всё, что человек дописал вокруг. */
export function mergeManaged(current: string, next: string): string | null {
  const begin = current.indexOf(AGENTS_BEGIN)
  const end = current.indexOf(AGENTS_END)
  const nextBegin = next.indexOf(AGENTS_BEGIN)
  const nextEnd = next.indexOf(AGENTS_END)

  if (begin === -1 || end === -1 || end < begin) return null
  if (nextBegin === -1 || nextEnd === -1 || nextEnd < nextBegin) return null

  const block = next.slice(nextBegin, nextEnd + AGENTS_END.length)
  return current.slice(0, begin) + block + current.slice(end + AGENTS_END.length)
}

export function refreshOpenCode(
  root: string,
  toolVersion: string,
  options: { yes?: boolean } = {},
): ManagedUpdate[] {
  const files: Array<[string, string, boolean]> = [
    ['.opencode/plugins/toolbox-al/index.ts', pluginSource(toolVersion), false],
    ['.opencode/skills/toolbox-al/SKILL.md', skillSource(), true],
    ['.opencode/skills/toolbox-al-setup/SKILL.md', setupSkillSource(), true],
    ['AGENTS.md', AGENTS_BLOCK, true],
  ]

  const result: ManagedUpdate[] = []

  for (const [relative, next, merge] of files) {
    const path = join(root, relative)

    if (!existsSync(path)) {
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, next, 'utf8')
      result.push({ path: relative, status: 'missing' })
      continue
    }

    const current = readFileSync(path, 'utf8')

    if (merge) {
      const merged = mergeManaged(current, next)

      // файл без маркеров — чужой: не затираем даже с --yes, кладём рядом .new
      if (merged === null) {
        writeFileSync(`${path}.new`, next, 'utf8')
        result.push({ path: relative, status: 'pending' })
        continue
      }

      if (merged === current) {
        result.push({ path: relative, status: 'same' })
        continue
      }

      if (options.yes) {
        writeFileSync(path, merged, 'utf8')
        result.push({ path: relative, status: 'updated' })
      } else {
        writeFileSync(`${path}.new`, merged, 'utf8')
        result.push({ path: relative, status: 'pending' })
      }
      continue
    }

    if (current === next) {
      result.push({ path: relative, status: 'same' })
      continue
    }

    // плагин не перезаписываем целиком: переносим только строку версии
    const withVersion = current.replace(
      /toolbox-al-plugin-version:\s*\S+/,
      `toolbox-al-plugin-version: ${toolVersion}`,
    )
    if (withVersion !== current) {
      if (options.yes) {
        writeFileSync(path, withVersion, 'utf8')
        result.push({ path: relative, status: 'updated' })
      } else {
        writeFileSync(`${path}.new`, withVersion, 'utf8')
        result.push({ path: relative, status: 'pending' })
      }
      continue
    }

    writeFileSync(`${path}.new`, next, 'utf8')
    result.push({ path: relative, status: 'pending' })
  }

  return result
}

