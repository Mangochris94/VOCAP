-- Vocap leaderboard schema
-- Run this once in the Supabase SQL Editor (your project > SQL Editor > New query).
-- No subscription/auth required yet - every score is tied to a random per-device
-- id generated the first time a browser submits one, not to a real account.
-- Table names are prefixed vocap_ to stay out of the way of anything else
-- already living in this project (subscriptions, payments, etc).

create table if not exists vocap_race_scores (
  id bigint generated always as identity primary key,
  player_id text not null,
  name text not null,
  score int not null,
  words int not null,
  lang text not null default 'en' check (lang in ('en','th')),
  created_at timestamptz not null default now()
);

create table if not exists vocap_classic_scores (
  player_id text not null,
  lang text not null default 'en' check (lang in ('en','th')),
  name text not null,
  words_found int not null default 0,
  sparks int not null default 0,
  longest_word text,
  longest_len int not null default 0,
  updated_at timestamptz not null default now(),
  primary key (player_id, lang)
);

alter table vocap_race_scores enable row level security;
alter table vocap_classic_scores enable row level security;

-- Open leaderboard for now: anyone can read, anyone can submit their own
-- score. When you're ready to gate this to subscribers, swap these insert
-- policies to check auth.uid() against your subscriptions table instead.
create policy "public read race scores" on vocap_race_scores
  for select using (true);
create policy "public insert race scores" on vocap_race_scores
  for insert with check (true);

create policy "public read classic scores" on vocap_classic_scores
  for select using (true);
create policy "public insert classic scores" on vocap_classic_scores
  for insert with check (true);
create policy "public update classic scores" on vocap_classic_scores
  for update using (true);

-- speeds up "top 20 by score/words for this language" queries
create index if not exists idx_race_scores_lang_score
  on vocap_race_scores (lang, score desc);
create index if not exists idx_classic_scores_lang_words
  on vocap_classic_scores (lang, words_found desc);
