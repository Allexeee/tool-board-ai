import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  AGENTS_BEGIN,
  AGENTS_END,
  lineDiff,
  mergeManaged,
  openCodeFilesPresent,
  planOpenCode,
  pluginSource,
  pluginVersion,
  refreshOpenCode,
  writeOpenCodeFiles,
} from '../../src/core/opencode.ts'
import { initProject } from '../../src/core/project.ts'
import { openDb } from '../../src/core/db.ts'
import { doctorReport } from '../../src/core/doctor.ts'

const tmp = () => mkdtempSync(join(tmpdir(), 'oc-'))

test('файлы создаются и не перезаписываются', () => {
  const root = tmp()
  const first = writeOpenCodeFiles(root)
  assert.ok(first.created.length >= 4)

  const second = writeOpenCodeFiles(root)
  assert.deepEqual(second.created, [])

  const agents = readFileSync(join(root, 'AGENTS.md'), 'utf8')
  assert.equal(agents.match(/toolbox-al:begin/g)!.length, 1)
})

test('существующий AGENTS.md сохраняется', () => {
  const root = tmp()
  writeFileSync(join(root, 'AGENTS.md'), '# Мой проект\n\nправила\n')
  writeOpenCodeFiles(root)
  const text = readFileSync(join(root, 'AGENTS.md'), 'utf8')
  assert.match(text, /Мой проект/)
  assert.match(text, /toolbox-al:begin/)
})

test('плагин объявляет инструменты и вызывает CLI', () => {
  const source = pluginSource('9.9.9')
  for (const name of ['now', 'inbox', 'task', 'take', 'done', 'block', 'ask', 'dispatch', 'review', 'accept', 'answer']) {
    assert.ok(source.includes(`name: '${name}'`), name)
  }
  assert.match(source, /toolbox-al\.ts/)
  assert.match(source, /tools.*toolbox-al.*bin.*toolbox-al\.ts/s)
  assert.match(source, /Plugin\.define/)
  assert.match(source, /nodeBin/)
  assert.doesNotMatch(source, /file: process\.execPath/)
  assert.match(source, /9\.9\.9/)
})

test('скилл объясняет порядок и запрет на git', () => {
  const root = tmp()
  writeOpenCodeFiles(root)
  const skill = readFileSync(join(root, '.opencode/skills/toolbox-al/SKILL.md'), 'utf8')
  assert.match(skill, /task show/)
  assert.match(skill, /не коммит/i)
  assert.match(skill, /dispatch/)
})

test('init создаёт файлы OpenCode', () => {
  const root = tmp()
  initProject(root)
  assert.deepEqual(openCodeFilesPresent(root), {
    plugin: true,
    skill: true,
    setupSkill: true,
    agentsBlock: true,
  })
  assert.equal(pluginVersion(root), '1.0.2')
})

test('doctor замечает отсутствие плагина', () => {
  const root = tmp()
  initProject(root)
  const db = openDb(join(root, '.toolbox-al/tracker.db'))
  assert.equal(
    doctorReport(db, { root }).checks.find((check) => check.name === 'плагин OpenCode')!.ok,
    true,
  )

  const bare = tmp()
  const bareDb = openDb(':memory:')
  assert.equal(
    doctorReport(bareDb, { root: bare }).checks.find((check) => check.name === 'плагин OpenCode')!.ok,
    false,
  )
})

test('скилл и AGENTS.md знают слова владельца', () => {
  const root = tmp()
  writeOpenCodeFiles(root)

  const skill = readFileSync(join(root, '.opencode/skills/toolbox-al/SKILL.md'), 'utf8')
  const agents = readFileSync(join(root, 'AGENTS.md'), 'utf8')

  for (const text of [skill, agents]) {
    assert.match(text, /Добавь задачу/i)
    assert.match(text, /запрос в inbox/i)
    assert.match(text, /Запиши идею/i)
    assert.match(text, /иде[юя]/i)
  }
})

test('скилл напоминает про tests в области шага', () => {
  const root = tmp()
  writeOpenCodeFiles(root)
  const skill = readFileSync(join(root, '.opencode/skills/toolbox-al/SKILL.md'), 'utf8')

  assert.match(skill, /tests\//)
  assert.match(skill, /област/i)
})

test('скилл: уровень релиза выбирает агент с причиной', () => {
  const root = tmp()
  writeOpenCodeFiles(root)
  const skill = readFileSync(join(root, '.opencode/skills/toolbox-al/SKILL.md'), 'utf8')

  assert.match(skill, /release/)
  assert.match(skill, /причин/i)
  assert.match(skill, /major/)
})

test('refresh обновляет блок AGENTS.md по маркерам', () => {
  const root = tmp()
  writeOpenCodeFiles(root)
  const path = join(root, 'AGENTS.md')
  writeFileSync(path, `# Мой проект\n\n${AGENTS_BEGIN}\nстарое\n${AGENTS_END}\n\nхвост\n`, 'utf8')

  refreshOpenCode(root, '9.9.9', { yes: true })

  const after = readFileSync(path, 'utf8')
  assert.match(after, /Мой проект/)
  assert.match(after, /хвост/)
  assert.doesNotMatch(after, /старое/)
  assert.match(after, /toolbox-al/)
})

test('плагин не перезаписывается, рядом появляется .new', () => {
  const root = tmp()
  writeOpenCodeFiles(root)
  const path = join(root, '.opencode/plugins/toolbox-al/index.ts')
  writeFileSync(path, '// моя правка\n', 'utf8')

  const result = refreshOpenCode(root, '9.9.9', { yes: true })
  const plugin = result.find((item) => item.path.endsWith('index.ts'))!

  assert.equal(plugin.status, 'pending')
  assert.equal(readFileSync(path, 'utf8'), '// моя правка\n')
  assert.match(readFileSync(`${path}.new`, 'utf8'), /9\.9\.9/)
})

test('скилл: ревью задач не проводим, перед релизом три варианта', () => {
  const root = tmp()
  writeOpenCodeFiles(root)
  const skill = readFileSync(join(root, '.opencode/skills/toolbox-al/SKILL.md'), 'utf8')

  assert.match(skill, /Ревью задач не проводим/)
  assert.match(skill, /--review same\|fresh\|none/)
  assert.match(skill, /только изменения релиза/)
  assert.match(skill, /критические находки/i)
  assert.match(skill, /request add/)
})

test('mergeManaged меняет блок и сохраняет правку вне маркеров', () => {
  const current = `---\nname: x\n---\n${AGENTS_BEGIN}\nстарое\n${AGENTS_END}\n\nмоя заметка\n`
  const next = `${AGENTS_BEGIN}\nновое\n${AGENTS_END}\n`

  const merged = mergeManaged(current, next)!

  assert.match(merged, /новое/)
  assert.doesNotMatch(merged, /старое/)
  assert.match(merged, /моя заметка/)
  assert.match(merged, /name: x/)
})

test('mergeManaged отказывается, если в файле нет маркеров', () => {
  assert.equal(mergeManaged('# просто текст\n', `${AGENTS_BEGIN}\nновое\n${AGENTS_END}\n`), null)
})

test('refreshOpenCode не затирает файл без маркеров даже с --yes', () => {
  const root = tmp()
  writeOpenCodeFiles(root)

  const path = join(root, '.opencode/skills/toolbox-al/SKILL.md')
  writeFileSync(path, '# моя версия без маркеров\n', 'utf8')

  const result = refreshOpenCode(root, '9.9.9', { yes: true })
  const skill = result.find((item) => item.path.endsWith('toolbox-al/SKILL.md'))!

  assert.equal(skill.status, 'pending')
  assert.equal(readFileSync(path, 'utf8'), '# моя версия без маркеров\n')
  assert.match(readFileSync(`${path}.new`, 'utf8'), /toolbox-al/)
})

test('planOpenCode показывает дифф и ничего не пишет', () => {
  const root = tmp()
  writeOpenCodeFiles(root)

  const path = join(root, '.opencode/skills/toolbox-al/SKILL.md')
  const original = readFileSync(path, 'utf8')
  const withNote = original + '\nмоя заметка\n'
  writeFileSync(path, withNote, 'utf8')

  const items = planOpenCode(root, '9.9.9')
  const skill = items.find((item) => item.path.endsWith('toolbox-al/SKILL.md'))!

  assert.equal(skill.status, 'same')
  assert.equal(readFileSync(path, 'utf8'), withNote)
})

test('planOpenCode помечает чужой файл как blocked', () => {
  const root = tmp()
  writeOpenCodeFiles(root)
  const path = join(root, '.opencode/skills/toolbox-al/SKILL.md')
  writeFileSync(path, '# без маркеров\n', 'utf8')

  const items = planOpenCode(root, '9.9.9')
  assert.equal(items.find((item) => item.path.endsWith('toolbox-al/SKILL.md'))!.status, 'blocked')
})

test('lineDiff показывает изменённые строки', () => {
  const diff = lineDiff('старое\nобщее\n', 'новое\nобщее\n')
  assert.match(diff, /- старое/)
  assert.match(diff, /\+ новое/)
  assert.doesNotMatch(diff, /общее/)
})

test('refreshOpenCode обновляет блок и сохраняет правку вне маркеров', () => {
  const root = tmp()
  writeOpenCodeFiles(root)

  const path = join(root, '.opencode/skills/toolbox-al/SKILL.md')
  const original = readFileSync(path, 'utf8')
  writeFileSync(path, original + '\nмоя заметка\n', 'utf8')

  refreshOpenCode(root, '9.9.9', { yes: true })
  const after = readFileSync(path, 'utf8')

  assert.match(after, /моя заметка/)
  assert.match(after, /toolbox-al/)
})

