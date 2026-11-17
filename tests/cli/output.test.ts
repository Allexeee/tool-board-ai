import test from 'node:test'
import assert from 'node:assert/strict'
import { colorEnabled, paint, setColorMode, setJsonMode } from '../../src/cli/output.ts'

const ESC = /\u001b\[[0-9;]*m/g

function reset() {
  setColorMode(null)
  setJsonMode(false)
}

test('без терминала цвет выключен и текст остаётся прежним', () => {
  reset()
  try {
    const text = 'pending'
    assert.equal(colorEnabled({ isTTY: false, env: {} }), false)
    assert.equal(paint(text, 'gray', { isTTY: false, env: {} }), text)
  } finally {
    reset()
  }
})

test('в терминале статус красится, а под кодами текст тот же', () => {
  reset()
  try {
    const plain = 'wip'.padEnd(7)
    const colored = paint(plain, 'yellow', { isTTY: true, env: {} })
    assert.match(colored, /\u001b\[/)
    assert.equal(colored.replace(ESC, ''), plain)
  } finally {
    reset()
  }
})

test('статусы этапов различимы цветом', () => {
  reset()
  try {
    const context = { isTTY: true, env: {} }
    const codes = (['done', 'wip', 'pending'] as const).map((status) =>
      paint(status, status === 'done' ? 'green' : status === 'wip' ? 'yellow' : 'gray', context).replace(
        /^(\u001b\[[0-9;]*m).*$/,
        '$1',
      ),
    )
    assert.equal(new Set(codes).size, 3)
  } finally {
    reset()
  }
})

test('NO_COLOR выключает цвет даже в терминале', () => {
  reset()
  try {
    const context = { isTTY: true, env: { NO_COLOR: '1' } }
    assert.equal(colorEnabled(context), false)
    assert.equal(paint('done', 'green', context), 'done')
  } finally {
    reset()
  }
})

test('пустой NO_COLOR цвет не выключает', () => {
  reset()
  try {
    assert.equal(colorEnabled({ isTTY: true, env: { NO_COLOR: '' } }), true)
  } finally {
    reset()
  }
})

test('--json выключает цвет даже в терминале', () => {
  reset()
  try {
    setJsonMode(true)
    assert.equal(colorEnabled({ isTTY: true, env: {} }), false)
    assert.equal(paint('done', 'green', { isTTY: true, env: {} }), 'done')
    assert.equal(colorEnabled({ isTTY: true, env: {}, json: true }), false)
  } finally {
    reset()
  }
})

test('явный запрет цвета сильнее терминала', () => {
  reset()
  try {
    setColorMode(false)
    assert.equal(colorEnabled({ isTTY: true, env: {} }), false)
    assert.equal(paint('done', 'green', { isTTY: true, env: {} }), 'done')
  } finally {
    reset()
  }
})

test('явное включение цвета нужно для проверок с TTY', () => {
  reset()
  try {
    setColorMode(true)
    assert.match(paint('done', 'green', { isTTY: false, env: {} }), /\u001b\[32mdone\u001b\[0m/)
  } finally {
    reset()
  }
})
