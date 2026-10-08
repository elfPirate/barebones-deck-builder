-- ============================================================
-- Barebones Deck Builder — Migration 001: deck metadata + tags
-- ------------------------------------------------------------
-- Run in the Supabase dashboard: SQL Editor → New query → paste → Run.
--
-- ADDITIVE ONLY — nothing is dropped, so existing cloud decks keep
-- working. Safe to re-run (idempotent).
--
-- Adds:
--   • decks:  description, is_public, color_identity
--   • deck_tags        — a per-deck tag REGISTRY (rename here = renamed
--                        everywhere, because cards reference the tag id).
--   • deck_card_tags   — join table: which tags a deck_cards row carries.
--
-- Tags are PER-DECK (Moxfield-style). All access is owner-gated via the
-- parent deck's user_id, same as deck_cards.
-- ============================================================

-- ------------------------------------------------------------
-- 1) Extra columns on decks (metadata)
-- ------------------------------------------------------------
alter table public.decks
  add column if not exists description    text not null default '',
  add column if not exists is_public      boolean not null default false,
  add column if not exists color_identity text not null default '';

-- ------------------------------------------------------------
-- 2) deck_tags — the per-deck tag registry
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

create index if not exists deck_tags_deck_id_idx on public.deck_tags (deck_id);

-- ------------------------------------------------------------
-- 3) deck_card_tags — which tags a card row carries
-- ------------------------------------------------------------
create table if not exists public.deck_card_tags (
  deck_card_id uuid not null
               references public.deck_cards (id) on delete cascade,
  deck_tag_id  uuid not null
               references public.deck_tags (id) on delete cascade,
  primary key (deck_card_id, deck_tag_id)
);

create index if not exists deck_card_tags_card_idx on public.deck_card_tags (deck_card_id);
create index if not exists deck_card_tags_tag_idx  on public.deck_card_tags (deck_tag_id);

-- ------------------------------------------------------------
-- 4) RLS — owner-gated through the parent deck
-- ------------------------------------------------------------
alter table public.deck_tags      enable row level security;
alter table public.deck_card_tags enable row level security;

-- deck_tags: a user may touch tags whose deck they own.
drop policy if exists "deck_tags_all_own" on public.deck_tags;
create policy "deck_tags_all_own"
  on public.deck_tags for all
  using  (public.owns_deck(deck_id))
  with check (public.owns_deck(deck_id));

-- deck_card_tags: a user may touch joins whose *card* and *tag* both belong
-- to a deck they own. We check via owns_deck() on the card's parent deck.
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

-- ------------------------------------------------------------
-- 5) RLS on decks for the new columns is unchanged (row-level policy
--    already covers all columns). Nothing else to do.
-- ------------------------------------------------------------
