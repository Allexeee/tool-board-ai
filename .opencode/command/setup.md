---
description: Настройки доски
subagent: false
---

Покажи `board setup --show --json` и спроси владельца:

- spec review: auto/none/self/subagent;
- порог для max, символов (0 — выключить правило);
- большой spec для остальных уровней, символов (0 — выключить правило);
- run review: none/self/subagent/auto (проверяет plan и код);
- модель ревьюера: provider/model без #variant.

Затем выполни:

```bash
board setup --spec-review <mode> --max-spec <n> --large-spec <n> --run-review <mode> --reviewer-model <provider/model>
```

Если владелец не хочет менять настройку — ничего не выполняй.
