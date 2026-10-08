# Supabase + Google sign-in setup

This app runs **entirely in the browser** (static files on GitHub Pages).
Supabase provides **authentication** (Google sign-in) and **deck storage**
(Postgres). There is **no local deck storage** — the backend is the source of
truth. Only UI preferences (sort/group/view/dock sizes) and card caches live
in `localStorage`.

> **Hosting note:** Supabase does *not* host static websites. The front-end is
> hosted on **GitHub Pages** (free). Supabase provides the database + auth.

## Screens / flow

```
Home (sign in)  →  My Decks (library)  →  Deck Builder (autosaves)
```

- Signed out → **Home**.
- Signed in → **My Decks**, where you create/open/delete decks.
- Opening a deck → **Builder**, which **autosaves** to Supabase (debounced
  ~1s after you stop editing). There is no Save button.

---

## Part 1 — Create the Supabase project (~2 min)

1. Go to <https://supabase.com> and sign in (GitHub login works).
2. **New project** → pick an organization, name it (e.g. `barebones-deck-builder`),
   choose a region near you, set a database password (save it somewhere).
3. Wait ~1 minute for it to provision.

## Part 2 — Create the tables + security rules (~1 min)

There are **two** SQL files; run them **in order** via
**SQL Editor → New query → paste → Run**:

1. [`supabase/schema.sql`](supabase/schema.sql) — base tables.
2. [`supabase/migrations/001_tags_and_metadata.sql`](supabase/migrations/001_tags_and_metadata.sql)
   — deck metadata + the tag system. **Additive & idempotent** (safe to re-run;
   never drops data).

After both, you have:

| Table | Holds |
|---|---|
| `decks` | one row per deck: `name`, `format`, `commander_scryfall_id`, `description`, `is_public`, `color_identity`, owner `user_id`. |
| `deck_cards` | one row per card: `deck_id`, `scryfall_id`, `quantity`, `board_type` (`main`/`sideboard`/`considering`). |
| `deck_tags` | the per-deck **tag registry** (rename here = renamed everywhere). |
| `deck_card_tags` | join: which tags a card carries. |

All four have **Row Level Security** scoped to the owner, so the public
publishable key can only touch the signed-in user's data.

**No MTG card data is stored** — only Scryfall *printing ids*. Card names,
images, and prices are fetched live from Scryfall when a deck is opened.

## Part 3 — Create a Google OAuth client (~4 min)

Supabase needs a Google "client ID" and "client secret" so it can talk to Google.

1. Go to the Google Cloud Console: <https://console.cloud.google.com/>
2. Create a project (top bar → project selector → **New Project**), name it
   anything, then select it.
3. **APIs & Services → OAuth consent screen**
   - User type: **External** → **Create**.
   - App name, your support email, developer email → **Save and continue**.
   - Scopes: leave defaults (the `.../auth/userinfo.email`,
     `.../auth/userinfo.profile`, `openid` scopes are enough) → **Save**.
   - Test users: while in "Testing" mode, add **your own Google account** as a
     test user. (Publish the app later to allow anyone.)
4. **APIs & Services → Credentials → Create Credentials → OAuth client ID**
   - Application type: **Web application**.
   - Name: e.g. `Supabase Auth`.
   - **Authorized redirect URIs → Add URI**:
     ```
     https://<YOUR-PROJECT-REF>.supabase.co/auth/v1/callback
     ```
     Find `<YOUR-PROJECT-REF>` in Supabase: **Project Settings → API → Project URL**
     (it's the `abcdefgh` part of `https://abcdefgh.supabase.co`).
   - **Create**. Copy the **Client ID** and **Client secret**.

## Part 4 — Enable Google in Supabase (~1 min)

1. Supabase dashboard → **Authentication → Providers → Google** → toggle **on**.
2. Paste the **Client ID** and **Client secret** from Part 3 → **Save**.





3. Go to **Authentication → URL Configuration** and enter these:

   | Field | Value | Rule |
   |---|---|---|
   | **Site URL** | `https://<user>.github.io` | **Origin only** — no path, no trailing slash |
   | **Redirect URLs** | `https://<user>.github.io/<repo>` | Path OK, **no trailing slash** |

   For this repo specifically:

   ```
   Site URL:        https://elfPirate.github.io
   Redirect URLs:   https://elfPirate.github.io/barebones-deck-builder
                    http://localhost:8000            (optional, for local dev)
   ```

   > ⚠️ **`Invalid Origin: URIs must not contain a path or end with "/"`**
   > This error means you put a path or a trailing slash in a field that
   > forbids it. Fixes:
   > - **Site URL** must be a bare origin → `https://elfPirate.github.io`
   >   (drop `/barebones-deck-builder/`).
   > - **Redirect URLs**: a path is allowed, but **remove the trailing `/`**
   >   → `https://elfPirate.github.io/barebones-deck-builder`.
   >
   > The app itself sends the return URL **without** a trailing slash, so the
   > Redirect-URL entry above must match it exactly.

4. Save.

## Part 5 — Put the keys in `supabase-config.js`

1. Supabase → **Project Settings → API**.
2. Copy the **Project URL** and the **anon / publishable key** into
   [`supabase-config.js`](supabase-config.js):

   ```js
   window.SUPABASE_CONFIG = {
     url: "https://abcdefgh.supabase.co",
     anonKey: "eyJhbGciOi....",
   };
   ```

   Both values are **public by design** — RLS protects the data. **Never** put
   the `service_role` key here.

3. Commit and push. Done — a **Sign in with Google** button appears in the top bar.

---

## Enable GitHub Pages (hosting)

1. Push this repo to GitHub (already done).
2. GitHub repo → **Settings → Pages**.
3. **Source**: "Deploy from a branch" → **Branch: `main`**, folder **`/` (root)** → Save.
4. Wait ~1 min; the site publishes at
   `https://<user>.github.io/<repo>/`.
5. Make sure this exact URL is set as the **Site URL** and a **Redirect URL**
   in Supabase (Part 4, step 3).

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| No sign-in button | `supabase-config.js` still has blank `url`/`anonKey`. |
| `redirect_uri_mismatch` from Google | The Supabase callback URL in Google's redirect URIs must exactly match `https://<ref>.supabase.co/auth/v1/callback`. |
| Redirects to `localhost` after sign-in | Update **Site URL** and **Redirect URLs** in Supabase to your GitHub Pages URL. |
| Signed in, but "row level security" error | You skipped a SQL file in Part 2, or RLS is on with no policies. Re-run both files. |
| Deck save fails silently | Missing `decks`/`deck_cards`/`deck_tags` tables — run the migration (Part 2). |
| A card shows as missing after loading on another device | Its printing was removed/renamed by Scryfall; the rehydrate step skips ids Scryfall no longer returns. |

---

## How decks are stored & synced

```
                Supabase (source of truth, per user)
   decks  ──▶  name, format, commander, description, is_public, color_identity
     │
     ├─ deck_cards ──▶ scryfall_id, qty, board_type
     └─ deck_tags  ──▶ tag registry (per deck)
            ▲  └─ deck_card_tags ──▶ which tag on which card
            │
        autosave (debounced)   saveDeck(deckId, payload)
            │
        openDeck(deckId)  ──▶  GET /cards/collection (Scryfall)
                               → full card objects for display
```

- Every edit (qty, add/remove, tag, rename) triggers a **debounced autosave**
  (~900ms idle). The builder shows **Saved / Saving… / Save failed**.
- Tags are **per-deck**. Renaming a tag updates every card that uses it.
- Import/export use Moxfield-style lines: `1 Sol Ring #ramp #mana`.
