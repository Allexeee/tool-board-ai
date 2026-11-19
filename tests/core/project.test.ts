import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { findProject, initProject } from '../../src/core/project.ts'
import { makeBoard } from '../helpers/board.ts'

const tempDir = () => mkdtempSync(join(tmpdir(), 'board-project-'))

const TABLES = [
  'cards',
  'steps',
  'refs',
  'deps',
  'discussion',
  'events',
  'runs',
  'run_cards',
  'decisions',
  'reviews',
  'executors',
  'groups',
  'meta',
]

const HOOK = `#!/bin/sh
# toolbox-al: protect branches
# toolbox-al:begin
branch=$(git symbolic-ref --short HEAD 2>/dev/null || echo "")
case " main dev " in
  *" $branch "*)
    exit 1
    ;;
esac
exit 0
# toolbox-al:end
`

test('makeBoard создаёт базу со всеми таблицами схемы v1', (t) => {
  const fixture = makeBoard()
  t.after(fixture.close)

  assert.ok(existsSync(join(fixture.root, '.board', 'board.db')))

  const tables = fixture.db
    .prepare("select name from sqlite_master where type = 'table' order by name")
    .all()
    .map((row: { name: string }) => row.name)

  for (const table of TABLES) {
    assert.ok(tables.includes(table), `missing table ${table}`)
  }

  const version = fixture.db.prepare("select value from meta where key = 'schemaVersion'").get() as
    | { value: string }
    | undefined
  assert.equal(version?.value, '1')
  assert.equal(fixture.db.prepare('pragma foreign_keys').get()?.foreign_keys, 1)
})

test('initProject заводит владельца один раз', (t) => {
  const fixture = makeBoard()
  t.after(fixture.close)

  const owner = fixture.db
    .prepare("select id, kind, skills from executors where id = 'owner'")
    .get() as { id: string; kind: string; skills: string } | undefined

  assert.equal(owner?.id, 'owner')
  assert.equal(owner?.kind, 'human')
  assert.deepEqual(JSON.parse(owner!.skills), ['owner'])

  initProject(fixture.root)
  assert.equal(fixture.db.prepare('select count(*) as n from executors').get()?.n, 1)
})

test('findProject идёт вверх и знает docs/board', (t) => {
  const fixture = makeBoard()
  t.after(fixture.close)

  mkdirSync(join(fixture.root, 'src', 'deep'), { recursive: true })
  const project = findProject(join(fixture.root, 'src', 'deep'), {})

  assert.equal(project?.root, fixture.root)
  assert.equal(project?.dbPath, join(fixture.root, '.board', 'board.db'))
  assert.equal(project?.boardDir, join(fixture.root, '.board'))
  assert.equal(project?.docsDir, join(fixture.root, 'docs', 'board'))
})

test('findProject понимает BOARD_HOME и каталог worktree', (t) => {
  const fixture = makeBoard()
  t.after(fixture.close)
  const other = tempDir()
  t.after(() => rmSync(other, { recursive: true, force: true }))
  initProject(other)

  assert.equal(findProject(fixture.root, { BOARD_HOME: other })?.root, other)

  mkdirSync(join(fixture.root, '.worktrees', 'developer', 'src'), { recursive: true })
  assert.equal(
    findProject(join(fixture.root, '.worktrees', 'developer', 'src'), {})?.root,
    fixture.root,
  )
})

test('findProject без доски возвращает null', (t) => {
  const dir = tempDir()
  t.after(() => rmSync(dir, { recursive: true, force: true }))

  assert.equal(findProject(dir, {}), null)
})

test('initProject создаёт docs/board и дописывает .gitignore один раз', (t) => {
  const root = tempDir()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  writeFileSync(join(root, '.gitignore'), 'node_modules/\n')

  initProject(root)
  initProject(root)

  assert.ok(existsSync(join(root, 'docs', 'board')))
  const lines = readFileSync(join(root, '.gitignore'), 'utf8').split(/\r?\n/)
  assert.equal(lines.filter((line) => line === '.board/').length, 1)
  assert.equal(lines.filter((line) => line === '.worktrees/').length, 1)
  assert.ok(lines.includes('node_modules/'))
})

test('initProject снимает старый хук toolbox-al и новый не ставит', (t) => {
  const root = tempDir()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(join(root, '.git', 'hooks'), { recursive: true })
  const hook = join(root, '.git', 'hooks', 'pre-commit')
  writeFileSync(hook, HOOK)

  initProject(root)

  assert.equal(existsSync(hook), false)
  assert.deepEqual(readdirSync(join(root, '.git', 'hooks')), [])
})

test('initProject сохраняет чужой хук без блока toolbox-al', (t) => {
  const root = tempDir()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(join(root, '.git', 'hooks'), { recursive: true })
  const hook = join(root, '.git', 'hooks', 'pre-commit')
  const custom = '#!/bin/sh\necho custom\n\n' + HOOK.replace(/^#!.*\n/, '').trimEnd() + '\n'
  writeFileSync(hook, custom)

  initProject(root)

  assert.ok(existsSync(hook))
  const text = readFileSync(hook, 'utf8')
  assert.match(text, /echo custom/)
  assert.doesNotMatch(text, /toolbox-al/)
})
