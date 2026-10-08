# Barebones Deck Builder

A minimal Magic: The Gathering deck builder inspired by Moxfield, with live
[Scryfall](https://scryfall.com/docs/api) search integration.

No build step — it's plain HTML/CSS/JS. Just open it in a browser.

## Run it

```bash
open "index.html"
```

Or serve it locally (recommended so fetch requests behave consistently):

```bash
python3 serve.py            # starts a server and opens the app
python3 -m http.server 8080 # or any static server, then visit localhost:8080
```

`serve.py` opens the app in your browser and shuts itself down a few seconds
after you close the tab. **Reloading is safe** — it keeps the server running.
Pass `--no-exit` to disable auto-shutdown, or `--no-browser` to skip launching
a browser. Double-click **`Open Deck Builder.command`** in Finder for the same
thing.

## Features

- **VS Code-style layout** — three columns: **Search** on the left, **Deck**
  in the center (with collapsible, resizable **Considering** and **Sideboard**
  sections docked at the bottom), and **Card Preview + Stats** on the right.
- **Scryfall search** — full query syntax support: card names, and advanced
  filters like `t:creature`, `cmc<=3`, `o:flying`, `c:wu`, `r:mythic`, etc.
  Results are fetched live from Scryfall (`/cards/search`).
  - `f:commander`, `sort:edhrec`, and `prefer:notub` are **always appended**
    to your query (each only once — typing them yourself won't duplicate).
    This restricts results to Commander-legal cards, sorts by EDHREC rank
    (most popular first), and pushes unranked/newly-spoiled cards down.
  - Each result shows its `#EDHREC rank` badge.
- **Add to deck** — click any search result (or its image) to add a copy.
- **Commander** — designate any card as your commander:
  - Open a deck card's `⋯` menu (or right-click the card) → **Set as commander**.
  - The commander appears in its own **Commander** section at the very top of
    the deck, above the type sections, highlighted in gold.
  - The chosen commander is saved with the deck and exported under a
    `// Commander` header.
- **Card actions menu** — every deck card has a `⋯` button (also available on
  right-click) that opens a small context menu with card actions:
  **Set/Unset commander**, **Move to Considering**, **Change printing…**, and
  **Remove from deck**. Considering/sideboard cards get their own move actions
  plus **Change printing…**. This menu is the home for future per-card actions.
- **Change printing** — from a card's `⋯` menu, open **Change printing…** to
  browse every printing of that card (fetched from Scryfall) as a grid of
  card images with set, collector number, and price. Click a printing to swap
  it in; the quantity is preserved, and if you already own that printing the
  copies are merged. Works in the deck, sideboard, and Considering boards.
  - **Cheapest / Most recent quick-picks** — inside the printing picker, the
    **▼ Cheapest** and **✦ Most recent** buttons swap the card to its
    lowest-priced or newest printing in one click.
- **Bulk printing swap** — the Deck panel header has **▼ Cheapest printing**
  and **✦ Newest printing** buttons that retarget **every** card in the deck,
  sideboard, and Considering boards to its cheapest or most recently released
  printing. Each unique card is fetched from Scryfall (throttled to respect
  rate limits) and swapped in place, preserving quantities and merging
  duplicates.
- **Drag & drop** — drag cards between panels:
  - Search result → **Deck** adds it; → **Considering** adds it to the board.
  - Deck → **Considering** moves it to the board.
  - Considering → **Deck** moves it into the deck.
  - Deck/Considering → **Search** removes the card.
  Valid drop targets highlight as you drag.
- **Considering & Sideboard boards** — Moxfield-style holding areas, docked
  at the bottom of the deck. Both are **collapsible** (click the header) and
  **resizable** (drag the top edge, or double-click it to reset). Their open
  state and height are remembered.
  - **Considering**: click the `+☆` button on a search result, or drag a card
    onto the board, to send it to Considering.
  - **Sideboard**: drag cards onto the board, or use a card's `⋯` menu →
    **Move to sideboard**. Open a sideboard card's `⋯` menu →
    **Move to deck** / **Move to Considering**.
  - A deck card's `⋯` menu → **Move to Considering** / **Move to sideboard**.
  - Both boards are sorted by EDHREC rank and auto-saved with the deck.
- **Prices** — each card shows its Scryfall USD price, and the Stats panel
  totals the value of the deck, sideboard, and considering boards.
- **Menu bar** — the top bar is a proper dropdown menu bar (like a desktop app):
  - **File** — New deck, Save, Load, Import, Export.
  - **Deck** — printer actions (**all cards → cheapest / newest printing**),
    **Format** selection, **Sort cards by** (Name, Mana value, Color, Type),
    and **Group by** (Type, Mana value, Color, or None for a single list).
  - **View** — toggle **two-column cards**, **card grid** (image tiles),
    **show prices**, **show mana costs**, and expand/collapse all sections.
  - **Search** — choose the **sort order** for search results and toggle
    **ignore format restrictions**.
- **Deck view** — cards shown in **two columns** (toggleable), grouped by your
  chosen grouping (type, mana value, color, or a single list) with clickable,
  collapsible section headers, quantity +/− controls, and a `⋯` actions menu.
  Cards within each section can be sorted by name, mana value, color, or type.
  Mana costs render with **real Scryfall mana symbols**.
- **Deck filter (full Scryfall syntax)** — filter the cards already in your
  deck with any Scryfall query (`t:creature`, `cmc<=3`, `o:flying`, `c:wu`,
  `r:mythic`, `is:commander`, `or`, parentheses, negations, …). Plain words
  match instantly by name; anything using query syntax is resolved against
  Scryfall (restricted to the cards in the deck) and applied by name. A
  "Filtering…" note appears while a query is resolving.
- **Live stats** — total / lands / non-lands, average CMC, unique count,
  price totals, mana-color pip distribution, and a mana curve bar chart.
- **Card preview** — hover any card for a floating image, and the last
  hovered/clicked card is pinned in the right-hand preview panel.
- **Import / Export** — export the decklist to clipboard grouped by type, or
  import a text list (supports `4 Lightning Bolt`, `4x Lightning Bolt`, or
  bare names, plus Moxfield-style `#tags`). Names resolve via Scryfall's
  `/cards/collection`.
- **Card tags (Moxfield-style)** — add `#tags` to any card (via the `+tag`
  button on a row, or inline like `1 Sol Ring #ramp #mana` in an imported
  list). Tags are stored **per deck** in a renameable registry, so renaming a
  tag updates every card that uses it. (Filtering the deck by tag is planned.)
- **Accounts & decks (Supabase + Google sign-in)** — sign in with Google and
  your decks live in a **Supabase Postgres** database, tied to your account
  (not the browser), so they follow you across devices. The flow is
  **Home → My Decks → Builder**: a deck library where you create/open/delete
  decks, and a builder that **autosaves** every change (no Save button). Only
  Scryfall **printing ids, quantities, boards, and tags** are stored (no card
  text/images); decks are re-hydrated from Scryfall on open. There is **no
  local deck storage** — the backend is the source of truth. See
  [`SUPABASE_SETUP.md`](SUPABASE_SETUP.md) to enable it.

## Search syntax cheat sheet

Scryfall uses its own query language. Examples:

| Query | Meaning |
|-------|---------|
| `lightning bolt` | fuzzy name match |
| `t:instant cmc<=2` | cheap instants |
| `o:flying c:u` | blue cards with "flying" in text |
| `t:legendary t:creature` | legendary creatures |
| `r:mythic` | mythic rares |
| `f:modern t:land` | Modern-legal lands |

Full reference: https://scryfall.com/docs/syntax

## Files

- `index.html` — layout
- `styles.css` — styling
- `app.js` — Scryfall integration + deck logic
- `supabase-config.js` — **your** Supabase URL + anon key (blank = local-only)
- `auth.js` — Google sign-in + cloud deck CRUD (ES module)
- `supabase/schema.sql` — DB tables + Row Level Security policies
- `SUPABASE_SETUP.md` — step-by-step setup for Google sign-in + cloud storage
- `serve.py` — tiny static server that auto-shuts down when the tab closes
- `Open Deck Builder.command` — double-clickable launcher for `serve.py`

## Notes / limitations

- Every search automatically includes `f:commander sort:edhrec prefer:notub`.
  Typing any of these yourself won't duplicate them.
- Respects Scryfall's rate limits by using their batch collection endpoint for
  imports and debouncing keystrokes.
- One commander per deck; no format/legality validation yet — bare bones.
- Data is stored per-browser in `localStorage` by default; enable the optional
  Supabase integration for per-user cloud storage.
