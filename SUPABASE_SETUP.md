# Supabase + Google sign-in setup

This app runs **entirely in the browser** (static files). Supabase is used
**only** for two things:

1. **Google sign-in** (authentication)
2. **Cloud deck storage** (a `decks` table in Postgres)

> **Hosting note:** Supabase does *not* host static websites. The front-end is
> hosted on **GitHub Pages** (free). Supabase provides the database + auth.

Until you fill in `supabase-config.js`, the app runs in purely-local mode
(`localStorage`) and no sign-in button appears. Nothing breaks.

---

## Part 1 — Create the Supabase project (~2 min)

1. Go to <https://supabase.com> and sign in (GitHub login works).
2. **New project** → pick an organization, name it (e.g. `barebones-deck-builder`),
   choose a region near you, set a database password (save it somewhere).
3. Wait ~1 minute for it to provision.

## Part 2 — Create the tables + security rules (~1 min)

1. In the left sidebar, open **SQL Editor → New query**.
2. Open [`supabase/schema.sql`](supabase/schema.sql) from this repo, copy the
   **whole file**, paste it into the editor, and click **Run**.
3. You should see "Success". This creates two tables with **Row Level Security**
   so each user can only ever see their own decks:

   | Table | Holds |
   |---|---|
   | `decks` | One row per named deck: `name`, `format`, `commander_scryfall_id`, owner `user_id`. |
   | `deck_cards` | One row per card: `deck_id`, `scryfall_id`, `quantity`, `board_type` (`main`/`sideboard`/`considering`). |

   **No MTG card data is stored** — only Scryfall *printing ids* and quantities.
   Card names, images, and prices are fetched live from Scryfall when a deck is
   opened (one bulk `/cards/collection` call).

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
3. Go to **Authentication → URL Configuration**:
   - **Site URL**: your hosted app URL, e.g.
     `https://elfPirate.github.io/barebones-deck-builder/`
   - **Redirect URLs → Add URL**: the same URL (and add
     `http://localhost:8000/` if you develop locally).
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
| Signed in, but "row level security" error | You skipped `supabase/schema.sql` (Part 2), or RLS is on with no policies. Re-run the schema file. |
| Decks don't sync | Cloud syncs *named* decks on save. Check the colored dot in the top bar (green = synced). |
| "No decks in your account yet" on Load | You're signed in but haven't saved a deck to the cloud yet — build one and hit **Save** (File menu). |
| A card shows as missing after loading on another device | Its printing was removed/renamed by Scryfall; the rehydrate step skips ids Scryfall no longer returns. |

---

## How decks are stored & synced

```
localStorage (working cache)          Supabase (per-user library)
   barebones_decks  ──────save──────▶   decks (name, format, commander)
   barebones_current                     └─ deck_cards (scryfall_id, qty, board)
        ▲                                        │
        └──────────load / rehydrate◀─────────────┘
                       │
             GET /cards/collection  (Scryfall)
             → full card objects for display
```

- **Signed out:** everything lives in `localStorage` (this browser only).
- **Signed in:** the cloud is your deck *library*. Saving a named deck upserts
  the `decks` row and rewrites its `deck_cards` rows (ids + qty + board only).
  Loading a deck fetches those rows and rehydrates them from Scryfall.
- **First sign-in:** any decks already in `localStorage` are pushed up to your
  account, so nothing is lost.
