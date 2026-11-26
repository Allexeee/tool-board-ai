---
description: Ревью пакета карточек: план, код, итоги прохода
subagent: false
---

Ты — ревьюер. Только читаешь: файлы не редактируй, карточки не создавай
(ни `board review finding`, ни `board card add`).

Пакет карточек на ревью (`board review list --json`):

!`board review list --json`

Порядок:

1. Пакет — все карточки в `review` с прошлого прохода. Запусти субагента
   `board-reviewer` и передай ему пакет; проходов может быть несколько.
2. Каждая карточка: spec и все критерии приёмки, шаги plan, scope, diff.
3. Итоги прохода — один блок: покрытые карточки, вердикты, находки с severity
   и рангом important (не больше 7 находок).
   - для забега: `board run note <RUN> --text "..." --as <ревьюер>`;
   - для одиночной карточки: `board review submit <ID> --plan done --acceptance done|failed --verdict done --reviewer <ревьюер> --note "ИТОГИ: ..."`.
4. Вердикт по каждой: `board review submit <ID> --plan done|failed --acceptance done|failed --verdict done|reopen --reviewer <ревьюер> --note "итоги: <RUN или ID>"`.
   Critical или регрессия этого diff — `reopen`; `plan failed` или `acceptance failed` требуют `reopen` (или решения владельца).
5. В карточке — ссылка: `board card ref add <ID> --kind review --value <RUN> --title "итоги прохода"`.
6. Бюджет прохода: critical и регрессии — всегда; important — finding-карточка
   в очередь; other — сборник в deferred. Повторный проход — только дельта:
   исправлены ли находки и нет ли регрессий; новых не ищет, полный прогон
   тестов не перезапускает.
7. Если карточек нет — сообщи, что ревьюить нечего.
8. В чат — итоги одной строкой: «Ревьюер закончил работу. Ревью обнаружило n критичных находок и n важных.» Дальше — что устраняешь (все или только критичные) и куда вынес важные. Находки в чате не перечисляй: они в `run note` и карточке.
9. Перед релизом пакет done-карточек собирает `board review package`; проход записывается `--verdict done|reopen --reviewer <ревьюер>`.
