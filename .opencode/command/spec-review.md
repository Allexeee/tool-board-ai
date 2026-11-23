---
description: Проверка полноты spec карточки
subagent: false
---

Проверь spec карточки $1. Не редактируй код.

1. Прочитай `board card show $1 --json` и возьми `specReview.mode`.
2. `none` — скажи, что проверка не требуется.
3. `self` — проверь сам: problem/why, результат, критерии приёмки, non-goals,
   ограничения, зависимости, риски и возможность написать plan.
4. `subagent` — запусти `board-reviewer` и передай ему spec и acceptance.
5. Если spec неполный, сначала дополни его из контекста проекта, затем задай
   вопрос владельцу (`ask`/`block`) и запиши `--verdict reopen`.
6. Запиши результат: `board card spec-review $1 --as <ревьюер> --mode self|subagent --verdict done|reopen --note "..."`.
7. При вердикте `done` отправь карточку на утверждение: `board card submit $1 --as <исполнитель>` — без этого владелец не сможет `approve`. При `reopen` submit не делай.
8. Владелец утверждает spec через `board card approve $1`.
