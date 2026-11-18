import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
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

test('шаблон скилла содержит текущие разделы и правила', () => {
  const root = tmp()
  writeOpenCodeFiles(root)
  const skill = readFileSync(join(root, '.opencode/skills/toolbox-al/SKILL.md'), 'utf8')

  // RUN и новые команды прогона: шаблон не должен отставать от самого скилла
  assert.match(skill, /^## RUN: как ведёт себя оркестратор$/m)
  assert.match(skill, /run handoff/)
  assert.match(skill, /hiberfil\.sys/)

  // правила короткого брифа и короткого ответа агента
  assert.match(skill, /Бриф — 2–3 строки/)
  assert.match(skill, /Ответ агента — статус и число тестов/)
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

test('AGENTS.md знает слова владельца', () => {
  const root = tmp()
  writeOpenCodeFiles(root)

  const agents = readFileSync(join(root, 'AGENTS.md'), 'utf8')

  assert.match(agents, /Добавь задачу/i)
  assert.match(agents, /запрос в inbox/i)
  assert.match(agents, /Запиши идею/i)
  assert.match(agents, /иде[юя]/i)
})

test('скилл держит коммит в области задачи', () => {
  const root = tmp()
  writeOpenCodeFiles(root)
  const skill = readFileSync(join(root, '.opencode/skills/toolbox-al/SKILL.md'), 'utf8')

  assert.match(skill, /Коммит делает приложение командой `done`/)
  assert.match(skill, /по файлам своей области/)
})

test('скилл: релиз — отдельная команда, а не часть RUN', () => {
  const root = tmp()
  writeOpenCodeFiles(root)
  const skill = readFileSync(join(root, '.opencode/skills/toolbox-al/SKILL.md'), 'utf8')

  assert.match(skill, /Релиз не входит в RUN/)
  assert.match(skill, /`release` — отдельная команда/)
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

test('плагин обновляется построчно по версии и сохраняет остальное', () => {
  const root = tmp()
  writeOpenCodeFiles(root)
  const path = join(root, '.opencode/plugins/toolbox-al/index.ts')
  const original = readFileSync(path, 'utf8').replace(/toolbox-al-plugin-version:\s*\S+/, 'toolbox-al-plugin-version: 0.0.1')
  writeFileSync(path, original, 'utf8')

  const result = refreshOpenCode(root, '9.9.9', { yes: true })
  const plugin = result.find((item) => item.path.endsWith('index.ts'))!

  assert.equal(plugin.status, 'updated')
  assert.match(readFileSync(path, 'utf8'), /9\.9\.9/)
  assert.equal(existsSync(`${path}.new`), false)
})

test('скилл: ревью задачи не обходится, ревью прогона привязано к релизу', () => {
  const root = tmp()
  writeOpenCodeFiles(root)
  const skill = readFileSync(join(root, '.opencode/skills/toolbox-al/SKILL.md'), 'utf8')

  assert.match(skill, /Не обходить ревью/)
  assert.match(skill, /in_review/)
  assert.match(skill, /Ревью привязано к релизу/)
  assert.match(skill, /run review/)
  assert.doesNotMatch(skill, /Ревью задач не проводим/, 'устаревшее правило не воскрешаем')
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



test('блок AGENTS.md знает про ревью и dev', () => {
  const root = tmp()
  writeOpenCodeFiles(root)
  const agents = readFileSync(join(root, 'AGENTS.md'), 'utf8')

  assert.match(agents, /Ревью не обходится/)
  assert.match(agents, /in_review/)
  assert.match(agents, /ветке фичи или dev/)
})
