/* ============================================================
   AUTH + CLOUD SYNC  (Supabase)
   ------------------------------------------------------------
   This file is loaded as an ES module (type="module") because
   supabase-js is distributed as an ES module. It exposes a small,
   framework-free API on `window.BarebonesAuth` so the classic
   `app.js` script can call it.

   Responsibilities:
     • Create the Supabase client (if configured).
     • Provide Google sign-in / sign-out.
     • Provide cloud deck CRUD helpers scoped to the signed-in user.
     • Emit auth-state changes so the UI can react.

   If SUPABASE_CONFIG is blank, everything degrades to a no-op and
   the app keeps working purely from localStorage.
   ============================================================ */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const cfg = window.SUPABASE_CONFIG || {};
const enabled = Boolean(cfg.enabled && cfg.url && cfg.anonKey);

let supabase = null;
let currentUser = null;

const listeners = new Set();
function emit() {
  for (const fn of listeners) {
    try { fn(currentUser); } catch (e) { console.error(e); }
  }
}

if (enabled) {
  supabase = createClient(cfg.url, cfg.anonKey, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true, // handles the OAuth redirect back
    },
  });

  // Keep `currentUser` in sync with the session.
  supabase.auth.getSession().then(({ data }) => {
    currentUser = data?.session?.user ?? null;
    emit();
  });
  supabase.auth.onAuthStateChange((_event, session) => {
    currentUser = session?.user ?? null;
    emit();
  });
}

/* ------------------------------------------------------------
   Public API exposed to app.js
   ------------------------------------------------------------ */
const api = {
  enabled,

  /** Current user (or null). */
  getUser() { return currentUser; },

  /** Subscribe to auth changes; returns an unsubscribe function. */
  onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },

  /** Start the Google OAuth flow (redirects away and back). */
  async signInWithGoogle() {
    if (!enabled) return;
    const redirectTo = window.location.origin + window.location.pathname;
    const { error } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo },
    });
    if (error) {
      console.error("Google sign-in failed:", error);
      alert("Sign-in failed: " + error.message);
    }
  },

  /** Sign out. */
  async signOut() {
    if (!enabled) return;
    await supabase.auth.signOut();
  },

  /* ---------------- Cloud deck CRUD (normalized: decks + deck_cards) ----------------
     Only Scryfall printing ids + quantities are stored — never card names,
     images, prices, etc. The caller rehydrates full card objects on load. */

  /**
   * List the signed-in user's decks, WITHOUT their card rows (cheap).
   * Returns: [{ id, name, format, commanderId, updated }]
   */
  async listDecks() {
    if (!enabled || !currentUser) return [];
    const { data, error } = await supabase
      .from("decks")
      .select("id,name,format,commander_scryfall_id,updated_at")
      .order("updated_at", { ascending: false });
    if (error) throw error;
    return (data || []).map((r) => ({
      id: r.id,
      name: r.name,
      format: r.format || "",
      commanderId: r.commander_scryfall_id || null,
      updated: r.updated_at ? Date.parse(r.updated_at) : Date.now(),
    }));
  },

  /**
   * Fetch one deck's card rows.
   * Returns this deck's { name, format, commanderId, cards:[{id,qty,board}], updated }.
   */
  async loadDeck(deckId) {
    if (!enabled || !currentUser) return null;
    const { data: deck, error: dErr } = await supabase
      .from("decks")
      .select("id,name,format,commander_scryfall_id,updated_at")
      .eq("id", deckId)
      .single();
    if (dErr) throw dErr;

    const { data: rows, error: cErr } = await supabase
      .from("deck_cards")
      .select("scryfall_id,quantity,board_type")
      .eq("deck_id", deckId);
    if (cErr) throw cErr;

    return {
      name: deck.name,
      format: deck.format || "",
      commanderId: deck.commander_scryfall_id || null,
      updated: deck.updated_at ? Date.parse(deck.updated_at) : Date.now(),
      cards: (rows || []).map((r) => ({
        id: r.scryfall_id,
        qty: r.quantity,
        board: r.board_type,
      })),
    };
  },

  /**
   * Upsert a deck by name for the signed-in user, then replace its card rows.
   * `payload` = { format, commanderId, cards:[{id,qty,board}] }
   * Returns the deck row id.
   */
  async saveDeck(name, payload) {
    if (!enabled || !currentUser) return null;
    const { format = "", commanderId = null, cards = [] } = payload || {};

    // 1) Upsert the deck row (onConflict: one deck per user+name).
    const { data: upserted, error: dErr } = await supabase
      .from("decks")
      .upsert(
        {
          user_id: currentUser.id,
          name,
          format,
          commander_scryfall_id: commanderId,
        },
        { onConflict: "user_id,name" },
      )
      .select("id")
      .single();
    if (dErr) throw dErr;
    const deckId = upserted.id;

    // 2) Replace the card rows (delete-then-insert keeps it simple and exact).
    const { error: delErr } = await supabase
      .from("deck_cards")
      .delete()
      .eq("deck_id", deckId);
    if (delErr) throw delErr;

    if (cards.length) {
      const rows = cards.map((c) => ({
        deck_id: deckId,
        scryfall_id: c.id,
        quantity: c.qty,
        board_type: c.board,
      }));
      const { error: insErr } = await supabase.from("deck_cards").insert(rows);
      if (insErr) throw insErr;
    }
    return deckId;
  },

  /** Delete a deck (and, via ON DELETE CASCADE, its card rows) by name. */
  async deleteDeck(name) {
    if (!enabled || !currentUser) return;
    const { error } = await supabase
      .from("decks")
      .delete()
      .eq("name", name);
    if (error) throw error;
  },
};

window.BarebonesAuth = api;

// Let app.js know auth has initialized (in case it loaded before us).
window.dispatchEvent(new CustomEvent("barebones-auth-ready"));
