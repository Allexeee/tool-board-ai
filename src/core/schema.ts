import type { DatabaseSync } from 'node:sqlite'

export const SCHEMA_VERSION = 13

const DDL_V1 = `
create table if not exists meta (
  key   text primary key,
  value text not null
);

create table if not exists events (
  id      integer primary key autoincrement,
  at      text not null,
  type    text not null,
  actor   text not null,
  subject text not null,
  before  text,
  after   text,
  note    text
);
create index if not exists idx_events_subject on events(subject, id);

create table if not exists executors (
  id         text primary key,
  kind       text not null,
  skills     text not null,
  wip_limit  integer not null default 1,
  hand_size  integer not null default 5,
  session    text,
  last_seen  text,
  -- модель и права добавляет миграция 8, steps есть сразу: у новой базы дефолт 60
  steps      integer not null default 60
);

create table if not exists requests (
  id         text primary key,
  title      text not null,
  body       text not null,
  status     text not null,
  author     text not null,
  created_at text not null,
  review_at  text
);

create table if not exists features (
  id            text primary key,
  request_id    text references requests(id),
  name          text not null,
  rank          integer not null,
  status        text not null,
  appetite      text,
  review_policy text not null default 'auto',
  created_at    text not null
);

create table if not exists stages (
  id         text primary key,
  feature_id text not null references features(id),
  seq        integer not null,
  name       text not null,
  goal       text not null,
  appetite   text,
  status     text not null,
  acceptance text not null default 'auto'
);
create index if not exists idx_stages_feature on stages(feature_id, seq);

create table if not exists tasks (
  id          text primary key,
  stage_id    text references stages(id),
  title       text not null,
  kind        text not null default 'task',
  dod         text not null,
  check_cmd   text,
  size        text not null,
  size_reason text,
  skill       text not null,
  class       text not null,
  scope       text not null,
  status      text not null,
  holder      text,
  lease_until text,
  attempts    integer not null default 0,
  reason      text,
  created_at  text not null
);
create index if not exists idx_tasks_status on tasks(status);
create index if not exists idx_tasks_stage on tasks(stage_id);

create table if not exists deps (
  from_id text not null,
  to_id   text not null,
  primary key (from_id, to_id)
);

create table if not exists hand (
  executor_id text not null,
  position    integer not null,
  task_id     text not null,
  reserved_at text not null,
  primary key (executor_id, task_id)
);
create unique index if not exists idx_hand_task on hand(task_id);

create table if not exists questions (
  id             text primary key,
  addressee      text not null,
  text           text not null,
  options        text,
  subject_type   text not null,
  subject_id     text not null,
  deadline       text,
  timeout_policy text not null default 'block',
  status         text not null default 'pending',
  answer         text,
  answered_by    text,
  answered_at    text,
  created_at     text not null
);
create index if not exists idx_questions_addressee on questions(addressee, status);

create table if not exists reviews (
  id       integer primary key autoincrement,
  task_id  text not null,
  reviewer text not null,
  verdict  text not null,
  comments text,
  at       text not null
);
`

export function schemaVersionOf(db: DatabaseSync): number {
  db.exec('create table if not exists meta (key text primary key, value text not null)')
  const row = db.prepare("select value from meta where key = 'schemaVersion'").get() as { value: string } | undefined
  return row ? Number(row.value) : 0
}

export function migrate(db: DatabaseSync): number {
  const from = schemaVersionOf(db)
  if (from >= SCHEMA_VERSION) return from

  db.exec('begin immediate')
  try {
    if (from < 1) db.exec(DDL_V1)
    if (from < 2) db.exec('alter table tasks add column severity text')
    if (from < 3) {
      db.exec('alter table features add column branch text')
      db.exec('alter table features add column worktree text')
      db.exec('alter table features add column check_cmd text')
      db.exec('alter table stages add column merged_at text')
      db.exec(
        'create table if not exists releases (' +
          'id integer primary key autoincrement, ' +
          'version text not null, ' +
          'tag text not null, ' +
          'changelog text not null, ' +
          'at text not null)',
      )
    }
    if (from < 4) {
      db.exec('alter table tasks add column review text not null default \'agent\'')
      db.exec(
        'create table if not exists ideas (' +
          'id text primary key, text text not null, source text not null, ' +
          'review_at text, promoted_to text, created_at text not null)',
      )
      db.exec(
        'create table if not exists decisions (' +
          'id text primary key, question text not null, choice text not null, ' +
          'alternatives text, reason text not null, subject_id text, ' +
          'author text not null, created_at text not null)',
      )
      db.exec(
        'create table if not exists plans (' +
          'id text primary key, request_id text not null, version integer not null, ' +
          'title text not null, assumptions text not null, steps text not null, ' +
          'approved_at text, approved_by text, applied_at text, feature_id text, ' +
          'created_at text not null)',
      )
      db.exec('create unique index if not exists idx_plans_request_version on plans(request_id, version)')
    }
    if (from < 5) {
      db.exec(
        'create table if not exists routines (' +
          'id text primary key, name text not null, schedule text not null, ' +
          'window text, timezone text not null, guard text, created_at text not null)',
      )
      db.exec(
        'create table if not exists routine_steps (' +
          'id text primary key, routine_id text not null, seq integer not null, ' +
          'title text not null, kind text not null, skill text, command text, ' +
          'dod text, scope text, on_missing text not null, created_at text not null)',
      )
      db.exec(
        'create table if not exists routine_runs (' +
          'id text primary key, routine_id text not null, due_at text not null, ' +
          'status text not null, started_at text, finished_at text, note text)',
      )
      db.exec(
        'create unique index if not exists idx_runs_routine_due on routine_runs(routine_id, due_at)',
      )
      db.exec(
        'create table if not exists gates (' +
          'id text primary key, routine_id text not null, step_id text, ' +
          'kind text not null, name text not null, once integer not null default 0, ' +
          'satisfied_at text, payload text)',
      )
    }
    if (from < 6) {
      db.exec('alter table routines add column escalated_at text')
    }
    if (from < 7) {
      db.exec('alter table plans add column stale_at text')
    }
    if (from < 8) {
      // модель, права и лимит шагов превращают исполнителя в агента OpenCode
      db.exec('alter table executors add column model text')
      db.exec("alter table executors add column permissions text not null default '[]'")
      // у новой базы steps уже есть из create table с дефолтом 60;
      // апгрейд старой базы получает прежний дефолт 20 — backfill не делаем
      const hasSteps = db
        .prepare("select 1 as found from pragma_table_info('executors') where name = 'steps'")
        .get()
      if (!hasSteps) db.exec('alter table executors add column steps integer not null default 20')
    }
    if (from < 9) {
      // задача помнит сессию, в которой её делают: доработка возвращается туда же
      db.exec('alter table tasks add column session text')
      // этап ушёл в dev — помнить сессии его задач больше не нужно
      db.exec(
        'create trigger if not exists trg_stage_merged_clears_task_sessions ' +
          'after update of status on stages ' +
          "when new.status = 'merged' and old.status <> 'merged' " +
          'begin ' +
          'update tasks set session = null where stage_id = new.id; ' +
          'end',
      )
    }
    if (from < 10) {
      // прогон (RUN) — запись в базе, а не договорённость в чате:
      // с чем стартовали, когда, чем закончили; незакрытый прогон один
      db.exec(
        'create table if not exists runs (' +
          'id text primary key, ' +
          "mode text not null, requests text not null default '[]', " +
          'nearest integer not null default 0, approve integer not null default 0, ' +
          "power text not null default 'none', " +
          'started_at text not null, ended_at text, end_reason text)',
      )
      db.exec('create index if not exists idx_runs_started on runs(started_at)')
    }
    if (from < 11) {
      // старый дефолт 20 шагов душил агента на середине: поднимаем тем, у кого он остался.
      // явные значения (кроме совпавших с дефолтом) не трогаем — отличить нельзя, поэтому только 20.
      db.prepare('update executors set steps = 60 where steps = 20').run()
    }
    if (from < 12) {
      // задача помнит раздел спеки, из которого выросла: на приёмке видно, с чем сверять.
      // колонку проверяем отдельно: метка версии могла отстать от фактической схемы
      const hasSpec = db
        .prepare("select 1 as found from pragma_table_info('tasks') where name = 'spec'")
        .get()
      if (!hasSpec) db.exec('alter table tasks add column spec text')
    }
    if (from < 13) {
      // прогон переживает сессии: сегмент растёт с каждой передачей эстафеты.
      // у прогонов, начатых до схемы 13, сегмент первый — они не потеряны
      const hasSegment = db
        .prepare("select 1 as found from pragma_table_info('runs') where name = 'segment'")
        .get()
      if (!hasSegment) db.exec('alter table runs add column segment integer not null default 1')
    }
    db.prepare(
      "insert into meta (key, value) values ('schemaVersion', ?) " +
      'on conflict(key) do update set value = excluded.value',
    ).run(String(SCHEMA_VERSION))
    db.exec('commit')
  } catch (error) {
    db.exec('rollback')
    throw error
  }

  return SCHEMA_VERSION
}

