/* ============================================================
   Barebones Deck Builder — app.js
   Scryfall API integration + deck management
   ============================================================ */

const SCRYFALL_SEARCH = "https://api.scryfall.com/cards/search";
const SCRYFALL_NAMED = "https://api.scryfall.com/cards/named";
const SCRYFALL_COLLECTION = "https://api.scryfall.com/cards/collection";
const SCRYFALL_PRINTS = "https://api.scryfall.com/cards/search";

// ------- State -------
let deck = [];              // [{ id, name, qty, mana_cost, cmc, type_line, colors, image, scryfall_uri, ... }]
let considering = [];       // cards being considered (Moxfield "Considering" board)
let sideboard = [];         // sideboard cards (same entry shape as deck)
let commanderId = null;     // card id (in deck) designated as commander, or null
let searchResults = [];     // last search results
let searchTimer = null;

// Deck view preferences (persisted with the deck).
let deckSort = "name";      // "name" | "cmc" | "color" | "type" | "price"
let deckGroup = "type";     // "type" | "cmc" | "color" | "none"
let viewOpts = { twoColumn: true, showPrices: true, showMana: true, gridView: false };

// --- Deck filter (full Scryfall query) state -------------------------------
// The filter box accepts a full Scryfall query (e.g. `t:creature cmc<=3`).
// We resolve it against Scryfall, restricted to the cards currently in the
// deck/boards, and remember the resulting set of matching card names.
// `null` names means "no Scryfall filter active" (fall back to name substring).
let deckFilter = {
  query: "",              // the last resolved query string
  names: null,            // Set of matching card names (lowercase) or null
  loading: false,         // a Scryfall request is in flight
  error: "",              // last error message, if any
};

// ------- DOM -------
const $ = (id) => document.getElementById(id);
const searchInput = $("search-input");
const searchBtn = $("search-btn");
const searchMeta = $("search-meta");
const searchResultsEl = $("search-results");
const deckListEl = $("deck-list");
const sideboardListEl = $("sideboard-list");
const sideCountEl = $("side-count");
const deckCountEl = $("deck-count");
const deckFilterEl = $("deck-filter");
const sideFilterEl = $("side-filter");
const sideToggle = $("side-toggle");
const sideBody = $("side-body");
const sideDock = $("side-dock");
const considerListEl = $("consider-list");
const considerCountEl = $("consider-count");
const considerFilterEl = $("consider-filter");
const considerToggle = $("consider-toggle");
const considerBody = $("consider-body");
const considerDock = $("consider-dock");
const statsEl = $("stats");
const previewEl = $("preview");
const deckNameEl = $("deck-name");

/* ============================================================
   SCRYFALL SEARCH
   ============================================================ */
// Restrict searches to cards legal in the selected format (unless "Ignore
// format" is on) and sort by EDHREC rank, like Moxfield's default experience.
// Each directive is appended once, unless the user already typed it themselves.
function selectedFormat() {
  const el = $("format-select");
  return el ? el.value : "";
}

function selectedSort() {
  const el = $("sort-select");
  return (el && el.value) ? el.value : "edhrec";
}

// Formats where a commander / color identity applies.
const COMMANDER_FORMATS = new Set(["commander", "brawl", "standardbrawl", "oathbreaker"]);
// Formats where the commander's color identity is ALWAYS forced onto the search
// (unless "Ignore format" is on), even if the user typed their own ci: term.
const FORCE_COLOR_IDENTITY_FORMATS = new Set(["commander", "commander_nonpartner"]);

function buildQuery(query) {
  query = (query || "").trim();
  const ignoreFormat = $("ignore-format")?.checked;
  const format = selectedFormat();

  // Format legality restriction (f:...) — e.g. f:commander, f:modern.
  if (!ignoreFormat && format && !/\bf:[a-z0-9_]+\b/i.test(query)) {
    const legality = format === "commander_nonpartner" ? "commander" : format;
    query = query ? `${query} f:${legality}` : `f:${legality}`;
  }
  // Color identity applies to commander-style formats. For the Commander
  // format we ALWAYS force the commander's identity onto the search (dropping
  // any ci: the user typed); other commander formats only add it when the
  // user hasn't specified one.
  if (!ignoreFormat && COMMANDER_FORMATS.has(format)) {
    const forceCi = FORCE_COLOR_IDENTITY_FORMATS.has(format);
    if (forceCi || !/\bci:/i.test(query)) {
      const cmdr = deck.find((e) => e.id === commanderId);
      if (cmdr) {
        const ci = (cmdr.color_identity || []).join("");
        if (forceCi) {
          // Make our color identity authoritative by removing any user entry.
          query = query.replace(/\s*\bci:[^\s]*/gi, "").trim();
        }
        // Colorless commanders use ci:c; otherwise the WUBRG subset.
        query = `${query} ci:${ci || "c"}`;
      }
    }
  }
  const sort = selectedSort();
  const sortRe = new RegExp(`\\bsort:${sort}\\b`, "i");
  if (!sortRe.test(query)) {
    query = `${query} sort:${sort}`;
  }
  if (!/\bprefer:notub\b/i.test(query)) {
    query = `${query} prefer:notub`;
  }
  return query;
}

// Build a comparator matching the chosen Scryfall sort option. Cards missing
// the sort key sort to the end.
function resultComparator(sort) {
  const asc = (va, vb) => (va ?? Infinity) - (vb ?? Infinity);
  const str = (a, b) => String(a ?? "\uffff").localeCompare(String(b ?? "\uffff"));
  switch (sort) {
    case "name":      return (a, b) => str(a.name, b.name);
    case "set":       return (a, b) => str(a.set, b.set) || str(a.collector_number, b.collector_number);
    case "released":  return (a, b) => str(a.released_at, b.released_at);
    case "rarity":    return (a, b) => {
      const order = { common: 0, uncommon: 1, rare: 2, mythic: 3, special: 4, bonus: 5 };
      return (order[a.rarity] ?? 99) - (order[b.rarity] ?? 99);
    };
    case "color":     return (a, b) => str((a.colors || []).join(""), (b.colors || []).join("")) || asc(a.cmc, b.cmc);
    case "usd":       return (a, b) => asc(parseFloat(a.prices?.usd), parseFloat(b.prices?.usd));
    case "tix":       return (a, b) => asc(parseFloat(a.prices?.tix), parseFloat(b.prices?.tix));
    case "eur":       return (a, b) => asc(parseFloat(a.prices?.eur), parseFloat(b.prices?.eur));
    case "cmc":       return (a, b) => asc(a.cmc, b.cmc);
    case "power":     return (a, b) => str(a.power, b.power);
    case "toughness": return (a, b) => str(a.toughness, b.toughness);
    case "artist":    return (a, b) => str(a.artist, b.artist);
    case "review":    return (a, b) => str(a.set, b.set);
    case "edhrec":
    default:          return (a, b) => asc(a.edhrec_rank, b.edhrec_rank);
  }
}

async function runSearch(rawQuery) {
  const trimmed = (rawQuery || "").trim();
  // Empty search box -> clear results (don't search for just "f:commander").
  if (!trimmed) {
    searchResultsEl.innerHTML = "";
    searchMeta.textContent = "";
    return;
  }
  const query = buildQuery(trimmed);

  searchMeta.textContent = "Searching…";
  searchResultsEl.innerHTML = "";

  try {
    // The selected sort (in buildQuery) drives Scryfall's ordering; we also
    // re-sort client-side so cards missing a key sort consistently.
    const url = `${SCRYFALL_SEARCH}?q=${encodeURIComponent(query)}&unique=cards`;
    const res = await fetch(url, {
      headers: { Accept: "application/json" },
    });

    if (res.status === 404) {
      searchMeta.textContent = "No cards found.";
      return;
    }
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.details || `HTTP ${res.status}`);
    }

    const data = await res.json();
    const sort = selectedSort();
    searchResults = (data.data || []).slice().sort(resultComparator(sort));
    const fmt = selectedFormat();
    const fmtLabel = fmt ? ` · ${fmt === "commander_nonpartner" ? "commander" : fmt}` : "";
    searchMeta.textContent = `${data.total_cards} result(s)${fmtLabel} · sort:${sort}${data.has_more ? " (showing first 175)" : ""}`;
    renderSearchResults(searchResults);
  } catch (err) {
    searchMeta.textContent = "Error: " + err.message;
    console.error(err);
  }
}

function cardImage(card) {
  if (card.image_uris) return card.image_uris.normal || card.image_uris.small;
  // double-faced cards
  if (card.card_faces && card.card_faces[0]?.image_uris) {
    return card.card_faces[0].image_uris.normal || card.card_faces[0].image_uris.small;
  }
  return "";
}

// Render a mana cost string like "{2}{W}{U}" as inline Scryfall mana symbols.
const MANA_SYMBOL_BASE = "https://svgs.scryfall.io/card-symbols/";
function manaCostHtml(cost) {
  if (!cost) return "";
  return cost.replace(/\{([^}]+)\}/g, (_, sym) => {
    // {W/U} -> WU.svg, {T} -> T.svg, {2} -> 2.svg
    const key = sym.replace(/\//g, "").toUpperCase();
    const uri = `${MANA_SYMBOL_BASE}${encodeURIComponent(key)}.svg`;
    return `<img class="ms" src="${uri}" alt="{${escapeHtml(sym)}}" title="{${escapeHtml(sym)}}" loading="lazy" />`;
  });
}

function renderSearchResults(cards) {
  searchResultsEl.innerHTML = "";
  cards.forEach((card) => {
    const div = document.createElement("div");
    div.className = "result-card";
    div.draggable = true;
    const img = cardImage(card);
    const price = formatPrice(card.prices?.usd);
    div.innerHTML = `
      <img src="${img}" alt="${escapeHtml(card.name)}" loading="lazy" />
      <div class="card-footer">
        <div class="name" title="${escapeHtml(card.name)}">${escapeHtml(card.name)}</div>
        <div class="card-footer-row">
          <span class="price${price ? "" : " empty"}" title="${price ? escapeHtml(price) : "Price unknown"}">${price || ""}</span>
          <button class="consider-btn" title="Add to Considering">+☆</button>
        </div>
      </div>
    `;
    // Hovering shows the card in the top-right preview.
    div.addEventListener("mouseenter", () => setPreview({ name: card.name, image: img }));

    // Drag into the deck (or considering) panel
    div.addEventListener("dragstart", (ev) => {
      startDrag(ev, { source: "search", card });
    });
    div.addEventListener("dragend", endDrag);


    // Click card body/image -> add to the main deck
    div.addEventListener("click", () => {
      addCardToDeck(card, 1);
      const flash = document.createElement("div");
      flash.className = "add-flash";
      flash.textContent = "+1";
      div.appendChild(flash);
      setTimeout(() => flash.remove(), 350);
    });

    // Click "+☆" -> add to considering (don't also add to deck)
    div.querySelector(".consider-btn").addEventListener("click", (ev) => {
      ev.stopPropagation();
      addToConsidering(card);
      const flash = document.createElement("div");
      flash.className = "add-flash";
      flash.textContent = "+☆";
      div.appendChild(flash);
      setTimeout(() => flash.remove(), 350);
    });

    searchResultsEl.appendChild(div);
  });
}

/* ============================================================
   DECK MANAGEMENT
   ============================================================ */
// Normalize a Scryfall card into our stored entry shape.
function makeEntry(card, qty) {
  return {
    id: card.id,
    name: card.name,
    qty,
    mana_cost: card.mana_cost || (card.card_faces?.[0]?.mana_cost ?? ""),
    cmc: card.cmc ?? 0,
    type_line: card.type_line || "",
    colors: card.colors || [],
    color_identity: card.color_identity || [],
    image: cardImage(card),
    scryfall_uri: card.scryfall_uri || "",
    set: (card.set || "").toUpperCase(),
    set_name: card.set_name || "",
    collector_number: card.collector_number || "",
    prints_search_uri: card.prints_search_uri || "",
    edhrec_rank: card.edhrec_rank ?? null,
    // Scryfall prices (strings, possibly null). Keep USD as the canonical price.
    price_usd: card.prices?.usd ?? null,
    price_usd_foil: card.prices?.usd_foil ?? null,
  };
}

// Format a card price for display, e.g. "$1.23"; returns "" when unknown.
function formatPrice(v) {
  const n = parseFloat(v);
  if (isNaN(n)) return "";
  return "$" + n.toFixed(2);
}

// Total USD value of a board (sum of qty * unit price; unknown prices count as 0).
function boardPrice(board) {
  return board.reduce((sum, e) => sum + (parseFloat(e.price_usd) || 0) * e.qty, 0);
}

function findDeckEntry(card) {
  return deck.find((e) => e.id === card.id);
}

function addCardToDeck(card, qty = 1) {
  const existing = findDeckEntry(card);
  if (existing) {
    existing.qty += qty;
  } else {
    deck.push(makeEntry(card, qty));
  }
  renderDeck();
  renderStats();
  queueAutosave();
}

/* ---------------- SIDEBOARD ---------------- */
function findSideEntry(card) {
  return sideboard.find((e) => e.id === card.id);
}

function addCardToSideboard(card, qty = 1) {
  const existing = findSideEntry(card);
  if (existing) existing.qty += qty;
  else sideboard.push(makeEntry(card, qty));
  renderSideboard();
  renderStats();
  updateBoardTabs();
  queueAutosave();
}

function changeSideQty(cardId, delta) {
  const entry = sideboard.find((e) => e.id === cardId);
  if (!entry) return;
  entry.qty += delta;
  if (entry.qty <= 0) sideboard = sideboard.filter((e) => e.id !== cardId);
  renderSideboard();
  renderStats();
  updateBoardTabs();
  queueAutosave();
}

function removeFromSideboard(cardId) {
  sideboard = sideboard.filter((e) => e.id !== cardId);
  renderSideboard();
  renderStats();
  updateBoardTabs();
  queueAutosave();
}

// Move a sideboard card into the main deck.
function moveSideToDeck(cardId) {
  const entry = sideboard.find((e) => e.id === cardId);
  if (!entry) return;
  const existing = deck.find((e) => e.id === cardId);
  if (existing) existing.qty += entry.qty;
  else deck.push({ ...entry });
  sideboard = sideboard.filter((e) => e.id !== cardId);
  renderDeck();
  renderSideboard();
  renderStats();
  updateBoardTabs();
  queueAutosave();
}

// Move a sideboard card to Considering.
function moveSideToConsidering(cardId) {
  const entry = sideboard.find((e) => e.id === cardId);
  if (!entry) return;
  const existing = considering.find((e) => e.id === cardId);
  if (existing) existing.qty += entry.qty;
  else considering.push({ ...entry });
  sideboard = sideboard.filter((e) => e.id !== cardId);
  renderConsidering();
  renderSideboard();
  renderStats();
  updateBoardTabs();
  queueAutosave();
}

// Move a main-deck card into the sideboard.
function moveDeckToSideboard(cardId) {
  const entry = deck.find((e) => e.id === cardId);
  if (!entry) return;
  const existing = sideboard.find((e) => e.id === cardId);
  if (existing) existing.qty += entry.qty;
  else sideboard.push({ ...entry });
  deck = deck.filter((e) => e.id !== cardId);
  if (commanderId === cardId) commanderId = null;
  renderDeck();
  renderSideboard();
  renderStats();
  updateBoardTabs();
  queueAutosave();
}

// Move a Considering card to the sideboard.
function moveConsideringToSideboard(cardId) {
  const entry = considering.find((e) => e.id === cardId);
  if (!entry) return;
  const existing = sideboard.find((e) => e.id === cardId);
  if (existing) existing.qty += entry.qty;
  else sideboard.push({ ...entry });
  considering = considering.filter((e) => e.id !== cardId);
  renderConsidering();
  renderSideboard();
  renderStats();
  updateBoardTabs();
  queueAutosave();
}

function sideboardCount() {
  return sideboard.reduce((s, e) => s + e.qty, 0);
}

/* ---------------- CONSIDERING BOARD ---------------- */
function findConsideringEntry(card) {
  return considering.find((e) => e.id === card.id);
}

function addToConsidering(card, qty = 1) {
  const existing = findConsideringEntry(card);
  if (existing) {
    existing.qty += qty;
  } else {
    considering.push(makeEntry(card, qty));
  }
  renderConsidering();
  renderStats();
  queueAutosave();
}

function changeConsideringQty(cardId, delta) {
  const entry = considering.find((e) => e.id === cardId);
  if (!entry) return;
  entry.qty += delta;
  if (entry.qty <= 0) considering = considering.filter((e) => e.id !== cardId);
  renderConsidering();
  renderStats();
  queueAutosave();
}

function removeFromConsidering(cardId) {
  considering = considering.filter((e) => e.id !== cardId);
  renderConsidering();
  renderStats();
  queueAutosave();
}

// Move a considering card into the deck (Moxfield "add to deck" behavior).
function moveConsideringToDeck(cardId) {
  const entry = considering.find((e) => e.id === cardId);
  if (!entry) return;
  const existing = deck.find((e) => e.id === cardId);
  if (existing) existing.qty += entry.qty;
  else deck.push({ ...entry });
  considering = considering.filter((e) => e.id !== cardId);
  renderDeck();
  renderConsidering();
  renderStats();
  queueAutosave();
}

function renderConsidering() {
  const filter = considerFilterEl.value.trim().toLowerCase();
  considerListEl.innerHTML = "";
  considerCountEl.textContent = `${considering.length} card${considering.length === 1 ? "" : "s"}`;

  const visible = considering.filter((e) => !filter || e.name.toLowerCase().includes(filter));
  if (visible.length === 0) {
    considerListEl.innerHTML = `<p class="hint">${considering.length ? "No cards match filter." : "Empty. Use +☆ on a search result, or ⋯ to move cards here."}</p>`;
    return;
  }

  // Sort by EDHREC rank (unranked last), then render as rows or grid tiles.
  const sorted = visible.slice().sort((a, b) => (a.edhrec_rank ?? Infinity) - (b.edhrec_rank ?? Infinity));
  const grid = document.createElement("div");
  grid.className = boardGridClass();
  sorted.forEach((e) => grid.appendChild(buildBoardItem(e, "consider")));
  considerListEl.appendChild(grid);
}

function changeQty(cardId, delta) {
  const entry = deck.find((e) => e.id === cardId);
  if (!entry) return;
  entry.qty += delta;
  if (entry.qty <= 0) {
    deck = deck.filter((e) => e.id !== cardId);
  }
  renderDeck();
  renderStats();
  queueAutosave();
}

function removeCard(cardId) {
  deck = deck.filter((e) => e.id !== cardId);
  if (commanderId === cardId) commanderId = null;
  renderDeck();
  renderStats();
  queueAutosave();
}

// Toggle a deck card as the commander.
function setCommander(cardId) {
  commanderId = (commanderId === cardId) ? null : cardId;
  renderDeck();
  queueAutosave();
}

// Move a deck card to the Considering board.
function moveDeckToConsidering(cardId) {
  const entry = deck.find((e) => e.id === cardId);
  if (!entry) return;
  const existing = considering.find((e) => e.id === cardId);
  if (existing) existing.qty += entry.qty;
  else considering.push({ ...entry });
  deck = deck.filter((e) => e.id !== cardId);
  if (commanderId === cardId) commanderId = null;
  renderDeck();
  renderConsidering();
  renderStats();
  queueAutosave();
}

/* ============================================================
   DRAG & DROP
   ------------------------------------------------------------
   Sources:  search (a Scryfall card), deck (a deck row), consider (a board row)
   Targets:  deck-list       -> add/move the card into the deck
             consider-body   -> add/move the card into Considering
             search-panel    -> remove the card from deck/considering
   ============================================================ */
let dragData = null; // { source, id?, card }

function startDrag(ev, data) {
  dragData = data;
  ev.dataTransfer.effectAllowed = "move";
  // Some browsers need data set for a drag to begin.
  try { ev.dataTransfer.setData("text/plain", data.card?.name || ""); } catch {}
}

function endDrag() {
  dragData = null;
  document.querySelectorAll(".drop-active").forEach((el) => el.classList.remove("drop-active"));
}

// Apply a drop on the deck list.
function handleDropOnDeck() {
  if (!dragData) return;
  const { source, id, card } = dragData;
  if (source === "search") addCardToDeck(card, 1);
  else if (source === "consider") moveConsideringToDeck(id);
  else if (source === "side") moveSideToDeck(id);
  else if (source === "deck") { /* already in deck — no-op */ }
}

// Apply a drop on the sideboard list.
function handleDropOnSideboard() {
  if (!dragData) return;
  const { source, id, card } = dragData;
  if (source === "search") addCardToSideboard(card, 1);
  else if (source === "deck") moveDeckToSideboard(id);
  else if (source === "consider") moveConsideringToSideboard(id);
  else if (source === "side") { /* already in sideboard — no-op */ }
}

// Apply a drop on the considering board.
function handleDropOnConsidering() {
  if (!dragData) return;
  const { source, id, card } = dragData;
  if (source === "search") addToConsidering(card, 1);
  else if (source === "deck") moveDeckToConsidering(id);
  else if (source === "side") moveSideToConsidering(id);
  else if (source === "consider") { /* already considering — no-op */ }
}

// Apply a drop on the search panel -> remove the card from deck/considering.
function handleDropOnSearch() {
  if (!dragData) return;
  const { source, id } = dragData;
  if (source === "deck") removeCard(id);
  else if (source === "consider") removeFromConsidering(id);
  else if (source === "side") removeFromSideboard(id);
}

// Wire a drop target. `acceptSources` restricts which drags highlight/land.
function setupDropTarget(el, onDrop, acceptSources) {
  el.addEventListener("dragover", (ev) => {
    if (!dragData || !acceptSources.includes(dragData.source)) return;
    ev.preventDefault();
    ev.dataTransfer.dropEffect = "move";
    el.classList.add("drop-active");
  });
  el.addEventListener("dragleave", (ev) => {
    // Only clear when actually leaving the element (not entering a child)
    if (!el.contains(ev.relatedTarget)) el.classList.remove("drop-active");
  });
  el.addEventListener("drop", (ev) => {
    if (!dragData || !acceptSources.includes(dragData.source)) return;
    ev.preventDefault();
    ev.stopPropagation(); // innermost drop target wins
    el.classList.remove("drop-active");
    onDrop();
    endDrag();
  });
}

/* ============================================================
   CARD ACTIONS MENU (⋯ / right-click)
   ============================================================ */
const cardMenuEl = $("card-menu");

// Menu items for a card in the deck. Add future actions here.
function deckMenuItems(e) {
  const isCmdr = e.id === commanderId;
  return [
    {
      label: isCmdr ? "Unset commander" : "Set as commander",
      icon: "♛",
      onClick: () => setCommander(e.id),
    },
    {
      label: "Move to sideboard",
      icon: "⇥",
      onClick: () => moveDeckToSideboard(e.id),
    },
    {
      label: "Move to Considering",
      icon: "☆",
      onClick: () => moveDeckToConsidering(e.id),
    },
    {
      label: "Change printing…",
      icon: "▤",
      onClick: () => openPrintingPicker(e, "deck"),
    },
    { separator: true },
    {
      label: "Remove from deck",
      icon: "✕",
      danger: true,
      onClick: () => removeCard(e.id),
    },
  ];
}

// Menu items for a card on the Considering board. Add future actions here.
function consideringMenuItems(e) {
  return [
    {
      label: "Add to deck",
      icon: "→",
      onClick: () => moveConsideringToDeck(e.id),
    },
    {
      label: "Move to sideboard",
      icon: "⇥",
      onClick: () => moveConsideringToSideboard(e.id),
    },
    {
      label: "Change printing…",
      icon: "▤",
      onClick: () => openPrintingPicker(e, "consider"),
    },
    { separator: true },
    {
      label: "Remove from Considering",
      icon: "✕",
      danger: true,
      onClick: () => removeFromConsidering(e.id),
    },
  ];
}

// Menu items for a card in the sideboard.
function sideboardMenuItems(e) {
  return [
    {
      label: "Move to deck",
      icon: "→",
      onClick: () => moveSideToDeck(e.id),
    },
    {
      label: "Move to Considering",
      icon: "☆",
      onClick: () => moveSideToConsidering(e.id),
    },
    {
      label: "Change printing…",
      icon: "▤",
      onClick: () => openPrintingPicker(e, "side"),
    },
    { separator: true },
    {
      label: "Remove from sideboard",
      icon: "✕",
      danger: true,
      onClick: () => removeFromSideboard(e.id),
    },
  ];
}

// Open the menu anchored to a trigger element (⋯ button).
function openCardMenu(anchorEl, items) {
  const r = anchorEl.getBoundingClientRect();
  // Prefer aligning the menu's right edge with the button's right edge.
  openCardMenuAt(r.right, r.bottom, items, { alignRight: true });
}

function openCardMenuAt(x, y, items, opts = {}) {
  cardMenuEl.innerHTML = "";
  items.forEach((item) => {
    if (item.separator) {
      const sep = document.createElement("div");
      sep.className = "card-menu-sep";
      cardMenuEl.appendChild(sep);
      return;
    }
    const el = document.createElement("button");
    el.className = "card-menu-item" + (item.danger ? " danger" : "");
    el.setAttribute("role", "menuitem");
    el.innerHTML = `<span class="mi-icon">${item.icon || ""}</span><span class="mi-label">${escapeHtml(item.label)}</span>`;
    el.addEventListener("click", () => {
      closeCardMenu();
      item.onClick();
    });
    cardMenuEl.appendChild(el);
  });

  cardMenuEl.classList.remove("hidden");
  // Position after it's measurable
  const menuRect = cardMenuEl.getBoundingClientRect();
  let left = opts.alignRight ? x - menuRect.width : x;
  let top = y + 4;
  // Keep on-screen
  if (left + menuRect.width > window.innerWidth - 8) left = window.innerWidth - menuRect.width - 8;
  if (left < 8) left = 8;
  if (top + menuRect.height > window.innerHeight - 8) {
    top = opts.alignRight ? y - menuRect.height - 4 : window.innerHeight - menuRect.height - 8;
  }
  if (top < 8) top = 8;
  cardMenuEl.style.left = left + "px";
  cardMenuEl.style.top = top + "px";

  // Keyboard: arrow up/down to move, Enter activates the focused item.
  cardMenuEl.onkeydown = (ev) => {
    const items = [...cardMenuEl.querySelectorAll(".card-menu-item")];
    const i = items.indexOf(document.activeElement);
    if (ev.key === "ArrowDown") {
      ev.preventDefault();
      items[(i + 1) % items.length]?.focus();
    } else if (ev.key === "ArrowUp") {
      ev.preventDefault();
      items[(i - 1 + items.length) % items.length]?.focus();
    }
  };

  // Focus first item for keyboard users
  const firstBtn = cardMenuEl.querySelector(".card-menu-item");
  if (firstBtn) firstBtn.focus();
}

function closeCardMenu() {
  cardMenuEl.classList.add("hidden");
  cardMenuEl.innerHTML = "";
}

function isCardMenuOpen() {
  return !cardMenuEl.classList.contains("hidden");
}

/* ============================================================
   PRINTING PICKER
   ------------------------------------------------------------
   Lists every printing of a card (from Scryfall) with images so
   you can swap which set/art a deck entry uses. Changing a printing
   keeps the quantity and updates the entry's data in place.
   ============================================================ */
const printingModal = $("printing-modal");
const printingBody = $("printing-body");
const printingTitle = $("printing-title");
// Context for the currently-open picker (used by the quick-action buttons).
let printingCtx = null; // { entry, board, prints }

/* ------------------------------------------------------------
   PRINTINGS CACHE
   ------------------------------------------------------------
   Printings (every set/art a card was printed in) change very
   rarely, so fetching them repeatedly is wasteful — especially
   for the "all cards" bulk swap. We cache them per card name, both
   in memory and in localStorage, so a second fetch is instant.
   Only the fields we actually use are stored to keep it small.
   ============================================================ */
const PRINTS_CACHE_KEY = "barebones_prints_cache";
const PRINTS_CACHE_VERSION = 1;
// name (lowercase) -> array of slim printing objects
const printingCache = new Map();
let printsCacheDirty = false;
let printsCacheSaveTimer = null;

// Keep only the fields we use for display / makeEntry, to shrink the cache.
function slimPrinting(card) {
  return {
    id: card.id,
    name: card.name,
    set: card.set,
    set_name: card.set_name,
    collector_number: card.collector_number,
    released_at: card.released_at,
    prices: card.prices ? { usd: card.prices.usd, usd_foil: card.prices.usd_foil } : undefined,
    image_uris: card.image_uris,
    card_faces: card.card_faces
      ? card.card_faces.map((f) => ({ mana_cost: f.mana_cost, image_uris: f.image_uris }))
      : undefined,
    mana_cost: card.mana_cost,
    cmc: card.cmc,
    type_line: card.type_line,
    colors: card.colors,
    color_identity: card.color_identity,
    scryfall_uri: card.scryfall_uri,
    prints_search_uri: card.prints_search_uri,
    edhrec_rank: card.edhrec_rank,
  };
}

function loadPrintsCache() {
  try {
    const raw = JSON.parse(localStorage.getItem(PRINTS_CACHE_KEY) || "null");
    if (!raw || raw.version !== PRINTS_CACHE_VERSION || !raw.cards) return;
    Object.entries(raw.cards).forEach(([name, prints]) => {
      if (Array.isArray(prints) && prints.length) printingCache.set(name, prints);
    });
  } catch { /* ignore corrupt cache */ }
}

function scheduleSavePrintsCache() {
  printsCacheDirty = true;
  clearTimeout(printsCacheSaveTimer);
  printsCacheSaveTimer = setTimeout(savePrintsCache, 800);
}

function savePrintsCache() {
  if (!printsCacheDirty) return;
  const cards = {};
  printingCache.forEach((prints, name) => { cards[name] = prints; });
  try {
    localStorage.setItem(PRINTS_CACHE_KEY, JSON.stringify({ version: PRINTS_CACHE_VERSION, cards }));
    printsCacheDirty = false;
  } catch (err) {
    // Quota exceeded: drop oldest-ish entries and try again once with a cap.
    console.warn("Printings cache too large; trimming.", err);
    const names = [...printingCache.keys()];
    // Keep at most 60 cards in the persisted cache.
    names.slice(0, Math.max(0, names.length - 60)).forEach((n) => printingCache.delete(n));
    try {
      const trimmed = {};
      printingCache.forEach((prints, name) => { trimmed[name] = prints; });
      localStorage.setItem(PRINTS_CACHE_KEY, JSON.stringify({ version: PRINTS_CACHE_VERSION, cards: trimmed }));
      printsCacheDirty = false;
    } catch { /* give up on persistence; in-memory cache still works */ }
  }
}

// Get printings for a card by name, using/refreshing the cache. `printsSearchUri`
// is optional; when absent we build the Scryfall query ourselves. Pass
// `{ force: true }` to bypass the cache.
async function getPrintings(name, printsSearchUri, { force = false } = {}) {
  const key = String(name || "").toLowerCase();
  if (!key) return [];
  if (!force && printingCache.has(key)) return printingCache.get(key);

  const url = printsSearchUri
    || `${SCRYFALL_PRINTS}?q=${encodeURIComponent('!"' + name + '"')}&unique=prints&order=released`;
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  const prints = (data.data || []).map(slimPrinting);
  printingCache.set(key, prints);
  scheduleSavePrintsCache();
  return prints;
}

// Download + cache printings for every card currently in the deck, sideboard,
// and considering boards. Safe to call repeatedly (cached cards are skipped).
async function prefetchDeckPrintings() {
  const entries = uniqueBoardEntries();
  if (!entries.length) return;
  for (const entry of entries) {
    const key = entry.name.toLowerCase();
    if (printingCache.has(key)) continue;
    try { await getPrintings(entry.name, entry.prints_search_uri); }
    catch { /* ignore; will retry on demand */ }
    await sleep(120); // throttle to respect Scryfall's rate limit
  }
}

// Find the board array for a given source name.
function boardArray(board) {
  if (board === "side") return sideboard;
  if (board === "consider") return considering;
  return deck;
}

// Persist + re-render whichever view a board belongs to.
function refreshBoard(board) {
  if (board === "side") { renderSideboard(); updateBoardTabs(); }
  else if (board === "consider") { renderConsidering(); }
  else { renderDeck(); }
  renderStats();
  queueAutosave();
}

// Swap an entry's printing in place, preserving quantity. `board` is the
// source name ("deck" | "side" | "consider"); `oldId` is the current id.
function changePrinting(board, oldId, card) {
  const arr = boardArray(board);
  const idx = arr.findIndex((e) => e.id === oldId);
  if (idx === -1) return;

  const fresh = makeEntry(card, arr[idx].qty);

  // If the new printing is already present in this board, merge quantities.
  const dupeIdx = arr.findIndex((e) => e.id === card.id && e.id !== oldId);
  if (dupeIdx !== -1) {
    // Merge into the existing entry, then drop this one.
    arr[dupeIdx].qty += arr[idx].qty;
    arr.splice(idx, 1);
  } else {
    arr[idx] = fresh;
  }
  // The chosen printing's id is now the entry id, so repoint the commander.
  if (board === "deck" && commanderId === oldId) commanderId = card.id;

  closePrintingPicker();
  refreshBoard(board);
}

// Pick the cheapest printing by USD price (unknown prices are treated as
// Infinity so a priced printing always wins). Falls back to the first print.
function pickCheapestPrinting(prints) {
  if (!prints || !prints.length) return null;
  let best = null;
  let bestPrice = Infinity;
  prints.forEach((c) => {
    const p = parseFloat(c.prices?.usd);
    if (!isNaN(p) && p < bestPrice) { bestPrice = p; best = c; }
  });
  return best || prints[0];
}

// Pick the most recently released printing (latest released_at). Falls back to
// the first print if no release dates are present.
function pickMostRecentPrinting(prints) {
  if (!prints || !prints.length) return null;
  let best = null;
  let bestDate = "";
  prints.forEach((c) => {
    const d = String(c.released_at || "");
    if (d && d > bestDate) { bestDate = d; best = c; }
  });
  return best || prints[0];
}

function openPrintingPicker(entry, board) {
  if (!printingModal || !printingBody) {
    alert("Printing picker isn't available in this layout.");
    return;
  }
  printingTitle.textContent = `Printings of ${entry.name}`;
  printingCtx = { entry, board, prints: [] };
  renderPrintingQuickActions();
  printingBody.innerHTML = `<p class="hint">Loading printings…</p>`;
  printingModal.classList.remove("hidden");

  getPrintings(entry.name, entry.prints_search_uri)
    .then((prints) => {
      const sorted = prints.slice().sort((a, b) =>
        String(b.released_at || "").localeCompare(String(a.released_at || "")));
      if (printingCtx) printingCtx.prints = sorted;
      renderPrintingQuickActions();
      renderPrintings(sorted, entry, board);
    })
    .catch((err) => {
      printingBody.innerHTML = `<p class="hint">Could not load printings: ${escapeHtml(err.message)}</p>`;
    });
}

// Render the "cheapest / most recent" quick-action buttons for the open picker.
function renderPrintingQuickActions() {
  const actionsEl = $("printing-actions");
  if (!actionsEl) return;
  const ready = printingCtx && printingCtx.prints && printingCtx.prints.length > 0;
  actionsEl.innerHTML = `
    <button id="print-cheapest" ${ready ? "" : "disabled"} title="Use the cheapest printing">\u25bc Cheapest</button>
    <button id="print-newest" ${ready ? "" : "disabled"} title="Use the most recently released printing">\u2726 Most recent</button>
  `;
  const cheapestBtn = $("print-cheapest");
  const newestBtn = $("print-newest");
  if (cheapestBtn) cheapestBtn.addEventListener("click", () => {
    if (!printingCtx || !printingCtx.prints.length) return;
    applyPickedPrinting(pickCheapestPrinting(printingCtx.prints));
  });
  if (newestBtn) newestBtn.addEventListener("click", () => {
    if (!printingCtx || !printingCtx.prints.length) return;
    applyPickedPrinting(pickMostRecentPrinting(printingCtx.prints));
  });
}

// Swap the open picker's card to the chosen printing.
function applyPickedPrinting(card) {
  if (!card || !printingCtx) return;
  const { entry, board } = printingCtx;
  if (card.id === entry.id) { closePrintingPicker(); return; }
  changePrinting(board, entry.id, card);
}

function renderPrintings(prints, entry, board) {
  if (!printingBody) return;
  if (!prints.length) {
    printingBody.innerHTML = `<p class="hint">No printings found.</p>`;
    return;
  }
  const grid = document.createElement("div");
  grid.className = "printing-grid";

  prints.forEach((card) => {
    const item = document.createElement("div");
    item.className = "printing-item" + (card.id === entry.id ? " current" : "");
    const img = cardImage(card);
    const price = formatPrice(card.prices?.usd);
    const setName = card.set_name || (card.set || "").toUpperCase();
    const num = card.collector_number ? `#${card.collector_number}` : "";
    item.innerHTML = `
      <img src="${img}" alt="${escapeHtml(card.name)}" loading="lazy" />
      <div class="printing-meta">
        <span class="printing-set" title="${escapeHtml(setName + " " + num)}">${escapeHtml((card.set || "").toUpperCase())} ${escapeHtml(num)}</span>
        <span class="printing-price${price ? "" : " empty"}">${price || ""}</span>
      </div>
    `;
    item.addEventListener("mouseenter", () => setPreview({ name: card.name, image: img }));
    item.addEventListener("click", () => {
      if (card.id === entry.id) { closePrintingPicker(); return; }
      changePrinting(board, entry.id, card);
    });
    grid.appendChild(item);
  });

  printingBody.innerHTML = "";
  printingBody.appendChild(grid);
}

function closePrintingPicker() {
  if (printingModal) printingModal.classList.add("hidden");
  if (printingBody) printingBody.innerHTML = "";
  printingCtx = null;
}
function isPrintingPickerOpen() {
  return !!(printingModal && !printingModal.classList.contains("hidden"));
}

/* ============================================================
   BULK PRINTING SWAP ("all cards" -> cheapest / most recent)
   ------------------------------------------------------------
   Fetches every printing for each unique card in the deck (and the
   sideboard / considering boards), picks the cheapest or newest, and
   swaps them all in. Identical card names across boards share the same
   chosen printing. Requests are throttled to respect Scryfall's limits.
   ============================================================ */

// Collect unique cards (by name) across all boards, remembering the original
// entry so we can reuse its prints_search_uri and current id.
function uniqueBoardEntries() {
  const byName = new Map();
  const collect = (arr) => arr.forEach((e) => {
    const key = e.name.toLowerCase();
    if (!byName.has(key)) byName.set(key, e);
  });
  collect(deck);
  collect(sideboard);
  collect(considering);
  return [...byName.values()];
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Apply a chosen printing to every entry (across all boards) matching a name,
// preserving quantities and merging duplicates. Returns nothing.
function applyPrintingByName(name, card) {
  const key = name.toLowerCase();
  [deck, sideboard, considering].forEach((arr) => {
    // Replace matching entries with the chosen printing.
    arr.forEach((e, i) => {
      if (e.name.toLowerCase() === key) {
        arr[i] = makeEntry(card, e.qty);
      }
    });
    // Merge duplicates that now share an id (keep the first, sum quantities).
    const seen = new Map();
    for (let i = arr.length - 1; i >= 0; i--) {
      const id = arr[i].id;
      if (seen.has(id)) {
        seen.get(id).qty += arr[i].qty;
        arr.splice(i, 1);
      } else {
        seen.set(id, arr[i]);
      }
    }
  });
}

// Bulk-swap the whole deck to a chosen printing mode. `mode` is "cheapest"|"newest".
async function setAllPrintings(mode, triggerBtn) {
  const entries = uniqueBoardEntries();
  if (!entries.length) return;

  if (mode === "cheapest") {
    if (!confirm("Replace every card with its cheapest printing?\n\nThis may fetch printings for cards not yet cached.")) return;
  } else {
    if (!confirm("Replace every card with its most recent printing?\n\nThis may fetch printings for cards not yet cached.")) return;
  }

  const originalLabel = triggerBtn ? triggerBtn.textContent : "";
  if (triggerBtn) { triggerBtn.disabled = true; triggerBtn.textContent = "Working…"; }

  // Remember the commander by name so we can re-point it after ids change.
  const commanderName = (() => {
    const c = deck.find((e) => e.id === commanderId);
    return c ? c.name.toLowerCase() : null;
  })();

  let done = 0;
  let failed = 0;
  let fetched = 0;
  for (const entry of entries) {
    const key = entry.name.toLowerCase();
    const fromCache = printingCache.has(key);
    try {
      const prints = await getPrintings(entry.name, entry.prints_search_uri);
      const chosen = mode === "cheapest"
        ? pickCheapestPrinting(prints)
        : pickMostRecentPrinting(prints);
      if (chosen) applyPrintingByName(entry.name, chosen);
      if (!fromCache) fetched++;
    } catch (err) {
      failed++;
      console.warn("Failed to fetch printings for", entry.name, err);
    }
    done++;
    if (triggerBtn) triggerBtn.textContent = `Working… ${done}/${entries.length}`;
    // Only throttle actual network requests (cached cards are instant).
    if (!fromCache) await sleep(120);
  }

  // The commander's id may have changed; re-point it by name.
  if (commanderName) {
    const cmdr = deck.find((e) => e.name.toLowerCase() === commanderName);
    commanderId = cmdr ? cmdr.id : null;
  }

  renderDeck();
  renderSideboard();
  renderConsidering();
  renderStats();
  updateBoardTabs();
  queueAutosave();

  if (triggerBtn) {
    triggerBtn.disabled = false;
    triggerBtn.textContent = originalLabel;
  }
  if (failed) alert(`Done, but ${failed} card(s) could not be updated (network/rate limit).`);
}

function totalCards() {
  return deck.reduce((sum, e) => sum + e.qty, 0);
}

// Which group a card belongs to in the deck list
function cardGroup(entry) {
  const t = (entry.type_line || "").toLowerCase();
  if (t.includes("land")) return "Lands";
  if (t.includes("creature")) return "Creatures";
  if (t.includes("planeswalker")) return "Planeswalkers";
  if (t.includes("instant")) return "Instants";
  if (t.includes("sorcery")) return "Sorceries";
  if (t.includes("enchantment")) return "Enchantments";
  if (t.includes("artifact")) return "Artifacts";
  return "Other";
}

const GROUP_ORDER = [
  "Creatures", "Planeswalkers", "Instants", "Sorceries",
  "Enchantments", "Artifacts", "Lands", "Other",
];

/* ------------------------------------------------------------
   DECK SORT / GROUP HELPERS
   ------------------------------------------------------------
   `deckGroup` decides how cards are broken into sections, `deckSort`
   decides the order of cards within each section. Both are chosen
   from the Deck menu.
   ============================================================ */
const COLOR_GROUP_ORDER = ["White", "Blue", "Black", "Red", "Green", "Multicolor", "Colorless"];
const MVL_GROUP_ORDER = ["0", "1", "2", "3", "4", "5", "6", "7+"];

// Bucket a card for the "color" grouping (by color identity, like Moxfield).
function colorGroupName(entry) {
  const ci = entry.color_identity || [];
  if (ci.length === 0) return "Colorless";
  if (ci.length > 1) return "Multicolor";
  return { W: "White", U: "Blue", B: "Black", R: "Red", G: "Green" }[ci[0]] || "Colorless";
}

// Sort index for a color group (used when sorting/grouping by color).
function colorSortIndex(entry) {
  const ci = entry.color_identity || [];
  // WUBRG order using the first color; multicolor/colorless at the end.
  const order = { W: 0, U: 1, B: 2, R: 3, G: 4 };
  if (ci.length === 0) return 90;
  if (ci.length > 1) return 80;
  return order[ci[0]] ?? 85;
}

// Mana-value bucket for grouping, e.g. 3 -> "3", 8 -> "7+".
function cmcGroupName(entry) {
  const c = Math.floor(entry.cmc || 0);
  return c >= 7 ? "7+" : String(c);
}

// Return the list of section labels (in order) for the active grouping mode.
function groupOrderFor(mode) {
  if (mode === "cmc") return MVL_GROUP_ORDER;
  if (mode === "color") return COLOR_GROUP_ORDER;
  return GROUP_ORDER;
}

// Compute the section label for an entry under the active grouping mode.
function groupLabelFor(entry, mode) {
  if (mode === "cmc") return cmcGroupName(entry);
  if (mode === "color") return colorGroupName(entry);
  if (mode === "none") return "__all__";
  return cardGroup(entry);
}

// Comparator for the active deck sort mode.
function deckComparator(mode) {
  const str = (a, b) => String(a ?? "").localeCompare(String(b ?? ""));
  switch (mode) {
    case "cmc":   return (a, b) => (a.cmc ?? 0) - (b.cmc ?? 0) || str(a.name, b.name);
    case "color": return (a, b) => colorSortIndex(a) - colorSortIndex(b) || str(a.name, b.name);
    case "type":  return (a, b) => {
      const ga = GROUP_ORDER.indexOf(cardGroup(a));
      const gb = GROUP_ORDER.indexOf(cardGroup(b));
      return ga - gb || str(a.name, b.name);
    };
    case "price": return (a, b) => (parseFloat(a.price_usd) || 0) - (parseFloat(b.price_usd) || 0) || str(a.name, b.name);
    case "name":
    default:      return (a, b) => str(a.name, b.name);
  }
}

/* ------------------------------------------------------------
   DECK FILTER — full Scryfall query support
   ------------------------------------------------------------
   The filter box accepts a complete Scryfall query (name words,
   `t:creature`, `cmc<=3`, `o:flying`, `c:wu`, `r:mythic`, `or`,
   parentheses, negations, etc.). Because that syntax can only be
   evaluated by Scryfall, we send the query to Scryfall *restricted
   to the cards already in the deck* (via an OR-list of exact
   names), then keep only the local cards whose names came back.
   Plain text with no query operators is matched locally instead,
   for instant feedback without a network round-trip.
   ============================================================ */

// Does the filter text look like it uses any Scryfall query syntax?
function looksLikeScryfallQuery(text) {
  // Operators like `t:`, comparisons (`cmc<=3`), quotes, parens, `or`,
  // leading `-`/`!`, or a `//` regex marker all indicate query syntax.
  return /[:"()]/.test(text)
    || /(^|\s)-(?=\S)/.test(text)
    || /(<=|>=|!=|[<>]=?)/.test(text)
    || /(^|\s)(or|and)\s/i.test(text)
    || text.includes("|");
}

// Escape a card name for use inside a double-quoted Scryfall `!"name"` term.
function scryfallNameTerm(name) {
  return `!"${String(name).replace(/"/g, '\\"')}"`;
}

// Every unique card name across all boards (used to constrain the search).
function uniqueBoardNames() {
  const names = new Set();
  [deck, sideboard, considering].forEach((arr) =>
    arr.forEach((e) => names.add(e.name)));
  return [...names];
}

// Resolve a Scryfall filter query against the cards currently in the deck.
// Returns a Set of matching card names (lowercase). Throws on network error.
async function resolveDeckFilter(query) {
  const names = uniqueBoardNames();
  if (!names.length) return new Set();

  const terms = names.map(scryfallNameTerm);
  // Chunk the OR-list so each request stays well within Scryfall's limits.
  const CHUNK = 40;
  const matched = new Set();
  for (let i = 0; i < terms.length; i += CHUNK) {
    const nameOr = terms.slice(i, i + CHUNK).join(" or ");
    const full = `(${query}) (${nameOr})`;
    const url = `${SCRYFALL_SEARCH}?q=${encodeURIComponent(full)}&unique=cards`;
    const res = await fetch(url, { headers: { Accept: "application/json" } });
    if (res.status === 404) continue; // no matches in this chunk is fine
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.details || `HTTP ${res.status}`);
    }
    const data = await res.json();
    (data.data || []).forEach((c) => matched.add(c.name.toLowerCase()));
    // Respect Scryfall's rate limit between chunked requests.
    if (i + CHUNK < terms.length) await sleep(120);
  }
  return matched;
}

// Does a store entry pass the active filter?
function entryMatchesDeckFilter(e) {
  const raw = deckFilterEl.value.trim();
  if (!raw) return true;
  // If a Scryfall query is active, use its resolved name set.
  if (deckFilter.names) return deckFilter.names.has(e.name.toLowerCase());
  // While a query is loading (or for plain text), fall back to substring.
  return e.name.toLowerCase().includes(raw.toLowerCase());
}

// Apply a new filter string: decide local vs Scryfall, resolve, and re-render.
let deckFilterTimer = null;
let deckFilterToken = 0; // guards against out-of-order async results
function applyDeckFilter() {
  const raw = deckFilterEl.value.trim();
  const isLocal = !raw || !looksLikeScryfallQuery(raw);

  if (isLocal) {
    // Instant local matching — no network.
    deckFilter.names = null;
    deckFilter.query = raw;
    deckFilter.loading = false;
    deckFilter.error = "";
    renderDeck();
    return;
  }

  // Scryfall query: resolve names, then re-render.
  const token = ++deckFilterToken;
  deckFilter.loading = true;
  deckFilter.error = "";
  deckFilter.query = raw;
  renderDeck();
  resolveDeckFilter(raw)
    .then((names) => {
      if (token !== deckFilterToken) return; // a newer filter supersedes this
      deckFilter.names = names;
      deckFilter.loading = false;
      renderDeck();
    })
    .catch((err) => {
      if (token !== deckFilterToken) return;
      deckFilter.names = null;     // fall back to substring matching
      deckFilter.loading = false;
      deckFilter.error = err.message;
      renderDeck();
    });
}

// Per-board wiring shared by the row and grid-tile builders: which menu to
// open, how to change quantity, and which drag source to report.
function boardBehaviors(board, e) {
  if (board === "side") return {
    source: "side",
    menu: sideboardMenuItems(e),
    inc: () => changeSideQty(e.id, 1),
    dec: () => changeSideQty(e.id, -1),
  };
  if (board === "consider") return {
    source: "consider",
    menu: consideringMenuItems(e),
    inc: () => changeConsideringQty(e.id, 1),
    dec: () => changeConsideringQty(e.id, -1),
  };
  return {
    source: "main",
    menu: deckMenuItems(e),
    inc: () => changeQty(e.id, 1),
    dec: () => changeQty(e.id, -1),
  };
}

// Build a single row element. `board` is "main" | "side" | "consider".
function buildBoardRow(e, board = "main") {
  const isSide = board === "side";
  const row = document.createElement("div");
  row.className = "deck-row";
  row.dataset.cardId = e.id;
  row.draggable = true;
  if (board === "main" && e.id === commanderId) row.classList.add("is-commander");
  const unitPrice = formatPrice(e.price_usd);
  const priceTitle = unitPrice
    ? `${unitPrice} each · ${formatPrice((parseFloat(e.price_usd) || 0) * e.qty)} total`
    : "Price unknown";
  const tagChips = (e.tags || []).map((t) =>
    `<span class="card-tag" title="Remove tag" data-tag="${escapeHtml(t)}">#${escapeHtml(t)}<span class="card-tag-x">×</span></span>`
  ).join("");
  row.innerHTML = `
    <div class="qty">
      <button data-act="dec" title="Remove one">−</button>
      <span>${e.qty}</span>
      <button data-act="inc" title="Add one">+</button>
    </div>
    <div class="card-name-wrap">
      <div class="card-name" title="${escapeHtml(e.name)}">${escapeHtml(e.name)}</div>
      <div class="card-tags">${tagChips}<button class="card-tag-add" data-act="addtag" title="Add tag (#tag)">+tag</button></div>
    </div>
    <div class="mana">${viewOpts.showMana ? manaCostHtml(e.mana_cost) : ""}</div>
    <div class="price${unitPrice ? "" : " empty"}" title="${escapeHtml(priceTitle)}">${viewOpts.showPrices ? (unitPrice || "—") : ""}</div>
    <button class="card-menu-btn" data-act="menu" title="Card actions" aria-haspopup="menu">⋯</button>
  `;
  const beh = boardBehaviors(board, e);
  row.querySelector('[data-act="inc"]').onclick = () => beh.inc();
  row.querySelector('[data-act="dec"]').onclick = () => beh.dec();
  row.querySelector('[data-act="menu"]').onclick = (ev) => {
    ev.stopPropagation();
    openCardMenu(ev.currentTarget, beh.menu);
  };

  // Tag interactions (stop propagation so they don't trigger drag/menu).
  row.querySelector('[data-act="addtag"]').onclick = (ev) => {
    ev.stopPropagation();
    const t = prompt("Add tag(s), space-separated. Use #name:", "#");
    if (!t) return;
    t.split(/\s+/).forEach((tok) => {
      const name = ensureTag(tok);
      if (name) mergeTags(e, [name]);
    });
    queueAutosave();
    rerenderBoard(board);
  };
  row.querySelectorAll(".card-tag").forEach((chip) => {
    chip.onclick = (ev) => {
      ev.stopPropagation();
      const name = chip.dataset.tag;
      if (confirm(`Rename tag "#${name}"?\n\nOK = rename, Cancel = remove.`)) {
        const nn = prompt("Rename tag to:", name);
        if (nn) renameTag(name, nn);
      } else {
        e.tags = (e.tags || []).filter((x) => x !== name);
        queueAutosave();
        rerenderBoard(board);
      }
    };
  });

  row.addEventListener("dragstart", (ev) => {
    startDrag(ev, { source: beh.source, id: e.id, card: e });
  });
  row.addEventListener("dragend", endDrag);
  row.addEventListener("contextmenu", (ev) => {
    ev.preventDefault();
    openCardMenuAt(ev.clientX, ev.clientY, beh.menu);
  });

  // Hovering anywhere on the card shows it in the top-right preview.
  row.addEventListener("mouseenter", () => setPreview(e));

  return row;
}

// Back-compat alias for existing callers in the main deck.
function buildDeckRow(e) { return buildBoardRow(e, "main"); }

/* ---------------- CARD GRID VIEW ----------------
   When View > Card grid is on, cards render as image tiles instead of text
   rows. The tile shows the card image, a quantity badge, the name, the mana
   cost, and price, plus the same ⋯ actions menu / drag behavior as rows. */
function buildBoardCell(e, board = "main") {
  const cell = document.createElement("div");
  cell.className = "deck-cell";
  cell.dataset.cardId = e.id;
  cell.draggable = true;
  if (board === "main" && e.id === commanderId) cell.classList.add("is-commander");
  const unitPrice = formatPrice(e.price_usd);
  const priceTitle = unitPrice
    ? `${unitPrice} each · ${formatPrice((parseFloat(e.price_usd) || 0) * e.qty)} total`
    : "Price unknown";
  cell.innerHTML = `
    <div class="cell-img">
      <img src="${escapeHtml(e.image || "")}" alt="${escapeHtml(e.name)}" loading="lazy" />
      <span class="cell-qty" title="Quantity">${e.qty}</span>
      <button class="card-menu-btn" data-act="menu" title="Card actions" aria-haspopup="menu">⋯</button>
    </div>
    <div class="cell-footer">
      <div class="cell-name" title="${escapeHtml(e.name)}">${escapeHtml(e.name)}</div>
      <div class="cell-meta">
        <span class="cell-mana">${viewOpts.showMana ? manaCostHtml(e.mana_cost) : ""}</span>
        <span class="cell-price${unitPrice ? "" : " empty"}" title="${escapeHtml(priceTitle)}">${viewOpts.showPrices ? (unitPrice || "") : ""}</span>
      </div>
    </div>
    <div class="cell-qty-controls">
      <button data-act="dec" title="Remove one">−</button>
      <button data-act="inc" title="Add one">+</button>
    </div>
  `;
  const beh = boardBehaviors(board, e);
  cell.querySelector('[data-act="inc"]').onclick = (ev) => { ev.stopPropagation(); beh.inc(); };
  cell.querySelector('[data-act="dec"]').onclick = (ev) => { ev.stopPropagation(); beh.dec(); };
  cell.querySelector('[data-act="menu"]').onclick = (ev) => {
    ev.stopPropagation();
    openCardMenu(ev.currentTarget, beh.menu);
  };

  cell.addEventListener("dragstart", (ev) => {
    startDrag(ev, { source: beh.source, id: e.id, card: e });
  });
  cell.addEventListener("dragend", endDrag);
  cell.addEventListener("contextmenu", (ev) => {
    ev.preventDefault();
    openCardMenuAt(ev.clientX, ev.clientY, beh.menu);
  });
  cell.addEventListener("mouseenter", () => setPreview(e));
  return cell;
}

// Build the right kind of element for the active view (rows or grid tiles).
function buildBoardItem(e, board = "main") {
  return viewOpts.gridView ? buildBoardCell(e, board) : buildBoardRow(e, board);
}

// The class for a section container under the active view.
function boardGridClass() {
  if (viewOpts.gridView) return "card-grid grid-view";
  return "card-grid" + (viewOpts.twoColumn ? "" : " single-col");
}

// A small status line shown above the list while a filter is resolving.
function filterStatusHtml() {
  if (deckFilter.loading) return `<p class="hint filter-status">Filtering…</p>`;
  if (deckFilter.error) return `<p class="hint filter-status">Filter error: ${escapeHtml(deckFilter.error)}</p>`;
  return "";
}

// Track collapsed deck sections (by group name / "Commander")
const collapsedSections = new Set();

function makeSectionTitle(label, count, extraClass = "") {
  const title = document.createElement("div");
  title.className = "deck-group-title" + (extraClass ? " " + extraClass : "");
  const collapsed = collapsedSections.has(label);
  title.innerHTML = `<span class="chev">${collapsed ? "▸" : "▾"}</span> ${label} <span class="count">${count}</span>`;
  title.style.cursor = "pointer";
  title.addEventListener("click", () => {
    if (collapsedSections.has(label)) collapsedSections.delete(label);
    else collapsedSections.add(label);
    renderDeck();
  });
  return title;
}

function renderDeck() {
  const empty = deck.length === 0;
  const filterActive = deckFilterEl.value.trim().length > 0;
  deckListEl.innerHTML = "";

  const status = filterStatusHtml();
  const visible = deck.filter(entryMatchesDeckFilter);
  if (visible.length === 0) {
    deckListEl.innerHTML = status +
      `<p class="hint">${empty ? "Empty deck. Search and click cards to add."
        : (filterActive ? "No cards match filter." : "No cards.")}</p>`;
    updateBoardTabs();
    return;
  }
  if (status) deckListEl.insertAdjacentHTML("beforeend", status);

  // --- COMMANDER SECTION (top, if a commander is set and visible) ---
  const cmdrEntry = deck.find((e) => e.id === commanderId);
  if (cmdrEntry && entryMatchesDeckFilter(cmdrEntry)) {
    deckListEl.appendChild(makeSectionTitle("Commander", 1, "commander"));
    if (!collapsedSections.has("Commander")) {
      const grid = document.createElement("div");
      grid.className = boardGridClass();
      grid.appendChild(buildBoardItem(cmdrEntry, "main"));
      deckListEl.appendChild(grid);
    }
  }

  // --- SECTIONS (grouping driven by the Deck menu) ---
  const cmp = deckComparator(deckSort);
  const groups = {};
  visible.forEach((e) => {
    if (e.id === commanderId) return; // commander already shown above
    const g = groupLabelFor(e, deckGroup);
    (groups[g] = groups[g] || []).push(e);
  });

  // Order the sections; when grouping by "none" there's a single section.
  const orderedLabels = deckGroup === "none"
    ? (groups.__all__ ? ["__all__"] : [])
    : groupOrderFor(deckGroup).filter((g) => groups[g]);

  orderedLabels.forEach((g) => {
    const items = groups[g];
    if (deckGroup !== "none") {
      const count = items.reduce((s, e) => s + e.qty, 0);
      deckListEl.appendChild(makeSectionTitle(g, count));
      if (collapsedSections.has(g)) return;
    }
    const grid = document.createElement("div");
    grid.className = boardGridClass();
    items.slice().sort(cmp).forEach((e) => grid.appendChild(buildBoardItem(e, "main")));
    deckListEl.appendChild(grid);
  });

  updateBoardTabs();
}

/* ---------------- SIDEBOARD RENDERING ---------------- */
function renderSideboard() {
  const filter = sideFilterEl.value.trim().toLowerCase();
  sideboardListEl.innerHTML = "";
  const visible = sideboard.filter((e) => !filter || e.name.toLowerCase().includes(filter));
  if (visible.length === 0) {
    sideboardListEl.innerHTML = `<p class="hint">${sideboard.length ? "No cards match filter." : "Empty sideboard. Drag cards here, or use ⋯ on a card."}</p>`;
    updateBoardTabs();
    return;
  }
  const sorted = visible.slice().sort((a, b) => (a.edhrec_rank ?? Infinity) - (b.edhrec_rank ?? Infinity));
  const grid = document.createElement("div");
  grid.className = boardGridClass();
  sorted.forEach((e) => grid.appendChild(buildBoardItem(e, "side")));
  sideboardListEl.appendChild(grid);
  updateBoardTabs();
}

// Update the deck header count and the dock tab counts.
function updateBoardTabs() {
  const n = sideboardCount();
  if (sideCountEl) sideCountEl.textContent = `${n} card${n === 1 ? "" : "s"}`;
  const t = totalCards();
  if (deckCountEl) deckCountEl.textContent = `${t} card${t === 1 ? "" : "s"}`;
}

/* ============================================================
   STATS
   ============================================================ */
const COLOR_NAMES = { W: "White", U: "Blue", B: "Black", R: "Red", G: "Green" };
const COLOR_ORDER = ["W", "U", "B", "R", "G"];

function renderStats() {
  const total = totalCards();
  const totalCmc = deck.reduce((s, e) => s + e.cmc * e.qty, 0);
  const lands = deck.filter((e) => cardGroup(e) === "Lands").reduce((s, e) => s + e.qty, 0);
  const nonLands = total - lands;
  const avgCmc = nonLands > 0
    ? deck.filter((e) => cardGroup(e) !== "Lands").reduce((s, e) => s + e.cmc * e.qty, 0) / nonLands
    : 0;

  // Color distribution (pip count from mana costs)
  const colorPips = { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 };
  deck.forEach((e) => {
    const cost = e.mana_cost || "";
    const matches = cost.match(/\{([^}]+)\}/g) || [];
    matches.forEach((m) => {
      const sym = m.slice(1, -1);
      // handle hybrid / phyrexian like {W/U}, {2/W}, {W/P}
      const parts = sym.split("/");
      parts.forEach((p) => {
        if (COLOR_NAMES[p]) colorPips[p] += e.qty;
      });
    });
    if (!matches.some((m) => COLOR_NAMES[m.slice(1, -1).split("/")[0]])) {
      colorPips.C += 0; // colorless tracking handled below
    }
  });

  // Mana curve
  const curve = { 0: 0, 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, "6+": 0 };
  deck.forEach((e) => {
    if (cardGroup(e) === "Lands") return;
    const c = Math.floor(e.cmc);
    if (c >= 6) curve["6+"] += e.qty;
    else curve[c] = (curve[c] || 0) + e.qty;
  });
  const curveMax = Math.max(1, ...Object.values(curve));

  // Type breakdown
  const types = {};
  deck.forEach((e) => {
    const g = cardGroup(e);
    types[g] = (types[g] || 0) + e.qty;
  });

  const pipTotal = COLOR_ORDER.reduce((s, c) => s + colorPips[c], 0);

  // Price totals (USD). Cards with unknown price count as 0.
  const deckPrice = boardPrice(deck);
  const sidePrice = boardPrice(sideboard);
  const considerPrice = boardPrice(considering);
  const totalPrice = deckPrice + sidePrice + considerPrice;

  // Compact stat cells, laid out in a two-column grid.
  const cells = [
    ["Total", total],
    ["Lands", lands],
    ["Non-lands", nonLands],
    ["Avg CMC", avgCmc.toFixed(2)],
    ["Unique", deck.length],
    ["Deck $", "$" + deckPrice.toFixed(2)],
  ];
  if (sideboard.length) cells.push(["Side $", "$" + sidePrice.toFixed(2)]);
  if (considering.length) cells.push(["Consider $", "$" + considerPrice.toFixed(2)]);
  if (sideboard.length || considering.length) cells.push(["Total $", "$" + totalPrice.toFixed(2)]);

  let html = `<div class="stat-grid">`;
  cells.forEach(([label, val]) => {
    html += `<div class="stat-cell"><span class="label">${label}</span><span class="val">${val}</span></div>`;
  });
  html += `</div>`;


  // Color pips bar
  if (pipTotal > 0) {
    html += `<div class="stat-row"><span class="label">Pips</span><div class="bar">`;
    COLOR_ORDER.forEach((c) => {
      const pct = (colorPips[c] / pipTotal) * 100;
      if (pct > 0) html += `<i class="m-${c}" style="width:${pct}%" title="${COLOR_NAMES[c]}: ${colorPips[c]}"></i>`;
    });
    html += `</div><span class="val">${pipTotal}</span></div>`;
  }

  // Curve
  html += `<div class="stat-row"><span class="label">Mana curve</span><span class="val"></span></div>`;
  html += `<div class="mana-cost-bar">`;
  Object.keys(curve).forEach((k) => {
    const v = curve[k];
    const pct = (v / curveMax) * 100;
    html += `
      <div class="stat-row">
        <span class="label" style="width:34px">${k}</span>
        <div class="bar"><i class="m-U" style="width:${pct}%"></i></div>
        <span class="val">${v}</span>
      </div>`;
  });
  html += `</div>`;

  statsEl.innerHTML = html;
}

/* ============================================================
   CARD PREVIEW (top-right panel)
   ============================================================ */
// Show a card image in the right-hand Card Preview panel.
function setPreview(entry) {
  if (!entry || !entry.image) return;
  previewEl.innerHTML = `<img src="${entry.image}" alt="${escapeHtml(entry.name)}" />`;
}

/* ============================================================
   IMPORT / EXPORT
   ============================================================ */
// Format one deck line: "qty name #tag #tag".
function exportLine(e) {
  const tags = (e.tags && e.tags.length) ? " " + e.tags.map((t) => "#" + t).join(" ") : "";
  return `${e.qty} ${e.name}${tags}`;
}

function exportDecklist() {
  const lines = [];
  const cmdr = deck.find((e) => e.id === commanderId);
  if (cmdr) {
    lines.push("// Commander");
    lines.push(exportLine(cmdr));
    lines.push("");
  }
  GROUP_ORDER.forEach((g) => {
    const inGroup = deck.filter((e) => cardGroup(e) === g && e.id !== commanderId);
    if (!inGroup.length) return;
    lines.push(`// ${g}`);
    inGroup.forEach((e) => lines.push(exportLine(e)));
    lines.push("");
  });
  if (sideboard.length) {
    lines.push("// Sideboard");
    sideboard.forEach((e) => lines.push(`SB: ${exportLine(e)}`));
    lines.push("");
  }
  if (considering.length) {
    lines.push("// Considering");
    considering.forEach((e) => lines.push(exportLine(e)));
    lines.push("");
  }
  return lines.join("\n").trim();
}

// Parse a text decklist into {qty, name, side} entries.
function parseDecklist(text) {
  const entries = [];
  let inSideSection = false;
  text.split(/\r?\n/).forEach((raw) => {
    let line = raw.trim();
    if (!line) return;
    // Section headers like "// Sideboard" or "Sideboard" switch the current board.
    if (line.startsWith("//") || line.startsWith("#")) {
      const hdr = line.replace(/^[\/#]+\s*/, "").toLowerCase();
      if (hdr.includes("sideboard") || hdr === "side" || hdr === "sb") inSideSection = true;
      else if (hdr.includes("commander") || hdr.includes("deck") || hdr.includes("main")) inSideSection = false;
      return;
    }
    // Inline "Sideboard" / "SB:" markers on their own line.
    if (/^sideboard\s*:?\s*$/i.test(line)) { inSideSection = true; return; }
    // A leading "SB:" marks a single sideboard line.
    let isSide = inSideSection;
    const sbMatch = line.match(/^SB:\s*(.+)$/i);
    if (sbMatch) { isSide = true; line = sbMatch[1].trim(); }

    // Extract inline "#tag" tokens (Moxfield style) and remove them from the name.
    const tags = [];
    line = line.replace(/(?:^|\s)#([A-Za-z0-9_\-]+)/g, (_, t) => { tags.push(t); return " "; });

    // match optional qty at start: "4 ", "4x ", "4 x "
    const m = line.match(/^(\d+)\s*x?\s+(.+)$/i);
    let qty = 1, name = line.trim();
    if (m) {
      qty = parseInt(m[1], 10);
      name = m[2].trim();
    }
    // strip trailing set codes / etc. after a name like "(M21) 123" — keep simple
    name = name.replace(/\s*\([A-Z0-9]+\)\s*\d*$/i, "").trim();
    if (!name) return;
    entries.push({ qty, name, side: isSide, tags });
  });
  return entries;
}

async function importDecklist(text) {
  const parsed = parseDecklist(text);
  if (!parsed.length) {
    alert("Couldn't read any cards from that text.\n\nPaste a decklist with one card per line, e.g.\n\n1 Sol Ring\n4 Lightning Bolt");
    return;
  }

  // Resolve names via Scryfall collection endpoint (max 75 per request)
  const chunks = [];
  for (let i = 0; i < parsed.length; i += 75) chunks.push(parsed.slice(i, i + 75));

  const resolved = [];
  const notFound = [];
  for (const chunk of chunks) {
    const res = await fetch(SCRYFALL_COLLECTION, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ identifiers: chunk.map((c) => ({ name: c.name })) }),
    });
    const data = await res.json();
    (data.data || []).forEach((card) => resolved.push(card));
    if (data.not_found && data.not_found.length) {
      data.not_found.forEach((nf) => notFound.push(nf.name || nf));
      console.warn("Not found:", data.not_found);
    }
  }

  // Merge resolved cards by name (qty from parsed list)
  const byName = {};
  resolved.forEach((c) => (byName[c.name.toLowerCase()] = c));

  parsed.forEach((p) => {
    const card = byName[p.name.toLowerCase()];
    if (!card) {
      if (!notFound.includes(p.name)) notFound.push(p.name);
      return;
    }
    const tagNames = (p.tags || []).map((t) => ensureTag(t)).filter(Boolean);
    if (p.side) addCardToSideInternal(card, p.qty, tagNames);
    else addCardToDeckInternal(card, p.qty, tagNames);
  });

  function addCardToDeckInternal(card, qty, tags) {
    const existing = findDeckEntry(card);
    if (existing) mergeTags(existing, tags);
    else deck.push(mergeEntryTags(makeEntry(card, qty), tags));
  }

  function addCardToSideInternal(card, qty, tags) {
    const existing = sideboard.find((e) => e.id === card.id);
    if (existing) mergeTags(existing, tags);
    else sideboard.push(mergeEntryTags(makeEntry(card, qty), tags));
  }

  renderDeck();
  renderSideboard();
  renderStats();
  updateBoardTabs();
  queueAutosave();

  // Summarize the result. Call out any names Scryfall couldn't resolve.
  let msg = `Imported ${resolved.length} of ${parsed.length} card(s).`;
  if (notFound.length) {
    const shown = notFound.slice(0, 10).join("\n  • ");
    const more = notFound.length > 10 ? `\n  …and ${notFound.length - 10} more` : "";
    msg += `\n\nCouldn't find these in Scryfall (check spelling):\n  • ${shown}${more}`;
  }
  if (resolved.length === 0) {
    msg += "\n\nTip: import needs internet access to Scryfall. If you're opening the file directly, run `python3 serve.py` instead.";
  }
  alert(msg);
}

/* ============================================================
   DECK PERSISTENCE  (Supabase-only — no local deck storage)
   ------------------------------------------------------------
   Decks live in Supabase, keyed by row id, scoped to the signed-in
   user. Every mutation triggers a debounced autosave. Only UI
   preferences (sort/group/view/dock sizes) use localStorage.

   `currentDeckId` is the id of the deck open in the builder.
   ============================================================ */
let currentDeckId = null;          // id of the deck being edited (null = none)
let currentDeckMeta = {};          // { description, isPublic, colorIdentity }

function cloudAuth() { return window.BarebonesAuth || null; }
function isCloudEnabled() { const a = cloudAuth(); return !!(a && a.enabled); }
function isSignedIn() { const a = cloudAuth(); return !!(a && a.getUser && a.getUser()); }

// Turn the in-memory boards into the saveDeck payload (ids + qty + board + tags).
function boardsToPayload() {
  const cards = [];
  const pushBoard = (arr, board) => {
    (arr || []).forEach((e) => {
      if (e && e.id) cards.push({ id: e.id, qty: e.qty || 1, board, tags: e.tags || [] });
    });
  };
  pushBoard(deck, "main");
  pushBoard(sideboard, "sideboard");
  pushBoard(considering, "considering");
  const ciEl = document.getElementById("deck-color-identity");
  return {
    name: deckNameEl.value.trim() || "Untitled Deck",
    format: selectedFormat(),
    commanderId: commanderId || null,
    description: currentDeckMeta.description || "",
    isPublic: !!currentDeckMeta.isPublic,
    colorIdentity: (ciEl && ciEl.value) || "",
    cards,
  };
}

/* ---------------- Debounced autosave ---------------- */
let autosaveTimer = null;
let saving = false;
let saveQueued = false;

/** Mark the deck dirty and schedule a debounced autosave (~900ms idle). */
function queueAutosave() {
  if (!currentDeckId) return;            // nothing open
  if (!isSignedIn()) { setSaveStatus("offline"); return; }
  setSaveStatus("saving");
  clearTimeout(autosaveTimer);
  autosaveTimer = setTimeout(flushAutosave, 900);
}

async function flushAutosave() {
  const a = cloudAuth();
  if (!a || !isSignedIn() || !currentDeckId) return;
  if (saving) { saveQueued = true; return; }  // avoid overlapping writes
  saving = true;
  try {
    await a.saveDeck(currentDeckId, boardsToPayload());
    setSaveStatus("saved");
  } catch (err) {
    console.error("Autosave failed:", err);
    setSaveStatus("error");
  } finally {
    saving = false;
    if (saveQueued) { saveQueued = false; queueAutosave(); }
  }
}

// Reflect save state in the builder status text + decks-screen dot.
function setSaveStatus(state) {
  const el = document.getElementById("builder-save-status");
  if (el) {
    el.textContent = ({ saved: "Saved", saving: "Saving…", offline: "Offline", error: "Save failed" })[state] || "";
    el.dataset.state = state;
  }
  const dot = document.getElementById("decks-sync-dot");
  if (dot) dot.className = "auth-sync-dot" + ({ saved: " ok", saving: " busy", error: " error" }[state] || "");
}

/* ============================================================
   SCREEN ROUTER  (home → decks → builder)
   ============================================================ */
function showScreen(name) {
  for (const id of ["screen-home", "screen-decks", "screen-builder"]) {
    const el = document.getElementById(id);
    if (el) el.hidden = (id !== "screen-" + name);
  }
  window.scrollTo(0, 0);
}

// Decide which screen to show based on auth state.
function routeByAuth() {
  if (!isSignedIn()) { showScreen("home"); return; }
  renderDecksScreen();
  showScreen("decks");
}

/* ============================================================
   MY DECKS SCREEN
   ============================================================ */
async function renderDecksScreen() {
  const list = document.getElementById("decks-list");
  const empty = document.getElementById("decks-empty");
  if (!list) return;
  list.innerHTML = '<p class="hint">Loading…</p>';
  try {
    const decks = await cloudAuth().listDecks();
    list.innerHTML = "";
    if (!decks.length) { if (empty) empty.hidden = false; return; }
    if (empty) empty.hidden = true;
    for (const d of decks) list.appendChild(makeDeckCard(d));
  } catch (err) {
    console.error("Failed to list decks:", err);
    list.innerHTML = '<p class="hint">Could not load your decks. Are you online?</p>';
  }
}

function makeDeckCard(d) {
  const card = document.createElement("div");
  card.className = "deck-card";
  card.innerHTML = `
    <div class="deck-card-main">
      <div class="deck-card-name"></div>
      <div class="deck-card-meta">
        <span class="deck-card-format"></span>
        <span class="deck-card-updated"></span>
      </div>
    </div>
    <div class="deck-card-actions">
      <button class="deck-card-delete" title="Delete deck">🗑</button>
    </div>`;
  card.querySelector(".deck-card-name").textContent = d.name || "Untitled Deck";
  card.querySelector(".deck-card-format").textContent = d.commanderId ? "Commander" : (d.format || "No format");
  card.querySelector(".deck-card-updated").textContent =
    d.updated ? "edited " + new Date(d.updated).toLocaleDateString() : "";
  card.addEventListener("click", (e) => {
    if (e.target.closest(".deck-card-delete")) return;
    openDeck(d.id);
  });
  card.querySelector(".deck-card-delete").addEventListener("click", async (e) => {
    e.stopPropagation();
    if (!confirm(`Delete "${d.name}"? This cannot be undone.`)) return;
    try { await cloudAuth().deleteDeck(d.id); renderDecksScreen(); }
    catch (err) { alert("Delete failed: " + err.message); }
  });
  return card;
}

async function createNewDeck() {
  try {
    const d = await cloudAuth().createDeck("Untitled Deck", "commander");
    openDeck(d.id);
  } catch (err) { alert("Could not create deck: " + err.message); }
}

/* ============================================================
   OPEN A DECK INTO THE BUILDER
   ============================================================ */
async function openDeck(deckId) {
  const a = cloudAuth();
  if (!a || !isSignedIn()) { showScreen("home"); return; }
  setSaveStatus("saving");
  try {
    const data = await a.getDeck(deckId);
    if (!data) { alert("Deck not found."); renderDecksScreen(); return; }

    // Rehydrate card objects from Scryfall (only ids are stored).
    const cardMap = await rehydrateCardsByIds(data.cards.map((c) => c.scryfall_id));

    deck = []; sideboard = []; considering = []; commanderId = null;
    data.cards.forEach((c) => {
      const base = cardMap[c.scryfall_id];
      if (!base) return;                       // unknown printing; skip
      const entry = { ...base, qty: c.quantity, tags: c.tags || [] };
      if (c.board === "sideboard") sideboard.push(entry);
      else if (c.board === "considering") considering.push(entry);
      else deck.push(entry);
    });

    commanderId = data.commanderId || null;
    deckNameEl.value = data.name || "Untitled Deck";
    const fmtEl = $("format-select");
    if (fmtEl) fmtEl.value = data.format || "";
    const ciEl = document.getElementById("deck-color-identity");
    if (ciEl) ciEl.value = data.colorIdentity || "";

    currentDeckId = deckId;
    currentDeckMeta = { description: data.description || "", isPublic: !!data.isPublic };
    loadTagRegistry(data.tags || []);

    syncMenuChecks();
    renderDeck(); renderSideboard(); renderConsidering(); renderStats(); updateBoardTabs();
    setSaveStatus("saved");
    showScreen("builder");
  } catch (err) {
    console.error("Failed to open deck:", err);
    setSaveStatus("error");
    alert("Could not open deck: " + err.message);
  }
}

/* ---------------- Rehydrate card objects from Scryfall ids ---------------- */
async function rehydrateCardsByIds(ids) {
  const unique = [...new Set(ids.filter(Boolean))];
  const map = {};
  if (!unique.length) return map;
  for (let i = 0; i < unique.length; i += 75) {
    const chunk = unique.slice(i, i + 75);
    try {
      const res = await fetch(SCRYFALL_COLLECTION, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ identifiers: chunk.map((id) => ({ id })) }),
      });
      const data = await res.json();
      (data.data || []).forEach((card) => { map[card.id] = makeEntry(card, 1); });
    } catch (err) {
      console.error("Rehydrate failed for a chunk:", err);
    }
  }
  return map;
}

/* ============================================================
   TAG SYSTEM  (per-deck registry; cards reference tag names)
   ============================================================ */
let tagRegistry = [];

function loadTagRegistry(tags) {
  tagRegistry = (tags || []).map((t) => ({ id: t.id, name: t.name }));
}

// Ensure a tag name exists in the registry; return the canonical name.
function ensureTag(name) {
  const clean = String(name || "").trim().replace(/^#/, "");
  if (!clean) return null;
  const found = tagRegistry.find((t) => t.name.toLowerCase() === clean.toLowerCase());
  if (found) return found.name;
  tagRegistry.push({ id: null, name: clean });
  return clean;
}

// Rename a tag across the registry and every card.
function renameTag(oldName, newName) {
  const clean = String(newName || "").trim().replace(/^#/, "");
  if (!clean) return;
  const t = tagRegistry.find((x) => x.name === oldName);
  if (t) t.name = clean;
  for (const board of [deck, sideboard, considering]) {
    for (const e of board) {
      if (e.tags && e.tags.includes(oldName)) {
        e.tags = e.tags.map((n) => (n === oldName ? clean : n));
      }
    }
  }
  queueAutosave();
  renderDeck(); renderSideboard(); renderConsidering();
}

// Re-render a single board by name.
function rerenderBoard(board) {
  if (board === "side") renderSideboard();
  else if (board === "consider") renderConsidering();
  else renderDeck();
}

// Merge tag names onto an existing card entry (dedup, case-insensitive).
function mergeTags(entry, tags) {
  if (!tags || !tags.length) return entry;
  entry.tags = entry.tags || [];
  for (const t of tags) {
    if (!entry.tags.some((x) => x.toLowerCase() === t.toLowerCase())) entry.tags.push(t);
  }
  return entry;
}
function mergeEntryTags(entry, tags) { return mergeTags(entry, tags); }

// Remove a tag entirely (registry + every card).
function deleteTag(name) {
  tagRegistry = tagRegistry.filter((t) => t.name !== name);
  for (const board of [deck, sideboard, considering]) {
    for (const e of board) {
      if (e.tags) e.tags = e.tags.filter((n) => n !== name);
    }
  }
  queueAutosave();
  renderDeck(); renderSideboard(); renderConsidering();
}

/* ---------------- Auth-aware UI bits ---------------- */
function renderAuthUI(user) {
  const meta = (user && user.user_metadata) || {};
  const label = meta.full_name || meta.name || (user && user.email) || "Signed in";
  const pic = meta.avatar_url || meta.picture;

  const homeSignin = document.getElementById("home-signin");
  const homeNote = document.getElementById("home-note");
  if (homeSignin) homeSignin.hidden = !!user;
  if (homeNote) homeNote.textContent = user ? "" : "Sign in to continue.";

  const userBox = document.getElementById("decks-user");
  if (userBox) {
    userBox.hidden = !user;
    const nameEl = document.getElementById("decks-name");
    const av = document.getElementById("decks-avatar");
    if (nameEl) nameEl.textContent = label;
    if (av) { if (pic) { av.src = pic; av.hidden = false; } else av.hidden = true; }
  }
}

// Kept as a hook for menu wiring.
async function syncFromCloud() {
  if (isSignedIn()) { renderDecksScreen(); showScreen("decks"); }
}

/* ============================================================
   COLLAPSIBLE / RESIZABLE BOARD DOCKS
   ------------------------------------------------------------
   Shared behavior for the Considering and Sideboard boards at the
   bottom of the deck panel: click the header to expand/collapse,
   drag the top edge to resize the height. State is persisted.
   ============================================================ */
const MIN_DOCK_HEIGHT = 80;
const DEFAULT_DOCK_HEIGHT = 220;
const MAX_DOCK_HEIGHT = 720;

function setupDock({ dockEl, toggleEl, bodyEl, handleEl, openKey, heightKey }) {
  if (!dockEl || !toggleEl || !bodyEl || !handleEl) return;

  // Restore the saved height (as a CSS variable on the body element).
  const savedH = parseInt(localStorage.getItem(heightKey) || "", 10);
  const startH = isNaN(savedH) ? DEFAULT_DOCK_HEIGHT : savedH;
  bodyEl.style.setProperty("--dock-height", startH + "px");

  // Restore / initialize the open state.
  const savedOpen = localStorage.getItem(openKey) === "true";
  setOpen(savedOpen);

  function setOpen(open) {
    bodyEl.classList.toggle("open", open);
    dockEl.classList.toggle("collapsed", !open);
    toggleEl.setAttribute("aria-expanded", open ? "true" : "false");
    localStorage.setItem(openKey, open ? "true" : "false");
  }

  toggleEl.addEventListener("click", () => setOpen(!bodyEl.classList.contains("open")));

  // --- Height resize ---
  let startY = 0;
  let startHeight = 0;

  const onMove = (ev) => {
    // Dragging up (smaller clientY) grows the dock.
    const next = startHeight + (startY - ev.clientY);
    const clamped = Math.max(MIN_DOCK_HEIGHT, Math.min(MAX_DOCK_HEIGHT, next));
    bodyEl.style.setProperty("--dock-height", clamped + "px");
  };

  const onUp = () => {
    handleEl.classList.remove("dragging");
    document.body.classList.remove("row-resizing");
    document.removeEventListener("pointermove", onMove);
    document.removeEventListener("pointerup", onUp);
    document.removeEventListener("pointercancel", onUp);
    const h = parseInt(getComputedStyle(bodyEl).getPropertyValue("--dock-height"), 10);
    if (!isNaN(h)) localStorage.setItem(heightKey, String(h));
  };

  handleEl.addEventListener("pointerdown", (ev) => {
    ev.preventDefault();
    startY = ev.clientY;
    startHeight = bodyEl.getBoundingClientRect().height;
    handleEl.classList.add("dragging");
    document.body.classList.add("row-resizing");
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
    document.addEventListener("pointercancel", onUp);
  });

  // Double-click the handle resets to the default height.
  handleEl.addEventListener("dblclick", () => {
    bodyEl.style.setProperty("--dock-height", DEFAULT_DOCK_HEIGHT + "px");
    localStorage.setItem(heightKey, String(DEFAULT_DOCK_HEIGHT));
  });
}

/* ============================================================
   RESIZABLE SEARCH PANEL
   ------------------------------------------------------------
   Drag the handle on the search panel's right edge to widen it.
   Cards keep a fixed size; the grid simply fits more columns as
   the panel grows. The chosen width is remembered in localStorage.
   ============================================================ */
const LS_SEARCH_WIDTH = "barebones_search_width";
const MIN_SEARCH_WIDTH = 220;
const MAX_SEARCH_WIDTH = 900;

function applySearchWidth(px) {
  const clamped = Math.max(MIN_SEARCH_WIDTH, Math.min(MAX_SEARCH_WIDTH, px));
  document.documentElement.style.setProperty("--search-width", clamped + "px");
  return clamped;
}

function setupSearchResize() {
  const handle = $("search-resize");
  const layoutEl = document.querySelector(".layout");
  if (!handle || !layoutEl) return;

  // Restore a previously saved width.
  const saved = parseInt(localStorage.getItem(LS_SEARCH_WIDTH) || "", 10);
  if (!isNaN(saved)) applySearchWidth(saved);

  let startX = 0;
  let startWidth = 0;

  const onMove = (ev) => {
    applySearchWidth(startWidth + (ev.clientX - startX));
  };

  const onUp = () => {
    handle.classList.remove("dragging");
    document.body.classList.remove("col-resizing");
    document.removeEventListener("pointermove", onMove);
    document.removeEventListener("pointerup", onUp);
    document.removeEventListener("pointercancel", onUp);
    const w = parseInt(getComputedStyle(document.documentElement)
      .getPropertyValue("--search-width"), 10);
    if (!isNaN(w)) localStorage.setItem(LS_SEARCH_WIDTH, String(w));
  };

  handle.addEventListener("pointerdown", (ev) => {
    ev.preventDefault();
    const rect = document.querySelector(".search-panel").getBoundingClientRect();
    startX = ev.clientX;
    startWidth = rect.width;
    handle.classList.add("dragging");
    document.body.classList.add("col-resizing");
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
    document.addEventListener("pointercancel", onUp);
  });

  // Double-click the handle resets to the default width.
  handle.addEventListener("dblclick", () => {
    applySearchWidth(320);
    localStorage.setItem(LS_SEARCH_WIDTH, "320");
  });
}

/* ============================================================
   MENU BAR (File / Deck / View / Search)
   ------------------------------------------------------------
   A simple dropdown menu system. The hidden native <select> elements
   (format, sort) remain the source of truth; the menu items build from
   them and write back, dispatching `change` so existing wiring fires.
   ============================================================ */
const LS_VIEW_PREFS = "barebones_view_prefs";

// Populate the Deck > Format list and Search > Sort list from the hidden
// selects, then sync the checked state of every checkable item.
function setupMenuBar() {
  const menubar = $("menubar");
  if (!menubar) return;

  // --- Build Deck > Format items from #format-select ---
  const formatList = $("menu-format-list");
  const formatSelect = $("format-select");
  if (formatList && formatSelect) {
    formatList.innerHTML = "";
    [...formatSelect.options].forEach((opt) => {
      const btn = document.createElement("button");
      btn.className = "menu-item checkable";
      btn.dataset.format = opt.value;
      btn.setAttribute("role", "menuitemradio");
      btn.textContent = opt.textContent;
      btn.addEventListener("click", () => {
        formatSelect.value = opt.value;
        formatSelect.dispatchEvent(new Event("change"));
        syncMenuChecks();
        closeAllMenus();
      });
      formatList.appendChild(btn);
    });
  }

  // --- Build Search > Sort items from #sort-select ---
  const sortList = $("menu-sort-list");
  const sortSelect = $("sort-select");
  if (sortList && sortSelect) {
    sortList.innerHTML = "";
    [...sortSelect.options].forEach((opt) => {
      const btn = document.createElement("button");
      btn.className = "menu-item checkable";
      btn.dataset.sorts = opt.value;
      btn.setAttribute("role", "menuitemradio");
      btn.textContent = opt.textContent;
      btn.addEventListener("click", () => {
        sortSelect.value = opt.value;
        sortSelect.dispatchEvent(new Event("change"));
        syncMenuChecks();
        closeAllMenus();
      });
      sortList.appendChild(btn);
    });
  }

  // --- Toggle dropdowns on the top-level menu buttons ---
  menubar.querySelectorAll(".menu > .menu-btn").forEach((btn) => {
    btn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      const menu = btn.parentElement;
      const isOpen = menu.classList.contains("open");
      closeAllMenus();
      if (!isOpen) {
        menu.classList.add("open");
        btn.setAttribute("aria-expanded", "true");
      }
    });
  });

  // Close when clicking a non-checkable item, clicking outside, or Escape.
  document.addEventListener("click", (ev) => {
    if (!ev.target.closest("#menubar")) closeAllMenus();
  });

  // --- Deck > Sort items ---
  menubar.querySelectorAll('[data-sort]').forEach((btn) => {
    btn.addEventListener("click", () => {
      deckSort = btn.dataset.sort;
      syncMenuChecks();
      saveViewPrefs();
      renderDeck();
      closeAllMenus();
    });
  });

  // --- Deck > Group items ---
  menubar.querySelectorAll('[data-group]').forEach((btn) => {
    btn.addEventListener("click", () => {
      deckGroup = btn.dataset.group;
      collapsedSections.clear();
      syncMenuChecks();
      saveViewPrefs();
      renderDeck();
      closeAllMenus();
    });
  });

  // --- View toggles ---
  menubar.querySelectorAll('[data-view]').forEach((btn) => {
    btn.addEventListener("click", () => {
      const key = btn.dataset.view;
      viewOpts[key] = !viewOpts[key];
      syncMenuChecks();
      saveViewPrefs();
      renderDeck();
      renderSideboard();
      renderConsidering();
    });
  });

  const expandAll = $("view-expand-all");
  if (expandAll) expandAll.addEventListener("click", () => { collapsedSections.clear(); renderDeck(); closeAllMenus(); });
  const collapseAll = $("view-collapse-all");
  if (collapseAll) collapseAll.addEventListener("click", () => {
    groupOrderFor(deckGroup).forEach((g) => collapsedSections.add(g));
    renderDeck();
    closeAllMenus();
  });

  // --- Search > Ignore format ---
  const ignoreItem = $("menu-ignore-format");
  const ignoreChk = $("ignore-format");
  if (ignoreItem && ignoreChk) {
    ignoreItem.addEventListener("click", () => {
      ignoreChk.checked = !ignoreChk.checked;
      ignoreChk.dispatchEvent(new Event("change"));
      syncMenuChecks();
    });
  }

  applyViewPrefs();
  syncMenuChecks();
}

// Open/close helpers.
function closeAllMenus() {
  document.querySelectorAll("#menubar .menu.open").forEach((m) => {
    m.classList.remove("open");
    const b = m.querySelector(".menu-btn");
    if (b) b.setAttribute("aria-expanded", "false");
  });
}

// Reflect the current state onto every checkable menu item.
function syncMenuChecks() {
  const set = (sel, isActive) => {
    document.querySelectorAll(sel).forEach((el) => el.classList.toggle("checked", isActive(el)));
  };
  set("#menubar [data-sort]", (el) => el.dataset.sort === deckSort);
  set("#menubar [data-group]", (el) => el.dataset.group === deckGroup);
  set("#menubar [data-view]", (el) => !!viewOpts[el.dataset.view]);
  const fmtSel = $("format-select");
  set("#menubar [data-format]", (el) => fmtSel && el.dataset.format === fmtSel.value);
  const sortSel = $("sort-select");
  set("#menubar [data-sorts]", (el) => sortSel && el.dataset.sorts === sortSel.value);
  const ignoreItem = $("menu-ignore-format");
  const ignoreChk = $("ignore-format");
  if (ignoreItem && ignoreChk) ignoreItem.classList.toggle("checked", ignoreChk.checked);

  // Mirror the layout preference onto the panel. Grid view always uses a
  // multi-column (image) layout, so it counts as "not single column".
  const panel = document.querySelector(".deck-panel");
  if (panel) {
    panel.classList.toggle("single-column", !viewOpts.twoColumn && !viewOpts.gridView);
    panel.classList.toggle("grid-view", !!viewOpts.gridView);
  }

  // Mirror the active search sort into the search panel header label.
  const label = $("search-sort-label");
  if (label && sortSel) {
    const opt = [...sortSel.options].find((o) => o.value === sortSel.value);
    label.textContent = opt ? opt.textContent : "";
  }
}

// Persist / restore deck view preferences.
function saveViewPrefs() {
  try {
    localStorage.setItem(LS_VIEW_PREFS, JSON.stringify({ deckSort, deckGroup, viewOpts }));
  } catch {}
}
function applyViewPrefs() {
  try {
    const p = JSON.parse(localStorage.getItem(LS_VIEW_PREFS) || "null");
    if (p) {
      if (p.deckSort) deckSort = p.deckSort;
      if (p.deckGroup) deckGroup = p.deckGroup;
      if (p.viewOpts) viewOpts = { ...viewOpts, ...p.viewOpts };
    }
  } catch {}
  const panel = document.querySelector(".deck-panel");
  if (panel) {
    panel.classList.toggle("single-column", !viewOpts.twoColumn && !viewOpts.gridView);
    panel.classList.toggle("grid-view", !!viewOpts.gridView);
  }
}

/* ============================================================
   WIRING
   ============================================================ */
// Restore any cached printings so the picker / bulk swap are instant.
loadPrintsCache();

setupSearchResize();
setupMenuBar();
if (searchBtn) searchBtn.addEventListener("click", () => runSearch(searchInput.value));

// Toggling "Ignore format" re-runs the current search with/without f:(format).
const ignoreFormatEl = $("ignore-format");
if (ignoreFormatEl) {
  ignoreFormatEl.addEventListener("change", () => {
    syncMenuChecks();
    if (searchInput.value.trim()) runSearch(searchInput.value);
  });
}

// Changing the format re-runs the current search with the new restrictions.
const formatSelectEl = $("format-select");
if (formatSelectEl) {
  formatSelectEl.addEventListener("change", () => {
    syncMenuChecks();
    queueAutosave();
    if (searchInput.value.trim()) runSearch(searchInput.value);
  });
}

// Changing the sort re-runs the current search.
const sortSelectEl = $("sort-select");
if (sortSelectEl) {
  sortSelectEl.addEventListener("change", () => {
    syncMenuChecks();
    if (searchInput.value.trim()) runSearch(searchInput.value);
  });
}

let inpTimer;
if (searchInput) {
  searchInput.addEventListener("input", () => {
    clearTimeout(inpTimer);
    inpTimer = setTimeout(() => runSearch(searchInput.value), 450);
  });
  searchInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") runSearch(searchInput.value);
  });
}

// The deck filter accepts full Scryfall syntax: plain text matches instantly
// (locally), query syntax is debounced and resolved against Scryfall.
if (deckFilterEl) {
  deckFilterEl.addEventListener("input", () => {
    clearTimeout(deckFilterTimer);
    deckFilterTimer = setTimeout(applyDeckFilter, 450);
  });
  deckFilterEl.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") { clearTimeout(deckFilterTimer); applyDeckFilter(); }
  });
}
if (considerFilterEl) considerFilterEl.addEventListener("input", renderConsidering);
if (sideFilterEl) sideFilterEl.addEventListener("input", renderSideboard);

// --- Collapsible / resizable board docks (Considering, Sideboard) ---
// Each dock can be expanded/collapsed and its height dragged; both the open
// state and the height are persisted in localStorage.
setupDock({
  dockEl: considerDock,
  toggleEl: considerToggle,
  bodyEl: considerBody,
  handleEl: $("consider-resize"),
  openKey: "barebones_consider_open",
  heightKey: "barebones_consider_height",
});
setupDock({
  dockEl: sideDock,
  toggleEl: sideToggle,
  bodyEl: sideBody,
  handleEl: $("side-resize"),
  openKey: "barebones_side_open",
  heightKey: "barebones_side_height",
});

// --- Drag & drop targets ---
// Drop onto the main deck list: search results, considering & sideboard cards.
if (deckListEl) setupDropTarget(deckListEl, handleDropOnDeck, ["search", "consider", "side"]);
// Drop onto the sideboard list.
if (sideboardListEl) setupDropTarget(sideboardListEl, handleDropOnSideboard, ["search", "deck", "consider"]);
// Also allow dropping on the whole deck panel body (empty area / header),
// which adds/moves the card into the main deck.
const deckPanelEl = document.querySelector(".deck-panel");
if (deckPanelEl) setupDropTarget(deckPanelEl, handleDropOnDeck, ["search", "consider", "side"]);
// Drop onto Considering: search results, deck & sideboard cards land here.
if (considerBody) setupDropTarget(considerBody, handleDropOnConsidering, ["search", "deck", "side"]);
if (considerToggle) setupDropTarget(considerToggle, handleDropOnConsidering, ["search", "deck", "side"]);
// Drop onto Search: removes the dragged deck/considering/sideboard card.
const searchPanelEl = document.querySelector(".search-panel");
if (searchPanelEl) setupDropTarget(searchPanelEl, handleDropOnSearch, ["deck", "consider", "side"]);

/* ---------------- Auth / cloud sync wiring (optional) ----------------
   The Supabase auth module is loaded as an ES module and may not be ready
   yet when this classic script runs, so we wait for either the ready event
   or (if it already fired) a poll. Everything no-ops if Supabase is off. */
let authUIInitialized = false;
function initAuthUI() {
  if (authUIInitialized) return true;
  const a = cloudAuth();
  if (!a) return false;
  authUIInitialized = true;

  // Toggle the sign-in / user chip based on auth state.
  renderAuthUI(a.getUser());
  a.onChange((user) => {
    renderAuthUI(user);
    if (user) {
      // Signed in → go to the deck library.
      renderDecksScreen();
      showScreen("decks");
    } else {
      // Signed out → back to the home screen.
      currentDeckId = null;
      setSaveStatus("offline");
      showScreen("home");
    }
  });

  // Home / decks screen buttons.
  const homeSignin = document.getElementById("home-signin");
  if (homeSignin) homeSignin.addEventListener("click", () => a.signInWithGoogle());
  const decksSignout = document.getElementById("decks-signout");
  if (decksSignout) decksSignout.addEventListener("click", () => a.signOut());
  const newDeckBtn2 = document.getElementById("new-deck-btn-2");
  if (newDeckBtn2) newDeckBtn2.addEventListener("click", createNewDeck);
  const backBtn = document.getElementById("back-to-decks");
  if (backBtn) backBtn.addEventListener("click", async () => {
    await flushAutosave();          // make sure pending edits are saved
    renderDecksScreen();
    showScreen("decks");
  });

  // If already signed in (e.g. returning from OAuth redirect), go to decks.
  if (a.getUser()) { renderDecksScreen(); showScreen("decks"); }
  else showScreen("home");
  return true;
}

if (isCloudEnabled()) {
  if (!initAuthUI()) {
    // Auth module not loaded yet — wait briefly for it.
    let tries = 0;
    const t = setInterval(() => {
      if (initAuthUI() || ++tries > 40) clearInterval(t);
    }, 100);
    window.addEventListener("barebones-auth-ready", () => {
      if (initAuthUI()) clearInterval(t);
    }, { once: true });
  }
} else {
  // No backend configured — show the home screen with a helpful note.
  const note = document.getElementById("home-note");
  if (note) note.textContent = "Cloud storage isn't configured. Fill in supabase-config.js to sign in.";
  showScreen("home");
}

// --- Card actions menu: close on outside click / Escape / scroll / resize ---
document.addEventListener("click", (ev) => {
  if (isCardMenuOpen() && !cardMenuEl.contains(ev.target)) closeCardMenu();
});
document.addEventListener("contextmenu", (ev) => {
  // Close if right-clicking outside a card row (rows call preventDefault + reopen)
  if (isCardMenuOpen() && !ev.target.closest(".deck-row")) closeCardMenu();
});
document.addEventListener("keydown", (ev) => {
  if (ev.key === "Escape") {
    if (isPrintingPickerOpen()) closePrintingPicker();
    else closeCardMenu();
    closeAllMenus();
  }
});
window.addEventListener("resize", closeCardMenu);
document.addEventListener("scroll", () => { if (isCardMenuOpen()) closeCardMenu(); }, true);

// "New deck" lives on the My Decks screen; it creates a backend row then opens it.
const newDeckBtn = $("new-deck-btn");
if (newDeckBtn) newDeckBtn.addEventListener("click", createNewDeck);

// Deck name changes autosave.
deckNameEl.addEventListener("change", () => queueAutosave());
deckNameEl.addEventListener("input", () => queueAutosave());

// Delete the current deck then return to the library.
const deleteDeckBtn = $("delete-deck");
if (deleteDeckBtn) deleteDeckBtn.addEventListener("click", async () => {
  if (!currentDeckId) return;
  if (!confirm("Delete this deck permanently?")) return;
  try {
    clearTimeout(autosaveTimer);
    await cloudAuth().deleteDeck(currentDeckId);
    currentDeckId = null;
    renderDecksScreen();
    showScreen("decks");
  } catch (err) { alert("Delete failed: " + err.message); }
});

const exportDeckBtn = $("export-deck");
if (exportDeckBtn) exportDeckBtn.addEventListener("click", async () => {
  const text = exportDecklist();
  try {
    await navigator.clipboard.writeText(text);
    alert("Decklist copied to clipboard!");
  } catch {
    prompt("Copy your decklist:", text);
  }
});

// Import modal
const modal = $("modal");
const importDeckBtn = $("import-deck");
if (importDeckBtn) {
  importDeckBtn.addEventListener("click", () => {
    if (!modal) {
      // No modal markup: fall back to a plain prompt so the button still works.
      const text = prompt("Paste a decklist (lines like \"4 Lightning Bolt\"):\n\nTip: copy your list from Moxfield/Archidekt first.");
      if (text && text.trim()) importDecklist(text);
      return;
    }
    const ta = $("modal-text");
    if (ta) ta.value = "";
    modal.classList.remove("hidden");
    if (ta) setTimeout(() => ta.focus(), 0);
  });
}
const modalCancelBtn = $("modal-cancel");
if (modalCancelBtn && modal) {
  modalCancelBtn.addEventListener("click", () => modal.classList.add("hidden"));
}

// Printing picker modal: close button + click-outside.
const printingCloseBtn = $("printing-close");
if (printingCloseBtn) printingCloseBtn.addEventListener("click", closePrintingPicker);
if (printingModal) {
  printingModal.addEventListener("click", (ev) => {
    if (ev.target === printingModal) closePrintingPicker();
  });
}

// Bulk "all cards" printing swaps (Deck menu).
const allCheapestBtn = $("menu-all-cheapest");
const allNewestBtn = $("menu-all-newest");
if (allCheapestBtn) allCheapestBtn.addEventListener("click", () => setAllPrintings("cheapest", allCheapestBtn));
if (allNewestBtn) allNewestBtn.addEventListener("click", () => setAllPrintings("newest", allNewestBtn));
const modalConfirmBtn = $("modal-confirm");
if (modalConfirmBtn && modal) {
  modalConfirmBtn.addEventListener("click", async () => {
    const text = $("modal-text").value;
    modal.classList.add("hidden");
    if (text.trim()) await importDecklist(text);
  });
}

// Close the import modal when clicking the dimmed backdrop (outside the card).
if (modal) {
  modal.addEventListener("click", (ev) => {
    if (ev.target === modal) modal.classList.add("hidden");
  });
}

// Utility
function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// Initial render — start on the home screen; auth init routes onward.
// (View prefs are applied by applyViewPrefs() during menu setup above.)

// Warm the printings cache for cards already in the deck (idle, non-blocking),
// so opening the picker or running a bulk swap is instant next time.
if ("requestIdleCallback" in window) {
  requestIdleCallback(() => prefetchDeckPrintings(), { timeout: 5000 });
} else {
  setTimeout(prefetchDeckPrintings, 1500);
}

// Flush any pending autosave before the tab closes.
window.addEventListener("beforeunload", () => {
  if (currentDeckId && isSignedIn()) { try { flushAutosave(); } catch {} }
});

/* ============================================================
   SERVER LIFECYCLE
   ------------------------------------------------------------
   A web page cannot run shell commands or kill processes (browsers
   sandbox JS). So instead, the page tells serve.py to stop: it sends
   a heartbeat while open, and a shutdown beacon when the tab closes.
   When served over file:// these calls simply fail silently.
   ============================================================ */
(function () {
  const isServed = location.protocol === "http:" || location.protocol === "https:";
  if (!isServed) return; // no server to talk to when opened as a file

  const HEARTBEAT_MS = 2000;
  let heartbeatId = null;

  function heartbeat() {
    fetch("/__heartbeat", { method: "GET", cache: "no-store" }).catch(() => {});
  }

  // Tell the server this tab is going away. A reload will immediately load the
  // page again and its first requests (heartbeat + asset GETs) cancel any
  // pending shutdown server-side, so a reload keeps the server alive.
  let toldClosed = false;
  function tellServerClosed() {
    if (toldClosed) return; // avoid double-firing (pagehide + beforeunload)
    toldClosed = true;
    if (heartbeatId) { clearInterval(heartbeatId); heartbeatId = null; }
    // sendBeacon survives the page unloading; fall back to fetch keepalive.
    try {
      if (navigator.sendBeacon) {
        navigator.sendBeacon("/__shutdown", "");
        return;
      }
    } catch {}
    try { fetch("/__shutdown", { method: "POST", keepalive: true }); } catch {}
  }

  // Start heartbeating so the server knows a tab is alive. Send the first one
  // immediately, then a couple of quick follow-ups: on a reload the old page's
  // shutdown beacon may land slightly *after* our first heartbeat, so these
  // re-affirm the tab is alive and cancel that pending shutdown.
  heartbeat();
  heartbeatId = setInterval(heartbeat, HEARTBEAT_MS);
  setTimeout(heartbeat, 300);
  setTimeout(heartbeat, 1000);

  // Fire shutdown only on a real unload. `pagehide` fires for reloads too, but
  // a reload comes back within the server's grace window and its requests
  // cancel the pending shutdown, so a reload never stops the server.
  window.addEventListener("pagehide", (ev) => {
    // `persisted` is true when entering the bfcache (not a real close).
    if (ev.persisted) return;
    tellServerClosed();
  });
  window.addEventListener("beforeunload", tellServerClosed);

  // If the page is restored from the back/forward cache, resume heartbeats.
  window.addEventListener("pageshow", () => {
    heartbeat();
    if (!heartbeatId) heartbeatId = setInterval(heartbeat, HEARTBEAT_MS);
  });
})();

