import { closeSync, openSync, readFileSync, rmSync, statSync, writeSync } from 'node:fs'
import { UserError } from '../cli/errors.ts'

const LOCK_TIMEOUT_MS = 2000
const LOCK_RETRY_MS = 25
/** Lock старше этого возраста или с мёртвым PID — мусор после падения процесса. */
const LOCK_STALE_MS = 10 * 60 * 1000

/** Сон на главном потоке: в Node Atomics.wait разрешён, в браузере — нет. */
function sleep(ms: number): void {
  const sab = new SharedArrayBuffer(4)
  Atomics.wait(new Int32Array(sab), 0, 0, ms)
}

function isStale(lockPath: string): boolean {
  try {
    const stat = statSync(lockPath)
    if (Date.now() - stat.mtimeMs > LOCK_STALE_MS) return true
    const raw = readFileSync(lockPath, 'utf8').trim()
    const pid = Number(raw)
    if (!Number.isInteger(pid) || pid <= 0) return false
    try {
      process.kill(pid, 0)
      return false
    } catch (error) {
      return (error as { code?: string }).code === 'ESRCH'
    }
  } catch {
    return false
  }
}

/**
 * Блокировка по файлу: `openSync(lock, 'wx')` создаёт файл только если его нет.
 * Пока файл существует, другой процесс ждёт и пересоздаёт попытку. Спустя
 * ~2 секунды ожидания бросает ошибку, чтобы append не висел бесконечно.
 */
export function withFileLock<T>(lockPath: string, fn: () => T): T {
  const deadline = Date.now() + LOCK_TIMEOUT_MS
  let fd: number | null = null

  for (;;) {
    try {
      fd = openSync(lockPath, 'wx')
      writeSync(fd, String(process.pid))
      break
    } catch (error) {
      if ((error as { code?: string }).code !== 'EEXIST') throw error
      if (isStale(lockPath)) {
        try {
          rmSync(lockPath, { force: true })
          process.stderr.write(`lock ${lockPath} устарел: снят\n`)
        } catch {
          // кто-то уже снял — повторим попытку
        }
        continue
      }
      if (Date.now() >= deadline) {
        throw new UserError(3, `таймаут блокировки: ${lockPath} занят`)
      }
      sleep(Math.min(LOCK_RETRY_MS, deadline - Date.now()))
    }
  }

  try {
    return fn()
  } finally {
    if (fd !== null) closeSync(fd)
    try {
      rmSync(lockPath)
    } catch {
      // файл уже снят — не ошибка
    }
  }
}
