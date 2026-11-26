-- fm — 친구 커스텀 팀 공유 표 (2026-11-26)
-- 비로그인(anon)으로도 공유 코드로 팀을 저장·조회합니다.
--   · 읽기: 누구나 (공유 코드를 아는 사람 = 링크를 받은 사람)
--   · 쓰기: 새 팀 추가만 (수정·삭제는 열지 않습니다 — 남의 팀을 덮어쓸 수 없게)
--   · 만든 사람의 원본은 브라우저(localStorage)에 남고, 공유는 그 사본입니다.
create table if not exists fm.custom_teams (
  code text primary key check (char_length(code) between 4 and 12),
  name text not null check (char_length(name) between 1 and 40),
  short text,
  size smallint not null check (size in (5, 6, 11)),
  formation text not null check (char_length(formation) between 2 and 12),
  colors jsonb,
  players jsonb not null check (jsonb_typeof(players) = 'array' and jsonb_array_length(players) between 1 and 12),
  tactic jsonb,
  views integer not null default 0,
  copies integer not null default 0,
  created_at timestamptz not null default now()
);

alter table fm.custom_teams enable row level security;

drop policy if exists custom_teams_read on fm.custom_teams;
create policy custom_teams_read on fm.custom_teams for select using (true);

drop policy if exists custom_teams_insert on fm.custom_teams;
create policy custom_teams_insert on fm.custom_teams for insert with check (true);

grant usage on schema fm to anon, authenticated;
grant select, insert on fm.custom_teams to anon, authenticated;
