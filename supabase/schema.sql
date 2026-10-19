-- ============================================================
-- Barebones Deck Builder — Supabase schema (normalized, per-user)
-- ------------------------------------------------------------
-- Run this ONE file in the Supabase dashboard:
--   SQL Editor → New query → paste → Run.
--
-- It is the COMPLETE schema. You do not need to run anything else.
-- It is fully IDEMPOTENT and re-runnable: every statement is guarded, so
-- running it twice (or on an existing database) is safe and never drops data.
--
-- Design (Moxfield-style per-user deck library):
--   • decks          — one row per named deck, owned by a user.
--   • deck_cards     — one row per (deck, scryfall printing, board).
--   • deck_tags      — the per-deck tag registry.
--   • deck_card_tags — join: which tags a card row carries.
--
-- IMPORTANT: no MTG card data is stored here. Only the Scryfall
-- printing `id` (scryfall_id), a quantity, and which board the card
-- is on. Names/images/rules/prices are fetched live from
-- api.scryfall.com/cards/collection when a deck is opened.
--
-- Row Level Security locks every row to its owner, so the public
-- anon/publishable key can only ever touch the signed-in user's data.
-- ============================================================

-- ------------------------------------------------------------
-- 1) decks
-- ------------------------------------------------------------
create table if not exists public.decks (
  id           uuid primary key default gen_random_uuid(),

  -- Owner. Defaults to the authenticated user so the client never
  -- has to (and never should) send someone else's id.
  user_id      uuid not null default auth.uid()
               references auth.users (id) on delete cascade,

  name         text not null,

  -- Format slug the app uses (e.g. "commander", "modern", "" for none).
  format       text not null default '',

  -- Optional single commander (the app allows exactly one). Stores the
  -- Scryfall printing id, not card data.
  commander_scryfall_id text,

  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),

  -- A user can only have one deck row per name.
  unique (user_id, name)
);

-- Metadata columns. Declared here too so a fresh install gets the full
-- `decks` shape from this single file; the `if not exists` guards make these
-- no-ops on an existing database.
alter table public.decks
  add column if not exists format                text not null default '',
  add column if not exists commander_scryfall_id text,
  add column if not exists description           text not null default '',
  add column if not exists is_public             boolean not null default false,
  add column if not exists color_identity        text not null default '';

create index if not exists decks_user_id_updated_idx
  on public.decks (user_id, updated_at desc);

-- ------------------------------------------------------------
-- 2) deck_cards
-- ------------------------------------------------------------
create table if not exists public.deck_cards (
  id          uuid primary key default gen_random_uuid(),

  deck_id     uuid not null
              references public.decks (id) on delete cascade,

  -- Scryfall *printing* id (the `id` field, NOT `oracle_id`), because the
  -- app supports choosing a specific printing.
  scryfall_id text not null,

  quantity    integer not null default 1 check (quantity > 0),

  -- Which board the card sits on.
  board_type  text not null default 'main'
              check (board_type in ('main', 'sideboard', 'considering'))
);

create index if not exists deck_cards_deck_id_idx
  on public.deck_cards (deck_id);

-- Helpful if you ever want "which of my decks run card X".
create index if not exists deck_cards_scryfall_idx
  on public.deck_cards (scryfall_id);

-- ------------------------------------------------------------
-- 3) deck_tags — the per-deck tag registry
--    Renaming a row here renames the tag on every card that uses it,
--    because deck_card_tags references the tag *id*, not its name.
-- ------------------------------------------------------------
create table if not exists public.deck_tags (
  id          uuid primary key default gen_random_uuid(),

  deck_id     uuid not null
              references public.decks (id) on delete cascade,

  name        text not null,
  created_at  timestamptz not null default now(),

  -- A deck can't have two tags with the same name.
  unique (deck_id, name)
);

create index if not exists deck_tags_deck_id_idx
  on public.deck_tags (deck_id);

-- ------------------------------------------------------------
-- 4) deck_card_tags — which tags a card row carries
-- ------------------------------------------------------------
create table if not exists public.deck_card_tags (
  deck_card_id uuid not null
               references public.deck_cards (id) on delete cascade,

  deck_tag_id  uuid not null
               references public.deck_tags (id) on delete cascade,

  primary key (deck_card_id, deck_tag_id)
);

create index if not exists deck_card_tags_card_idx
  on public.deck_card_tags (deck_card_id);

create index if not exists deck_card_tags_tag_idx
  on public.deck_card_tags (deck_tag_id);

-- ------------------------------------------------------------
-- 5) Keep updated_at fresh on every deck write
-- ------------------------------------------------------------
create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists decks_touch_updated_at on public.decks;
create trigger decks_touch_updated_at
  before update on public.decks
  for each row execute function public.touch_updated_at();

-- ------------------------------------------------------------
-- 6) Row Level Security
--    Enabled on ALL FOUR tables. RLS with no policies denies everything,
--    so every table below gets explicit owner-scoped policies.
-- ------------------------------------------------------------
alter table public.decks          enable row level security;
alter table public.deck_cards     enable row level security;
alter table public.deck_tags      enable row level security;
alter table public.deck_card_tags enable row level security;

-- ---- decks: owner-only ----
drop policy if exists "decks_select_own" on public.decks;
create policy "decks_select_own"
  on public.decks for select
  using (auth.uid() = user_id);

drop policy if exists "decks_insert_own" on public.decks;
create policy "decks_insert_own"
  on public.decks for insert
  with check (auth.uid() = user_id);

drop policy if exists "decks_update_own" on public.decks;
create policy "decks_update_own"
  on public.decks for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists "decks_delete_own" on public.decks;
create policy "decks_delete_own"
  on public.decks for delete
  using (auth.uid() = user_id);

-- ---- deck_cards: access is gated by the parent deck's owner ----
-- A helper predicate: does the current user own the deck this card row
-- belongs to? (SECURITY DEFINER avoids recursive RLS lookups, which would
-- otherwise error or silently deny.)
create or replace function public.owns_deck(d_id uuid)
returns boolean
language sql
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.decks
    where id = d_id and user_id = auth.uid()
  );
$$;

drop policy if exists "deck_cards_select_own" on public.deck_cards;
create policy "deck_cards_select_own"
  on public.deck_cards for select
  using (public.owns_deck(deck_id));

drop policy if exists "deck_cards_insert_own" on public.deck_cards;
create policy "deck_cards_insert_own"
  on public.deck_cards for insert
  with check (public.owns_deck(deck_id));

drop policy if exists "deck_cards_update_own" on public.deck_cards;
create policy "deck_cards_update_own"
  on public.deck_cards for update
  using (public.owns_deck(deck_id))
  with check (public.owns_deck(deck_id));

drop policy if exists "deck_cards_delete_own" on public.deck_cards;
create policy "deck_cards_delete_own"
  on public.deck_cards for delete
  using (public.owns_deck(deck_id));

-- ---- deck_tags: a user may touch tags whose deck they own ----
drop policy if exists "deck_tags_all_own" on public.deck_tags;
create policy "deck_tags_all_own"
  on public.deck_tags for all
  using  (public.owns_deck(deck_id))
  with check (public.owns_deck(deck_id));

-- ---- deck_card_tags: gated by ownership of the card's parent deck ----
-- Another SECURITY DEFINER predicate: does the current user own the deck that
-- this deck_cards row belongs to? Same anti-recursion rationale as above.
create or replace function public.owns_deck_card(dc_id uuid)
returns boolean
language sql
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.deck_cards dc
    join public.decks d on d.id = dc.deck_id
    where dc.id = dc_id and d.user_id = auth.uid()
  );
$$;

-- Split per command rather than FOR ALL, because the predicate depends on
-- deck_card_id; this is also the table auth.js deletes and inserts through.
drop policy if exists "deck_card_tags_select_own" on public.deck_card_tags;
create policy "deck_card_tags_select_own"
  on public.deck_card_tags for select
  using (public.owns_deck_card(deck_card_id));

drop policy if exists "deck_card_tags_insert_own" on public.deck_card_tags;
create policy "deck_card_tags_insert_own"
  on public.deck_card_tags for insert
  with check (public.owns_deck_card(deck_card_id));

drop policy if exists "deck_card_tags_delete_own" on public.deck_card_tags;
create policy "deck_card_tags_delete_own"
  on public.deck_card_tags for delete
  using (public.owns_deck_card(deck_card_id));
