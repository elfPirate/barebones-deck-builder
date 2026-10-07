import io, sys

path = "index.html"
s = io.open(path, encoding="utf-8").read()

old_topbar = '''  <header class="topbar">
    <h1>Barebones Deck Builder</h1>
    <div class="deck-controls">
      <label class="format-select" title="Deckbuilding format \u2014 restricts searches to legal cards">
        <span>Format</span>
        <select id="format-select">
          <option value="commander" selected>Commander</option>
          <option value="brawl">Brawl</option>
          <option value="standardbrawl">Standard Brawl</option>
          <option value="oathbreaker">Oathbreaker</option>
          <option value="standard">Standard</option>
          <option value="pioneer">Pioneer</option>
          <option value="modern">Modern</option>
          <option value="legacy">Legacy</option>
          <option value="vintage">Vintage</option>
          <option value="pauper">Pauper</option>
          <option value="commander_nonpartner">Commander (non-partner)</option>
          <option value="">No format</option>
        </select>
      </label>
      <input id="deck-name" type="text" placeholder="Deck name" value="Untitled Deck" />
      <button id="save-deck" title="Save deck to browser storage">Save</button>
      <button id="load-deck" title="Load saved decks">Load</button>
      <button id="export-deck" title="Copy decklist to clipboard">Export</button>
      <button id="import-deck" title="Import a text decklist">Import</button>
      <button id="new-deck" title="Start a new deck">New</button>
    </div>
  </header>
'''

new_topbar = '''  <header class="topbar">
    <h1>Barebones Deck Builder</h1>

    <!-- Menu bar (File / Deck / View / Search) -->
    <nav class="menubar" id="menubar">
      <div class="menu" data-menu="file">
        <button class="menu-btn" aria-haspopup="true" aria-expanded="false">File</button>
        <div class="menu-dropdown" role="menu">
          <button class="menu-item" id="new-deck" role="menuitem">New deck</button>
          <button class="menu-item" id="save-deck" role="menuitem">Save</button>
          <button class="menu-item" id="load-deck" role="menuitem">Load\u2026</button>
          <div class="menu-sep"></div>
          <button class="menu-item" id="import-deck" role="menuitem">Import\u2026</button>
          <button class="menu-item" id="export-deck" role="menuitem">Export to clipboard</button>
        </div>
      </div>

      <div class="menu" data-menu="deck">
        <button class="menu-btn" aria-haspopup="true" aria-expanded="false">Deck</button>
        <div class="menu-dropdown" role="menu">
          <div class="menu-label">Sort cards by</div>
          <button class="menu-item checkable" data-sort="name" role="menuitemradio">Name</button>
          <button class="menu-item checkable" data-sort="cmc" role="menuitemradio">Mana value</button>
          <button class="menu-item checkable" data-sort="color" role="menuitemradio">Color</button>
          <button class="menu-item checkable" data-sort="type" role="menuitemradio">Type</button>
          <div class="menu-sep"></div>
          <div class="menu-label">Group by</div>
          <button class="menu-item checkable" data-group="type" role="menuitemradio">Type</button>
          <button class="menu-item checkable" data-group="cmc" role="menuitemradio">Mana value</button>
          <button class="menu-item checkable" data-group="color" role="menuitemradio">Color</button>
          <button class="menu-item checkable" data-group="none" role="menuitemradio">None (single list)</button>
          <div class="menu-sep"></div>
          <div class="menu-label">Printing</div>
          <button class="menu-item" id="menu-all-cheapest" role="menuitem">All cards \u2192 cheapest printing</button>
          <button class="menu-item" id="menu-all-newest" role="menuitem">All cards \u2192 newest printing</button>
          <div class="menu-sep"></div>
          <div class="menu-label">Format</div>
          <div id="menu-format-list"></div>
        </div>
      </div>

      <div class="menu" data-menu="view">
        <button class="menu-btn" aria-haspopup="true" aria-expanded="false">View</button>
        <div class="menu-dropdown" role="menu">
          <button class="menu-item checkable" data-view="twoColumn" role="menuitemcheckbox">Two-column cards</button>
          <button class="menu-item checkable" data-view="showPrices" role="menuitemcheckbox">Show prices</button>
          <button class="menu-item checkable" data-view="showMana" role="menuitemcheckbox">Show mana costs</button>
          <div class="menu-sep"></div>
          <button class="menu-item" id="view-expand-all" role="menuitem">Expand all sections</button>
          <button class="menu-item" id="view-collapse-all" role="menuitem">Collapse all sections</button>
        </div>
      </div>

      <div class="menu" data-menu="search">
        <button class="menu-btn" aria-haspopup="true" aria-expanded="false">Search</button>
        <div class="menu-dropdown" role="menu">
          <div class="menu-label">Sort results by</div>
          <div id="menu-sort-list"></div>
          <div class="menu-sep"></div>
          <button class="menu-item checkable" id="menu-ignore-format" role="menuitemcheckbox">Ignore format restrictions</button>
        </div>
      </div>
    </nav>

    <div class="menubar-spacer"></div>
    <input id="deck-name" type="text" placeholder="Deck name" value="Untitled Deck" />

    <!-- Hidden native controls keep existing logic working as the source of truth -->
    <select id="format-select" hidden>
      <option value="commander" selected>Commander</option>
      <option value="brawl">Brawl</option>
      <option value="standardbrawl">Standard Brawl</option>
      <option value="oathbreaker">Oathbreaker</option>
      <option value="standard">Standard</option>
      <option value="pioneer">Pioneer</option>
      <option value="modern">Modern</option>
      <option value="legacy">Legacy</option>
      <option value="vintage">Vintage</option>
      <option value="pauper">Pauper</option>
      <option value="commander_nonpartner">Commander (non-partner)</option>
      <option value="">No format</option>
    </select>
    <select id="sort-select" hidden>
      <option value="edhrec" selected>EDHREC rank</option>
      <option value="name">Name</option>
      <option value="set">Set / release date</option>
      <option value="released">Release date</option>
      <option value="rarity">Rarity</option>
      <option value="color">Color</option>
      <option value="usd">Price (USD)</option>
      <option value="tix">Price (TIX)</option>
      <option value="eur">Price (EUR)</option>
      <option value="cmc">Mana value</option>
      <option value="power">Power</option>
      <option value="toughness">Toughness</option>
      <option value="artist">Artist</option>
      <option value="review">Set review</option>
    </select>
    <input type="checkbox" id="ignore-format" hidden />
  </header>
'''

assert s.count(old_topbar) == 1, ("topbar not found exactly once", s.count(old_topbar))
s = s.replace(old_topbar, new_topbar)

# Simplify the search panel header: remove the inline sort select + ignore-format toggle
# (now in the Search menu). Keep the title.
old_search_header = '''      <div class="panel-header">
        <span class="panel-title">Search</span>
        <div class="search-header-controls">
          <label class="format-toggle" title="When on, searches ignore the selected format's legality restrictions (no f: added).">
            <input type="checkbox" id="ignore-format" />
            <span>Ignore format</span>
          </label>
          <label class="sort-select" title="Sort order for search results">
            <select id="sort-select">
              <option value="edhrec" selected>EDHREC rank</option>
              <option value="name">Name</option>
              <option value="set">Set / release date</option>
              <option value="released">Release date</option>
              <option value="rarity">Rarity</option>
              <option value="color">Color</option>
              <option value="usd">Price (USD)</option>
              <option value="tix">Price (TIX)</option>
              <option value="eur">Price (EUR)</option>
              <option value="cmc">Mana value</option>
              <option value="power">Power</option>
              <option value="toughness">Toughness</option>
              <option value="artist">Artist</option>
              <option value="review">Set review</option>
            </select>
          </label>
        </div>
      </div>
'''

new_search_header = '''      <div class="panel-header">
        <span class="panel-title">Search</span>
        <span class="panel-sub" id="search-sort-label"></span>
      </div>
'''

assert s.count(old_search_header) == 1, ("search header not found", s.count(old_search_header))
s = s.replace(old_search_header, new_search_header)

# Remove the (now-duplicated) older deck-bulk buttons in the deck panel header.
old_deck_bulk = '''        <div class="deck-bulk">
          <button id="all-cheapest" title="Replace every card in the deck, sideboard & considering with its cheapest printing">\u25bc Cheapest printing</button>
          <button id="all-newest" title="Replace every card in the deck, sideboard & considering with its most recent printing">\u2726 Newest printing</button>
        </div>
'''
if old_deck_bulk in s:
    s = s.replace(old_deck_bulk, '')

io.open(path, "w", encoding="utf-8").write(s)
print("topbar replaced OK")
print("has menubar:", 'id="menubar"' in s)
print("format-select count:", s.count('id="format-select"'))
print("sort-select count:", s.count('id="sort-select"'))
print("ignore-format count:", s.count('id="ignore-format"'))
print("all-cheapest count:", s.count('id="all-cheapest"'))
