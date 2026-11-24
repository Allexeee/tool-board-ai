import type { BacklogData, BacklogRow } from './backlog.ts'

/** Тёмная тема в духе панели OpenCode: фон, моноширинные ID, спокойные таблицы. */
const STYLE = `
:root {
  --bg: #0f0f10;
  --panel: #171718;
  --line: #26262a;
  --text: #e7e7e8;
  --muted: #8b8b90;
  --accent: #7aa2f7;
}
* { box-sizing: border-box; }
body {
  margin: 0;
  background: var(--bg);
  color: var(--text);
  font: 14px/1.55 -apple-system, "Segoe UI", Roboto, "Helvetica Neue", sans-serif;
}
.wrap { max-width: 980px; margin: 0 auto; padding: 28px 24px 64px; }
header { display: flex; align-items: baseline; justify-content: space-between; gap: 16px; }
h1 { font-size: 26px; font-weight: 650; margin: 0 0 6px; letter-spacing: -0.01em; }
.updated { color: var(--muted); font-size: 12px; font-variant-numeric: tabular-nums; }
.hint { color: var(--muted); font-size: 12px; margin: 0 0 22px; }
.hint code { font-family: "SF Mono", Consolas, monospace; font-size: 12px; }
section { margin-top: 26px; }
h2 { font-size: 15px; font-weight: 600; margin: 0 0 10px; color: var(--text); }
table { width: 100%; border-collapse: collapse; background: var(--panel); border: 1px solid var(--line); border-radius: 10px; overflow: hidden; }
th { text-align: left; font-size: 11px; letter-spacing: 0.06em; text-transform: uppercase; color: var(--muted); font-weight: 600; padding: 9px 14px; border-bottom: 1px solid var(--line); }
td { padding: 10px 14px; border-bottom: 1px solid var(--line); vertical-align: top; }
tr:last-child td { border-bottom: none; }
td.id { font-family: "SF Mono", Consolas, monospace; font-size: 12px; color: var(--accent); white-space: nowrap; }
td.status { white-space: nowrap; }
td.note { color: var(--muted); }
.empty { color: var(--muted); }
`

function esc(value: string): string {
  return value.replace(/[&<>"]/g, (ch) => {
    const map: Record<string, string> = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
    }
    return map[ch]
  })
}

function fmt(iso: string): string {
  const date = new Date(iso)
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${pad(date.getDate())}.${pad(date.getMonth() + 1)} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function table(headers: string[], rows: string[][]): string {
  if (rows.length === 0) return '<p class="empty">пусто</p>'
  const head = headers.map((header) => `<th>${esc(header)}</th>`).join('')
  const body = rows.map((cells) => `<tr>${cells.join('')}</tr>`).join('')
  return `<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`
}

function rowsFor(rows: BacklogRow[]): string[][] {
  return rows.map((item) => [
    `<td class="id">${esc(item.id)}</td>`,
    `<td>${esc(item.title)}</td>`,
    `<td class="status">${esc(item.status)}</td>`,
    `<td class="note">${esc(item.note)}</td>`,
  ])
}

/** Самодостаточный HTML-снимок бэклога: открыть в браузере, F5 — обновить. */
export function renderBacklogPage(data: BacklogData): string {
  const parts: string[] = []
  for (const section of data.skills) {
    parts.push(
      `<section><h2>Задачи для ${esc(section.label)}</h2>` +
        table(['ID', 'Заголовок', 'Статус', 'Заметка'], rowsFor(section.rows)) +
        '</section>',
    )
  }
  if (data.skills.length === 0) parts.push('<p class="empty">Открытых карточек нет.</p>')

  if (data.deferred.length > 0) {
    const rows = data.deferred.map((item) => [
      `<td class="id">${esc(item.id)}</td>`,
      `<td>${esc(item.title)}</td>`,
      `<td class="note">${esc(item.note)}</td>`,
    ])
    parts.push(
      `<section><h2>Отложенные</h2>${table(['ID', 'Заголовок', 'Причина'], rows)}</section>`,
    )
  }

  if (data.done.length > 0) {
    const rows = data.done.map((item) => [
      `<td class="id">${esc(item.id)}</td>`,
      `<td>${esc(item.title)}</td>`,
      `<td class="note">${fmt(item.doneAt)}</td>`,
    ])
    parts.push(
      `<section><h2>Готово за последние 12 часов</h2>${table(['ID', 'Заголовок', 'Завершено'], rows)}</section>`,
    )
  }

  return `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Бэклог</title>
<style>${STYLE}</style>
</head>
<body>
<div class="wrap">
<header><h1>Бэклог</h1><span class="updated">обновлено ${fmt(data.generatedAt)} · F5</span></header>
<p class="hint">Собрано из <code>.board/board.db</code>. Обновить: пересобрать файл и нажать F5.</p>
${parts.join('\n')}
</div>
</body>
</html>
`
}
