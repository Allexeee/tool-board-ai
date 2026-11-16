import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

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
  '- Скилл `toolbox-al` описывает порядок работы, `toolbox-al-setup` — первичную настройку.',
  AGENTS_END,
].join('\n')

function asset(name: string): string {
  return readFileSync(join(here, name), 'utf8')
}

export function pluginSource(toolVersion = '1.0.0'): string {
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
  toolVersion = '1.0.0',
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
