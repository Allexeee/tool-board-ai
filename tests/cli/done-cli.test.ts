import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { openDb } from '../../src/core/db.ts'
import { listEvents } from '../../src/core/events.ts'
import { refreshReady } from '../../src/core/deps.ts'
import { makeRepoWithDev } from '../helpers/repo.ts'

const bin = resolve('bin/toolbox-al.ts')

function run(dir: string, args: string[]) {
  const result = execFileSync(process.execPath, [bin, ...args], {
    cwd: dir,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  return result
}

function repo() {
  const dir = mkdtempSync(join(tmpdir(), 'al-done-out-'))
  execFileSync('git', ['init', '-q'], { cwd: dir, windowsHide: true })
  execFileSync('git', ['config', 'user.email', 't@e.x'], { cwd: dir, windowsHide: true })
  execFileSync('git', ['config', 'user.name', 'T'], { cwd: dir, windowsHide: true })
  writeFileSync(join(dir, 'README.md'), 'x')
  execFileSync('git', ['add', '.'], { cwd: dir, windowsHide: true })
  execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: dir, windowsHide: true })
  execFileSync('git', ['branch', 'dev'], { cwd: dir, windowsHide: true })
  execFileSync('git', ['checkout', '-q', 'dev'], { cwd: dir, windowsHide: true })

  run(dir, ['init'])
  execFileSync('git', ['add', '.'], { cwd: dir, windowsHide: true })
  execFileSync('git', ['commit', '-q', '-m', 'setup'], {
    cwd: dir,
    env: { ...process.env, AL_ALLOW: '1' },
    windowsHide: true,
  })
  run(dir, ['executor', 'add', 'w1', '--skills', 'backend'])
  run(dir, ['task', 'add', 'Правка', '--dod', 'a', '--skill', 'backend', '--scope', 'src/**'])
  run(dir, ['task', 'list'])
  run(dir, ['take', 'T1', '--as', 'w1'])
  return dir
}

test('done отказывается закрывать задачу с правками вне области', () => {
  const dir = repo()
  mkdirSync(join(dir, 'src'), { recursive: true })
  mkdirSync(join(dir, 'docs'), { recursive: true })
  writeFileSync(join(dir, 'src/a.ts'), 'a')
  writeFileSync(join(dir, 'docs/b.md'), 'b')

  assert.throws(
    () => run(dir, ['done', 'T1', '--as', 'w1', '--summary', 'готово']),
    /вне области/,
  )

  const db = openDb(join(dir, '.toolbox-al/tracker.db'))
  const misses = listEvents(db, { subject: 'T1' }).filter((event) => event.type === 'task.outside_scope')
  assert.equal(misses.length, 0, 'отказ не должен записывать промах')
})

test('с --force-outside изменённый отслеживаемый файл попадает в коммит', () => {
  const dir = repo()
  mkdirSync(join(dir, 'src'), { recursive: true })
  mkdirSync(join(dir, 'docs'), { recursive: true })
  writeFileSync(join(dir, 'docs/b.md'), 'старое')
  execFileSync('git', ['add', 'docs/b.md'], { cwd: dir, windowsHide: true })
  execFileSync('git', ['commit', '-m', 'docs'], { cwd: dir, env: { ...process.env, AL_ALLOW: '1' }, windowsHide: true })

  writeFileSync(join(dir, 'src/a.ts'), 'a')
  writeFileSync(join(dir, 'docs/b.md'), 'b')

  const out = run(dir, ['done', 'T1', '--as', 'w1', '--summary', 'готово', '--force-outside'])
  assert.match(out, /закрыт/)

  const committed = execFileSync('git', ['show', '--name-only', '--pretty=format:', 'HEAD'], {
    cwd: dir,
    encoding: 'utf8',
    windowsHide: true,
  })
  assert.match(committed, /src\/a\.ts/)
  assert.match(committed, /docs\/b\.md/, 'правка отслеживаемого файла не должна теряться')
})

test('с --force-outside неотслеживаемый файл не попадает в коммит', () => {
  const dir = repo()
  mkdirSync(join(dir, 'src'), { recursive: true })
  writeFileSync(join(dir, 'src/a.ts'), 'a')
  writeFileSync(join(dir, '.env'), 'SECRET=1')

  const out = run(dir, ['done', 'T1', '--as', 'w1', '--summary', 'готово', '--force-outside'])
  assert.match(out, /закрыт/)

  const committed = execFileSync('git', ['show', '--name-only', '--pretty=format:', 'HEAD'], {
    cwd: dir,
    encoding: 'utf8',
    windowsHide: true,
  })
  assert.match(committed, /src\/a\.ts/)
  assert.doesNotMatch(committed, /\.env/, 'секрет не должен уехать в историю')

  const status = execFileSync('git', ['status', '--porcelain'], { cwd: dir, encoding: 'utf8', windowsHide: true })
  assert.match(status, /\.env/, 'неотслеживаемый файл остался в дереве')
})

test('с --force-outside промах области пишется в журнал', () => {
  const dir = repo()
  mkdirSync(join(dir, 'src'), { recursive: true })
  mkdirSync(join(dir, 'docs'), { recursive: true })
  writeFileSync(join(dir, 'src/a.ts'), 'a')
  writeFileSync(join(dir, 'docs/b.md'), 'b')

  run(dir, ['done', 'T1', '--as', 'w1', '--summary', 'готово', '--force-outside'])

  const db = openDb(join(dir, '.toolbox-al/tracker.db'))
  const misses = listEvents(db, { subject: 'T1' }).filter((event) => event.type === 'task.outside_scope')
  assert.equal(misses.length, 1)
  assert.deepEqual(JSON.parse(misses[0].after ?? '{}'), { files: ['docs/b.md'] })
  assert.equal(misses[0].actor, 'w1')
})

test('вне прогона done не добирает руки', () => {
  const dir = repo()
  run(dir, ['executor', 'add', 'w2', '--skills', 'backend'])
  run(dir, ['task', 'add', 'Вторая', '--dod', 'a', '--skill', 'backend', '--scope', 'docs/**'])

  const out = run(dir, ['done', 'T1', '--as', 'w1', '--summary', 'готово'])
  assert.match(out, /закрыт/)

  const db = openDb(join(dir, '.toolbox-al/tracker.db'))
  const hand = (
    db.prepare('select executor_id, task_id from hand').all() as Array<{
      executor_id: string
      task_id: string
    }>
  ).map((row) => ({ ...row }))
  assert.deepEqual(hand, [], 'прогон не идёт — руки остаются пустыми')
})

test('done добирает руки свободным исполнителям, не ломая ручной порядок', () => {
  const dir = repo()
  run(dir, ['executor', 'add', 'w2', '--skills', 'backend'])
  run(dir, ['task', 'add', 'Вторая', '--dod', 'a', '--skill', 'backend', '--scope', 'docs/**'])
  run(dir, ['task', 'add', 'Третья', '--dod', 'a', '--skill', 'backend', '--scope', 'assets/**'])
  run(dir, ['task', 'add', 'Четвёртая', '--dod', 'a', '--skill', 'backend', '--scope', 'tools/**'])
  // ручная выдача для w2: dispatch не должен ни отобрать её, ни переставить
  run(dir, ['hand', 'set', '--as', 'w2', 'T4'])
  // добор идёт только в прогоне: без него руки не наполняются
  run(dir, ['run', 'start', '--mode', 'all'])

  const out = run(dir, ['done', 'T1', '--as', 'w1', '--summary', 'готово'])
  assert.match(out, /закрыт/)

  const db = openDb(join(dir, '.toolbox-al/tracker.db'))
  const hand = (
    db.prepare('select executor_id, position, task_id from hand order by executor_id, position').all() as Array<{
      executor_id: string
      position: number
      task_id: string
    }>
  ).map((row) => ({ ...row }))

  assert.deepEqual(hand, [
    { executor_id: 'w1', position: 1, task_id: 'T2' },
    { executor_id: 'w2', position: 1, task_id: 'T4' },
    { executor_id: 'w2', position: 2, task_id: 'T3' },
  ])
})

test('done по задаче этапа добирает руки так же, как по задаче пула', () => {
  const dir = makeRepoWithDev()
  run(dir, ['init'])
  run(dir, ['executor', 'add', 'w1', '--skills', 'backend'])
  run(dir, ['executor', 'add', 'w2', '--skills', 'backend'])
  run(dir, ['request', 'add', 'Оплата'])
  run(dir, ['feature', 'add', 'Оплата', '--request', 'R1'])
  run(dir, ['stage', 'add', 'F1', 'S1', '--goal', 'можно платить', '--appetite', '2 дня'])
  run(dir, ['stage', 'activate', 'F1'])
  run(dir, ['task', 'add', 'F1.S1', 'Шаг', '--dod', 'а', '--skill', 'backend', '--scope', 'src/**'])
  run(dir, ['feature', 'start', 'F1'])
  run(dir, ['task', 'add', 'Добор', '--dod', 'б', '--skill', 'backend', '--scope', 'docs/**'])
  // добор идёт только в прогоне
  run(dir, ['run', 'start', '--mode', 'all'])

  const db = openDb(join(dir, '.toolbox-al/tracker.db'))
  const { worktree } = db.prepare("select worktree from features where id = 'F1'").get() as { worktree: string }
  db.close()

  run(worktree, ['take', 'F1.S1-1', '--as', 'w1'])
  mkdirSync(join(worktree, 'src'), { recursive: true })
  writeFileSync(join(worktree, 'src/a.ts'), 'a')
  const out = run(worktree, ['done', 'F1.S1-1', '--as', 'w1', '--summary', 'готово'])
  assert.match(out, /на ревью|закрыт/)

  const check = openDb(join(dir, '.toolbox-al/tracker.db'))
  const hand = (
    check.prepare('select executor_id, task_id from hand').all() as Array<{
      executor_id: string
      task_id: string
    }>
  ).map((row) => ({ ...row }))
  assert.deepEqual(hand, [{ executor_id: 'w1', task_id: 'T1' }], 'пул добрался той же рукой')
})

test('stage merge добирает руки свободным исполнителям', () => {
  const dir = makeRepoWithDev()
  run(dir, ['init'])
  run(dir, ['executor', 'add', 'w1', '--skills', 'backend'])
  run(dir, ['executor', 'add', 'w2', '--skills', 'backend'])
  run(dir, ['request', 'add', 'Оплата'])
  run(dir, ['feature', 'add', 'Оплата', '--request', 'R1'])
  run(dir, ['stage', 'add', 'F1', 'S1', '--goal', 'можно платить', '--appetite', '2 дня'])
  run(dir, ['stage', 'activate', 'F1'])
  run(dir, ['task', 'add', 'F1.S1', 'Шаг', '--dod', 'а', '--skill', 'backend', '--scope', 'src/**'])
  run(dir, ['task', 'add', 'Добор', '--dod', 'б', '--skill', 'backend', '--scope', 'docs/**'])
  run(dir, ['feature', 'start', 'F1'])

  const db = openDb(join(dir, '.toolbox-al/tracker.db'))
  refreshReady(db)
  const pool = db.prepare('select id from tasks where stage_id is null').get() as { id: string }
  // merge смотрит только на статус задачи: закрываем её без git-отчёта
  db.prepare("update tasks set status = 'done' where id = 'F1.S1-1'").run()
  db.close()
  // добор идёт только в прогоне
  run(dir, ['run', 'start', '--mode', 'all'])

  const merged = run(dir, ['stage', 'merge', 'F1.S1'])
  assert.match(merged, /слит/)

  const check = openDb(join(dir, '.toolbox-al/tracker.db'))
  const hand = (
    check.prepare('select executor_id, task_id from hand').all() as Array<{
      executor_id: string
      task_id: string
    }>
  ).map((row) => ({ ...row }))
  assert.deepEqual(hand, [{ executor_id: 'w1', task_id: pool.id }], 'свободная рука добрана после слияния')
})
