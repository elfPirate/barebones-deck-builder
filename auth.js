
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
// Whether the initial session restore (incl. OAuth ?code= exchange) has
// finished. Until then, the app can't know if the user is signed in yet.
let authReady = false;

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
      flowType: "pkce",         // one-time ?code= exchange; no tokens in URL
    },
  });

  // Single source of truth for "who is signed in". We resolve it ONCE by
  // awaiting getSession() (which, on the redirect back, waits for the PKCE
  // code exchange to finish), THEN mark ready and emit. Auth-state events
  // arriving later just update the same state. This removes all dependence
  // on the INITIAL_SESSION-vs-SIGNED_IN ordering that caused the bounce.
  function adoptSession(session, source) {
    const user = session?.user ?? null;
    const changed = (user?.id ?? null) !== (currentUser?.id ?? null);
    currentUser = user;
    authReady = true;
    if (changed || source) {
      console.log("[auth-debug] adoptSession from", source, "->", user?.email ?? null);
      emit();
    }
  }

  // 1) Primary resolution: await the initialization/exchange, then adopt.
  supabase.auth.getSession().then(({ data, error }) => {
    if (error) console.warn("[auth-debug] getSession error:", error);
    adoptSession(data?.session, "getSession");
  });

  // 2) Keep in sync with later events (refresh, sign-out, second tab).
  supabase.auth.onAuthStateChange((event, session) => {
    console.log("[auth-debug] event:", event, "| session user:", session?.user?.email ?? null);
    if (event === "SIGNED_OUT") {
      currentUser = null;
      authReady = true;
      emit();
      return;
    }
    if (session?.user) adoptSession(session, "event:" + event);
  });

  // 3) Safety net: if nothing resolved after a few seconds (e.g. a failed
  //    exchange with no event), stop waiting so the UI isn't stuck.
  setTimeout(() => {
    if (authReady) return;
    console.warn("[auth-debug] safety net fired; resolving as signed-out");
    authReady = true;
    emit();
  }, 5000);
}

/** Map a `decks` DB row to the shape the app uses. */
function mapDeckRow(r) {
  return {
    id: r.id,
    name: r.name,
    format: r.format || "",
    commanderId: r.commander_scryfall_id || null,
    colorIdentity: r.color_identity || "",
    updated: r.updated_at ? Date.parse(r.updated_at) : Date.now(),
  };
}

/* ------------------------------------------------------------
   Public API exposed to app.js
   ------------------------------------------------------------ */
const api = {
  enabled,

  /** Current user (or null). */
  getUser() { return currentUser; },

  /** True once the initial session restore (incl. OAuth redirect) is done. */
  isReady() { return authReady; },

  /**
   * Subscribe to auth changes; returns an unsubscribe function.
   * subscriber (e.g. app.js loading after the OAuth code was exchanged)
   * never misses the sign-in that already happened.
   */
  onChange(fn) {
    listeners.add(fn);
    try { fn(currentUser); } catch (e) { console.error(e); }
    return () => listeners.delete(fn);
  },

  /** Start the Google OAuth flow (redirects away and back). */
  async signInWithGoogle() {
    // Build the return URL from the current page, but WITHOUT a trailing slash.
    // Supabase's Redirect-URL allow-list rejects entries ending in "/", and
    // GitHub Pages project sites live at a path like /<repo>/ — so we keep the
    // path but drop the slash to match the allow-list entry exactly.
    const redirectTo = (window.location.origin + window.location.pathname)
      .replace(/\/+$/, "");
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

  /* ---------------- Deck library (id-keyed) ---------------- */

  /**
   * List the signed-in user's decks (library summary, no card rows).
   * Returns: [{ id, name, format, commanderId, description, isPublic,
   *             colorIdentity, updated }]
   */
  async listDecks() {
    if (!enabled || !currentUser) return [];
    const { data, error } = await supabase
      .from("decks")
      .select("id,name,format,commander_scryfall_id,description,is_public,color_identity,updated_at")
      .order("updated_at", { ascending: false });
    if (error) throw error;
    return (data || []).map(mapDeckRow);
  },

  /** Create a brand-new empty deck; returns its summary row. */
  async createDeck(name = "Untitled Deck", format = "commander") {
    if (!enabled || !currentUser) return null;
    const { data, error } = await supabase
      .from("decks")
      .insert({ user_id: currentUser.id, name, format })
      .select("id,name,format,commander_scryfall_id,description,is_public,color_identity,updated_at")
      .single();
    if (error) throw error;
    return mapDeckRow(data);
  },

  /** Rename a deck by id. */
  async renameDeck(deckId, name) {
    if (!enabled || !currentUser) return;
    const { error } = await supabase.from("decks").update({ name }).eq("id", deckId);
    if (error) throw error;
  },

  /**
   * Fetch ONE deck with its full contents.
   * Returns { id, name, format, commanderId, description, isPublic,
   *           colorIdentity, updated,
   *           cards:    [{ scryfall_id, quantity, board, tags:[name] }],
   *           tags:     [{ id, name }] }
   */
  async getDeck(deckId) {
    if (!enabled || !currentUser) return null;

    const { data: deck, error: dErr } = await supabase
      .from("decks")
      .select("id,name,format,commander_scryfall_id,description,is_public,color_identity,updated_at")
      .eq("id", deckId)
      .single();
    if (dErr) throw dErr;

    // Cards + their tag ids.
    const { data: cardRows, error: cErr } = await supabase
      .from("deck_cards")
      .select("id,scryfall_id,quantity,board_type")
      .eq("deck_id", deckId);
    if (cErr) throw cErr;

    // Tag registry for this deck.
    const { data: tagRows, error: tErr } = await supabase
      .from("deck_tags")
      .select("id,name")
      .eq("deck_id", deckId);
    if (tErr) throw tErr;

    // Join rows (which card has which tag).
    const cardIds = (cardRows || []).map((c) => c.id);
    let joins = [];
    if (cardIds.length) {
      const { data: jRows, error: jErr } = await supabase
        .from("deck_card_tags")
        .select("deck_card_id,deck_tag_id")
        .in("deck_card_id", cardIds);
      if (jErr) throw jErr;
      joins = jRows || [];
    }

    const tagNameById = new Map((tagRows || []).map((t) => [t.id, t.name]));
    const tagsByCard = new Map();
    for (const j of joins) {
      const list = tagsByCard.get(j.deck_card_id) || [];
      const nm = tagNameById.get(j.deck_tag_id);
      if (nm) list.push(nm);
      tagsByCard.set(j.deck_card_id, list);
    }

    return {
      ...mapDeckRow(deck),
      tags: (tagRows || []).map((t) => ({ id: t.id, name: t.name })),
      cards: (cardRows || []).map((c) => ({
        scryfall_id: c.scryfall_id,
        quantity: c.quantity,
        board: c.board_type,
        tags: tagsByCard.get(c.id) || [],
      })),
    };
  },

  /**
   * Replace a deck's full contents (metadata + cards + tags).
   * `payload` = { name, format, commanderId, description, isPublic,
   *               colorIdentity,
   *               cards: [{ id, qty, board, tags:[names] }] }
   *
   * Strategy: update the deck row, then rewrite deck_cards + tags in one
   * transaction-like sequence. Simplified (not a real DB transaction) but
   * adequate for a single-user deck save. Returns nothing.
   */
  async saveDeck(deckId, payload) {
    if (!enabled || !currentUser) return;
    const {
      name, format = "", commanderId = null,
      description = "", isPublic = false, colorIdentity = "",
      cards = [],
    } = payload || {};

    // 1) Deck row.
    const { error: dErr } = await supabase
      .from("decks")
      .update({
        name,
        format,
        commander_scryfall_id: commanderId,
        description,
        is_public: isPublic,
        color_identity: colorIdentity,
      })
      .eq("id", deckId);
    if (dErr) throw dErr;

    // 2) Collect the distinct tag names used anywhere in this deck.
    const tagNames = new Set();
    for (const c of cards) (c.tags || []).forEach((t) => tagNames.add(t));

    // 3) Rewrite the tag registry (delete unused, upsert used), keeping ids.
    const { data: existingTags, error: etErr } = await supabase
      .from("deck_tags").select("id,name").eq("deck_id", deckId);
    if (etErr) throw etErr;
    const existingByName = new Map((existingTags || []).map((t) => [t.name, t.id]));

    // Insert any brand-new tag names.
    const toInsert = [...tagNames].filter((n) => !existingByName.has(n));
    if (toInsert.length) {
      const { data: inserted, error: insTErr } = await supabase
        .from("deck_tags")
        .insert(toInsert.map((name) => ({ deck_id: deckId, name })))
        .select("id,name");
      if (insTErr) throw insTErr;
      (inserted || []).forEach((t) => existingByName.set(t.name, t.id));
    }
    const tagIdByName = existingByName;

    // Delete tags no longer used.
    const unusedIds = (existingTags || [])
      .filter((t) => !tagNames.has(t.name))
      .map((t) => t.id);
    if (unusedIds.length) {
      const { error: delTErr } = await supabase
        .from("deck_tags").delete().in("id", unusedIds);
      if (delTErr) throw delTErr;
    }

    // 4) Rewrite the card rows (delete-then-insert), capturing new card ids.
    const { error: delCErr } = await supabase
      .from("deck_cards").delete().eq("deck_id", deckId);
    if (delCErr) throw delCErr;

    if (cards.length) {
      const { data: insertedCards, error: insCErr } = await supabase
        .from("deck_cards")
        .insert(cards.map((c) => ({
          deck_id: deckId,
          scryfall_id: c.id,
          quantity: c.qty,
          board_type: c.board,
        })))
        .select("id,scryfall_id,board_type");
      if (insCErr) throw insCErr;

      // 5) Rebuild the card↔tag joins.
      //    Match inserted rows back to payload cards by (scryfall_id, board).
      const rows = [];
      const byKey = new Map();
      for (const c of cards) {
        const key = c.id + "|" + c.board;
        if (!byKey.has(key)) byKey.set(key, c);
      }
      for (const ic of insertedCards || []) {
        const src = byKey.get(ic.scryfall_id + "|" + ic.board_type);
        if (!src || !src.tags) continue;
        for (const tname of src.tags) {
          const tid = tagIdByName.get(tname);
          if (tid) rows.push({ deck_card_id: ic.id, deck_tag_id: tid });
        }
      }
      if (rows.length) {
        const { error: jErr } = await supabase.from("deck_card_tags").insert(rows);
        if (jErr) throw jErr;
      }
    }
  },

  /** Delete a deck (and, via ON DELETE CASCADE, its cards + tags) by id. */
  async deleteDeck(deckId) {
    if (!enabled || !currentUser) return;
    const { error } = await supabase
      .from("decks")
      .delete()
      .eq("id", deckId);
    if (error) throw error;
  },
};

window.BarebonesAuth = api;

// --- TEMP DEBUG: trace the auth lifecycle on the console ---
(function debugAuth() {
  if (!enabled) return;
  const loc = window.location;
  console.log("[auth-debug] page URL:", loc.href);
  console.log("[auth-debug] has ?code=:", loc.search.includes("code="),

              "| has #access_token:", loc.hash.includes("access_token"),
              "| raw hash:", loc.hash);
  // If Supabase bounced back with an error, it puts it in the hash/query.
  const hash = new URLSearchParams(loc.hash.replace(/^#/, ""));
  const query = new URLSearchParams(loc.search);
  if (hash.get("error") || query.get("error")) {
    console.error("[auth-debug] OAUTH ERROR:",
      hash.get("error") || query.get("error"),
      "-", hash.get("error_description") || query.get("error_description"));
  }
  api.onChange((u) => {
    console.log("[auth-debug] onChange user:", u ? u.email : null, "| isReady:", api.isReady());
  });
  window.addEventListener("unhandledrejection", (e) => {
    console.warn("[auth-debug] unhandledrejection:", e.reason);
  });
})();

// If app.js loaded before us, tell it auth is available. (The "ready" event
// that means "session resolved" is dispatched separately, above, from inside
// the getSession() promise.)
window.dispatchEvent(new CustomEvent("barebones-auth-ready"));
