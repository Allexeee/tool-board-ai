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
  font: 16px/1.6 -apple-system, "Segoe UI", Roboto, "Helvetica Neue", sans-serif;
}
.wrap { max-width: 1040px; margin: 0 auto; padding: 32px 28px 72px; }
header { display: flex; align-items: flex-start; justify-content: space-between; gap: 20px; }
h1 { font-size: 30px; font-weight: 650; margin: 0 0 6px; letter-spacing: -0.01em; }
.meta { display: flex; align-items: center; gap: 14px; }
.updated { color: var(--muted); font-size: 13px; font-variant-numeric: tabular-nums; }
.refresh {
  font: inherit;
  font-size: 13px;
  color: var(--text);
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 8px;
  padding: 7px 14px;
  cursor: pointer;
}
.refresh:hover { border-color: var(--accent); color: var(--accent); }
.refresh:active { transform: translateY(1px); }
.hint { color: var(--muted); font-size: 13px; margin: 6px 0 24px; }
.hint code { font-family: "SF Mono", Consolas, monospace; font-size: 13px; }
section { margin-top: 28px; }
h2 { font-size: 17px; font-weight: 600; margin: 0 0 10px; color: var(--text); }
table { width: 100%; border-collapse: collapse; background: var(--panel); border: 1px solid var(--line); border-radius: 10px; overflow: hidden; font-size: 15px; }
th { text-align: left; font-size: 12px; letter-spacing: 0.06em; text-transform: uppercase; color: var(--muted); font-weight: 600; padding: 10px 16px; border-bottom: 1px solid var(--line); }
td { padding: 12px 16px; border-bottom: 1px solid var(--line); vertical-align: top; }
tr:last-child td { border-bottom: none; }
td.id { font-family: "SF Mono", Consolas, monospace; font-size: 14px; color: var(--text); white-space: nowrap; }
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

/** Самодостаточный HTML-снимок бэклога. refreshSeconds > 0 — страница сама перезагружается. */
export function renderBacklogPage(data: BacklogData, refreshSeconds = 5): string {
  const auto = refreshSeconds > 0
  const scripts =
    `<script>
(function () {
  var key = 'board-backlog-scroll'
  function save() { try { sessionStorage.setItem(key, String(window.scrollY)) } catch (e) {} }
  function restore() { try { var y = sessionStorage.getItem(key); if (y !== null) window.scrollTo(0, Number(y)) } catch (e) {} }
  window.boardReload = function () { save(); location.reload() }
  window.addEventListener('scroll', save, { passive: true })
  window.addEventListener('pagehide', save)
  restore()
})()
</script>` +
    (auto
      ? `<script>
setInterval(function () {
  if (document.visibilityState !== 'visible') return
  window.boardReload()
}, ${Math.round(refreshSeconds) * 1000})
</script>`
      : '')
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

  if (data.ideas.length > 0) {
    const rows = data.ideas.map((item) => [
      `<td class="id">${esc(item.id)}</td>`,
      `<td>${esc(item.text)}</td>`,
      `<td class="note">${fmt(item.updatedAt)}</td>`,
    ])
    parts.push(
      `<section><h2>Идеи</h2>${table(['ID', 'Идея', 'Изменено'], rows)}</section>`,
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
<header>
  <h1>Бэклог</h1>
  <div class="meta">
    <span class="updated">обновлено ${fmt(data.generatedAt)} · ${
      auto ? `авто ${Math.round(refreshSeconds)} с` : 'F5'
    }</span>
    <button class="refresh" type="button" onclick="boardReload()">Обновить</button>
  </div>
</header>
<p class="hint">Собрано из <code>.board/board.db</code>. Доска пересобирает файл после каждой команды. ${
    auto ? 'Страница обновляется сама' : 'Обновить вручную'
  } — кнопка «Обновить»${auto ? '' : ' или F5'}.</p>
${parts.join('\n')}
</div>
${scripts}
</body>
</html>
`
}
