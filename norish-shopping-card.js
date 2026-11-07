/**
 * Norish Shopping Card
 * A Bring-like shopping list for Home Assistant, backed by the to-do entities
 * exposed by the hass-norish integration (one list per store).
 *
 * Card type: custom:norish-shopping-card
 * Repo: https://github.com/jdrdionisio/norish-shopping-card
 *
 * Data path: this card does NOT talk to the Norish API. It reads the
 * todo.norish_* entities over the websocket (todo/item/subscribe) and drives
 * them with the standard to-do services (add_item / update_item / remove_item /
 * remove_completed_items). The integration owns the API key.
 *
 * Features: add item, mark/unmark done, inline rename, delete item,
 * clear completed, live per-store item counts, store switcher.
 */

const VERSION = "1.2.0";
const PREFIX = "todo.norish_";

const L = {
  add_placeholder: "Adicionar item…",
  add_title: "Adicionar",
  show_done: "Mostrar concluídos",
  hide_done: "Ocultar concluídos",
  clear_done: "Limpar",
  empty: "Sem itens nesta lista.",
  remove: "Apagar item",
  edit_hint: "Tocar para editar",
  dup_active: "Já está na lista:",
  dup_done: "Já comprado (na lista):",
  pantry_title: "Já tens em casa:",
  pantry_store: "despensa",
  cat_loading: "A carregar o catálogo…",
  cat_error: "Não consegui carregar o catálogo de alimentos.",
  sugg_add: "Adicionar",
};

/**
 * Units and connectives stripped from the front of a name before comparing, so
 * "2 kg batatas" and "batatas" are recognised as the same thing. Norish
 * normalises units into English, so both spellings are listed.
 */
const LEAD_NOISE = new Set([
  "de", "do", "da", "dos", "das", "e",
  "g", "gr", "gramas", "kg", "kgs", "mg",
  "l", "lt", "litro", "litros", "ml", "cl", "dl",
  "un", "unds", "unid", "unidade", "unidades",
  "pc", "pcs", "piece", "pieces", "slice", "slices",
  "copo", "copos", "cup", "cups", "colher", "colheres", "spoon", "spoons",
  "lata", "latas", "can", "cans", "pacote", "pacotes", "pack", "packs",
  "caixa", "caixas", "box", "boxes", "garrafa", "garrafas", "bottle", "bottles",
  "saco", "sacos", "bag", "bags", "molho", "jar", "jars",
]);

class NorishShoppingCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._hass = null;
    this._config = { title: "Lista de compras", entities: null, warn_duplicates: true,
                     pantry_entity: null, ingredients_url: null, ingredients: null };
    this._catalogue = null;
    this._catState = "idle";
    this._byEntity = {};   // entity_id -> [ {uid, summary, status, ...} ]
    this._unsubs = {};     // entity_id -> unsubscribe fn (or null while pending)
    this._pending = {};    // entity_id -> true while the subscription is opening
    this._sig = null;      // signature of the current entity set
    this._selected = null;
    this._showDone = false;
    this._editing = null;  // uid currently being renamed
    this._built = false;
  }

  static getStubConfig() {
    return { title: "Lista de compras" };
  }

  setConfig(config) {
    if (config && config.entities && !Array.isArray(config.entities)) {
      throw new Error("norish-shopping-card: 'entities' must be a list of todo entity ids");
    }
    this._config = Object.assign(
      { title: "Lista de compras", entities: null, warn_duplicates: true,
        pantry_entity: null, ingredients_url: null, ingredients: null },
      config || {}
    );
    this._sig = null;
    if (this._built) this._renderStores();
  }

  getCardSize() {
    return 8;
  }

  set hass(hass) {
    this._hass = hass;
    if (!hass || !hass.states) return;
    const ents = this._entities();
    const sig = ents.join("|");
    if (sig !== this._sig) {
      this._sig = sig;
      this._setup(ents);
    }
  }

  disconnectedCallback() {
    this._teardown();
  }

  /* ------------------------------------------------------------------ */
  /* discovery                                                          */
  /* ------------------------------------------------------------------ */

  _entities() {
    const configured = this._config.entities;
    if (Array.isArray(configured) && configured.length) {
      return configured.filter((e) => this._hass.states[e]);
    }
    const all = Object.keys(this._hass.states).filter((e) =>
      e.startsWith(PREFIX)
    );
    all.sort((a, b) => {
      const ua = a === PREFIX + "unsorted" ? 0 : 1;
      const ub = b === PREFIX + "unsorted" ? 0 : 1;
      return ua - ub || this._name(a).localeCompare(this._name(b), "pt");
    });
    return all;
  }

  _name(eid) {
    const st = this._hass.states[eid];
    let name = (st && st.attributes && st.attributes.friendly_name) || eid;
    // "Norish Mercadona" -> "Mercadona"
    return name.replace(/^Norish\s+/i, "");
  }

  _activeCount(eid) {
    const items = this._byEntity[eid];
    if (!items) return null;
    return items.filter((i) => i.status !== "completed").length;
  }

  /* ------------------------------------------------------------------ */
  /* subscriptions                                                      */
  /* ------------------------------------------------------------------ */

  _setup(ents) {
    // Drop subscriptions for entities that vanished.
    for (const e of Object.keys(this._unsubs)) {
      if (!ents.includes(e)) {
        this._pending[e] = false;
        const fn = this._unsubs[e];
        if (typeof fn === "function") {
          try {
            fn();
          } catch (_e) {
            /* ignore */
          }
        }
        delete this._unsubs[e];
        delete this._byEntity[e];
      }
    }

    this._build();

    for (const e of ents) {
      if (this._unsubs[e] !== undefined) continue;
      this._unsubs[e] = null;
      this._pending[e] = true;
      let p;
      try {
        p = this._hass.connection.subscribeMessage(
          (msg) => {
            this._byEntity[e] = (msg && msg.items) || [];
            this._renderStores();
            this._render();
          },
          { type: "todo/item/subscribe", entity_id: e }
        );
      } catch (_e) {
        this._pending[e] = false;
        continue;
      }
      Promise.resolve(p)
        .then((unsub) => {
          if (this._pending[e]) {
            this._unsubs[e] = unsub;
          } else if (typeof unsub === "function") {
            unsub();
          }
        })
        .catch(() => {
          this._pending[e] = false;
          delete this._unsubs[e];
        });
    }

    if (!this._selected || !ents.includes(this._selected)) {
      this._selected =
        ents.find((e) => e === PREFIX + "unsorted") || ents[0] || null;
    }

    this._renderStores();
    this._render();
    this._loadCatalogue();
  }

  _teardown() {
    for (const e of Object.keys(this._unsubs)) {
      this._pending[e] = false;
      const fn = this._unsubs[e];
      if (typeof fn === "function") {
        try {
          fn();
        } catch (_e) {
          /* ignore */
        }
      }
    }
    this._unsubs = {};
  }

  /* ------------------------------------------------------------------ */
  /* DOM skeleton                                                       */
  /* ------------------------------------------------------------------ */

  _build() {
    if (this._built) return;
    this._built = true;
    const root = this.shadowRoot;
    root.innerHTML = `
      <style>
        :host { display: block; }
        .card {
          background: var(--ha-card-background, var(--card-background-color, #fff));
          color: var(--primary-text-color, #212121);
          border-radius: var(--ha-card-border-radius, 12px);
          box-shadow: var(--ha-card-box-shadow, none);
          border: var(--ha-card-border-width, 1px) solid var(--ha-card-border-color, var(--divider-color, rgba(0,0,0,.12)));
          padding: 12px 12px 8px;
          display: flex;
          flex-direction: column;
          gap: 10px;
          font-family: var(--paper-font-body1_-_font-family, inherit);
          font-size: 15px;
        }
        .head { display: flex; align-items: center; gap: 8px; }
        .title {
          flex: 1 1 auto; min-width: 0;
          font-size: 1.05rem; font-weight: 600;
          white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
        }
        .title .badge {
          font-weight: 500; font-size: .85rem;
          color: var(--secondary-text-color, #727272);
        }
        select.store {
          flex: 0 0 auto; max-width: 55%;
          background: var(--card-background-color, #fff);
          color: var(--primary-text-color, #212121);
          border: 1px solid var(--divider-color, rgba(0,0,0,.2));
          border-radius: 8px; padding: 6px 8px; font-size: .9rem;
        }
        .add { display: flex; gap: 8px; }
        .add input {
          flex: 1 1 auto; min-width: 0;
          background: var(--card-background-color, #fff);
          color: var(--primary-text-color, #212121);
          border: 1px solid var(--divider-color, rgba(0,0,0,.2));
          border-radius: 8px; padding: 10px 12px; font-size: 16px;
        }
        .add input:focus { outline: none; border-color: var(--primary-color, #03a9f4); }
        .add button {
          flex: 0 0 auto; width: 46px;
          background: var(--primary-color, #03a9f4);
          color: var(--text-primary-color, #fff);
          border: none; border-radius: 8px; font-size: 22px; line-height: 1;
          cursor: pointer;
        }
        .add button:active { filter: brightness(.9); }
        .warn {
          display: flex; flex-direction: column; gap: 4px;
          background: var(--secondary-background-color, rgba(3,169,244,.08));
          border-left: 3px solid var(--warning-color, var(--primary-color, #ffa600));
          border-radius: 8px; padding: 8px 10px; font-size: .86rem;
          color: var(--primary-text-color, #212121);
        }
        .warn.hidden { display: none; }
        .warn .wtitle {
          font-weight: 600; color: var(--warning-color, var(--secondary-text-color, #727272));
        }
        .warn .wrow { display: flex; gap: 6px; align-items: baseline; }
        .warn .wname { flex: 1 1 auto; min-width: 0; word-break: break-word; }
        .warn .wstore { flex: 0 0 auto; color: var(--secondary-text-color, #727272); font-size: .78rem; }
        .sugg {
          display: flex; flex-wrap: wrap; gap: 6px;
          padding: 2px 0;
        }
        .sugg.hidden { display: none; }
        .sugg .chip {
          background: var(--secondary-background-color, rgba(3,169,244,.10));
          color: var(--primary-text-color, #212121);
          border: 1px solid var(--divider-color, rgba(0,0,0,.12));
          border-radius: 999px; padding: 5px 11px; font-size: .87rem;
          cursor: pointer; max-width: 100%;
          overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
        }
        .sugg .chip:hover { border-color: var(--primary-color, #03a9f4); }
        .sugg .chip:active { filter: brightness(.94); }
        .sugg .chip .plus { color: var(--primary-color, #03a9f4); font-weight: 700; margin-right: 4px; }
        .sugg .note {
          font-size: .78rem; color: var(--secondary-text-color, #727272);
          flex-basis: 100%; margin-top: 2px;
        }
        .list { display: flex; flex-direction: column; }
        .row {
          display: flex; align-items: center; gap: 10px;
          padding: 9px 2px; border-top: 1px solid var(--divider-color, rgba(0,0,0,.08));
        }
        .row:first-child { border-top: none; }
        input.chk {
          flex: 0 0 auto; width: 22px; height: 22px;
          accent-color: var(--primary-color, #03a9f4); cursor: pointer;
        }
        .summary {
          flex: 1 1 auto; min-width: 0; cursor: text;
          word-break: break-word;
        }
        .row.done .summary { text-decoration: line-through; color: var(--secondary-text-color, #727272); }
        input.edit {
          flex: 1 1 auto; min-width: 0; font-size: 16px;
          background: var(--card-background-color, #fff);
          color: var(--primary-text-color, #212121);
          border: 1px solid var(--primary-color, #03a9f4);
          border-radius: 6px; padding: 6px 8px;
        }
        button.del {
          flex: 0 0 auto; background: transparent; border: none; cursor: pointer;
          color: var(--secondary-text-color, #727272); font-size: 16px;
          padding: 4px 6px; border-radius: 6px;
        }
        button.del:hover { color: var(--error-color, #db4437); background: var(--secondary-background-color, rgba(0,0,0,.05)); }
        .empty { color: var(--secondary-text-color, #727272); padding: 10px 2px; font-size: .92rem; }
        .donebar {
          display: flex; align-items: center; gap: 8px;
          border-top: 1px solid var(--divider-color, rgba(0,0,0,.08));
          padding-top: 8px; margin-top: 2px;
        }
        .donebar button {
          background: transparent; border: none; cursor: pointer;
          color: var(--primary-color, #03a9f4); font-size: .9rem;
          padding: 6px 4px; border-radius: 6px;
        }
        .donebar .spacer { flex: 1 1 auto; }
        .done.hidden { display: none; }
      </style>
      <div class="card" data-version="${VERSION}">
        <div class="head">
          <div class="title"></div>
          <select class="store"></select>
        </div>
        <div class="add">
          <input class="entry" type="text" autocomplete="off" autocorrect="off"
                 autocapitalize="sentences" enterkeyhint="done">
          <button class="addBtn" type="button" title="${L.add_title}">+</button>
        </div>
        <div class="sugg hidden"></div>
        <div class="warn hidden"></div>
        <div class="list"></div>
        <div class="donebar">
          <button class="doneToggle" type="button"></button>
          <span class="spacer"></span>
          <button class="clearDone" type="button">${L.clear_done}</button>
        </div>
        <div class="done hidden">
          <div class="doneList list"></div>
        </div>
      </div>`;

    this.$ = {
      title: root.querySelector(".title"),
      store: root.querySelector(".store"),
      entry: root.querySelector(".entry"),
      addBtn: root.querySelector(".addBtn"),
      sugg: root.querySelector(".sugg"),
      warn: root.querySelector(".warn"),
      list: root.querySelector(".list"),
      done: root.querySelector(".done"),
      doneList: root.querySelector(".doneList"),
      doneToggle: root.querySelector(".doneToggle"),
      clearDone: root.querySelector(".clearDone"),
    };

    this.$.entry.placeholder = L.add_placeholder;
    this.$.entry.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") {
        ev.preventDefault();
        this._add();
      }
    });
    this.$.addBtn.addEventListener("click", () => this._add());
    this.$.entry.addEventListener("input", () => { this._renderSugg(); this._renderWarn(); });
    this.$.entry.addEventListener("blur", () => this._renderWarn());
    this.$.sugg.addEventListener("click", (ev) => {
      const chip = ev.target.closest(".chip");
      if (!chip) return;
      this.$.entry.value = "";
      this._renderSugg();
      this._renderWarn();
      this._addItem(chip.dataset.name);
    });
    this.$.store.addEventListener("change", () => {
      this._selected = this.$.store.value;
      this._editing = null;
      this._render();
    });
    this.$.doneToggle.addEventListener("click", () => {
      this._showDone = !this._showDone;
      this._render();
    });
    this.$.clearDone.addEventListener("click", () => this._clearDone());

    // Delegated events for the two item lists.
    for (const host of [this.$.list, this.$.doneList]) {
      host.addEventListener("change", (ev) => {
        const chk = ev.target.closest("input.chk");
        if (chk) this._toggle(chk.dataset.uid, chk.checked);
      });
      host.addEventListener("click", (ev) => {
        const del = ev.target.closest("button.del");
        if (del) {
          this._remove(del.dataset.uid);
          return;
        }
        const sum = ev.target.closest(".summary");
        if (sum) this._startEdit(sum.dataset.uid);
      });
      host.addEventListener("keydown", (ev) => {
        const edit = ev.target.closest("input.edit");
        if (!edit) return;
        if (ev.key === "Enter") {
          ev.preventDefault();
          this._commitEdit(edit.dataset.uid, edit.value);
        } else if (ev.key === "Escape") {
          ev.preventDefault();
          this._editing = null;
          this._render();
        }
      });
      host.addEventListener("focusout", (ev) => {
        const edit = ev.target.closest("input.edit");
        if (edit && this._editing === edit.dataset.uid) {
          this._commitEdit(edit.dataset.uid, edit.value);
        }
      });
    }
  }

  /* ------------------------------------------------------------------ */
  /* rendering                                                          */
  /* ------------------------------------------------------------------ */

  _renderStores() {
    if (!this._built) return;
    const ents = this._entities();
    const sel = this.$.store;
    const prev = this._selected;
    sel.innerHTML = "";
    for (const e of ents) {
      const opt = document.createElement("option");
      const n = this._activeCount(e);
      opt.value = e;
      opt.textContent = n === null ? this._name(e) : `${this._name(e)} (${n})`;
      sel.appendChild(opt);
    }
    if (prev) sel.value = prev;
    sel.style.display = ents.length > 1 ? "" : "none";
  }

  _render() {
    if (!this._built) return;
    const eid = this._selected;
    const items = (eid && this._byEntity[eid]) || [];
    const active = items.filter((i) => i.status !== "completed");
    const done = items.filter((i) => i.status === "completed");

    const n = this._activeCount(eid);
    this.$.title.innerHTML = `${this._esc(this._config.title)} <span class="badge">${
      n === null ? "" : `· ${n}`
    }</span>`;

    this.$.list.innerHTML = active.length
      ? active.map((i) => this._row(i, false)).join("")
      : `<div class="empty">${L.empty}</div>`;

    const showDoneBar = done.length > 0 || this._showDone;
    this.$.done.classList.toggle("hidden", !this._showDone);
    this.$.doneToggle.style.display = showDoneBar ? "" : "none";
    this.$.clearDone.style.display = done.length ? "" : "none";
    this.$.doneToggle.textContent = `${
      this._showDone ? L.hide_done : L.show_done
    } (${done.length})`;
    this.$.doneList.innerHTML = done.map((i) => this._row(i, true)).join("");

    if (this._editing) {
      const inp = this.shadowRoot.querySelector(
        `input.edit[data-uid="${CSS.escape(this._editing)}"]`
      );
      if (inp) {
        inp.focus();
        inp.setSelectionRange(inp.value.length, inp.value.length);
      } else {
        this._editing = null;
      }
    }

    this._renderWarn();
    this._renderSugg();
  }

  _row(item, isDone) {
    const uid = this._esc(item.uid || "");
    const summary = this._esc(item.summary || "");
    const editing = this._editing === item.uid;
    const textPart = editing
      ? `<input class="edit" type="text" data-uid="${uid}" value="${summary}">`
      : `<span class="summary" data-uid="${uid}" title="${L.edit_hint}">${summary}</span>`;
    return `<div class="row${isDone ? " done" : ""}">
      <input class="chk" type="checkbox" data-uid="${uid}" ${
        isDone ? "checked" : ""
      }>
      ${textPart}
      <button class="del" type="button" data-uid="${uid}" title="${L.remove}">✕</button>
    </div>`;
  }

  _esc(s) {
    return String(s).replace(
      /[&<>"']/g,
      (c) =>
        ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
    );
  }

  /* ------------------------------------------------------------------ */
  /* duplicate detection against everything already listed              */
  /* ------------------------------------------------------------------ */

  _norm(s) {
    return String(s)
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/([0-9])([a-z])/g, "$1 $2") // "2kg" -> "2 kg", "500ml" -> "500 ml"
      .replace(/[^a-z0-9]+/g, " ")
      .trim();
  }

  /** Drop a leading quantity ("2", "2,5") and unit/connective words. */
  _core(s) {
    const toks = this._norm(s).split(" ").filter(Boolean);
    while (
      toks.length > 1 &&
      (/^\d+([.,]\d+)?$/.test(toks[0]) || LEAD_NOISE.has(toks[0]))
    ) {
      toks.shift();
    }
    return toks.join(" ");
  }

  /**
   * Every item already in any list, keyed by its comparable name. All stores on
   * purpose: an item filed under another store still means it is already on the
   * shopping list.
   */
  _dupeIndex() {
    const index = new Map();
    for (const eid of Object.keys(this._byEntity)) {
      for (const it of this._byEntity[eid] || []) {
        const key = this._core(it.summary || "");
        if (!key) continue;
        if (!index.has(key)) index.set(key, []);
        index.get(key).push({ item: it, entity: eid });
      }
    }
    return index;
  }

  /** Does a typed name match an already-listed one? Shared by list and pantry. */
  _matches(q, key) {
    if (!q || !key) return false;
    // Crude singular (PT/EN plural in -s) so "ovo" finds "Ovos" and vice versa.
    const sing = (w) => (w.length >= 4 && w.endsWith("s") ? w.slice(0, -1) : w);
    const qw = q.split(" ").map(sing);
    const kw = key.split(" ").map(sing);
    const qs = qw.join(" ");
    const ks = kw.join(" ");
    if (qs === ks || kw.includes(qs) || qw.includes(ks)) return true;
    if (qs.length >= 4 && (ks.startsWith(qs + " ") || qs.startsWith(ks + " "))) {
      return true;
    }
    const setK = new Set(kw);
    const setQ = new Set(qw);
    const subset = (a, b) => a.length > 0 && a.every((t) => t.length >= 2 && b.has(t));
    return subset(qw, setK) || subset(kw, setQ);
  }

  /** Items already listed (any store) whose name matches the typed text. */
  _findDupes(text) {
    const q = this._core(text);
    if (q.length < 3) return [];
    const out = [];
    for (const [key, hits] of this._dupeIndex()) {
      if (this._matches(q, key)) out.push(...hits);
    }
    return out;
  }

  /**
   * Names from the optional pantry sensor (`pantry_entity`). Accepts either a
   * list of strings or the Norish shape ({name, localeNames}); the Portuguese
   * translation is matched too, because pantry names are stored in English.
   */
  _pantryNames() {
    const eid = this._config.pantry_entity;
    if (!eid || !this._hass || !this._hass.states[eid]) return [];
    const attrs = this._hass.states[eid].attributes || {};
    const raw = attrs.items || attrs.pantry || attrs.ingredients;
    if (!Array.isArray(raw)) return [];
    const out = [];
    for (const it of raw) {
      if (typeof it === "string") {
        out.push({ display: it, key: this._core(it) });
        continue;
      }
      const names = [
        it.localeNames && (it.localeNames.pt || it.localeNames.pt_PT),
        it.name,
      ].filter(Boolean);
      for (const n of names) out.push({ display: n, key: this._core(n) });
    }
    return out.filter((n) => n.key);
  }

  _findPantry(text) {
    const q = this._core(text);
    if (q.length < 3) return [];
    const seen = new Set();
    const out = [];
    for (const it of this._pantryNames()) {
      if (this._matches(q, it.key) && !seen.has(it.key)) {
        seen.add(it.key);
        out.push(it);
      }
    }
    return out;
  }

  /**
   * Show what the typed text already matches. Deliberately advisory: it never
   * blocks Enter, because a second "leite" is sometimes exactly what is wanted.
   */
  _renderWarn() {
    if (!this._built) return;
    const el = this.$.warn;
    const text = this.$.entry.value;
    const off = this._config.warn_duplicates === false;
    const dupes = off ? [] : this._findDupes(text);
    const pantry = this._findPantry(text);
    if (!dupes.length && !pantry.length) {
      el.classList.add("hidden");
      el.innerHTML = "";
      return;
    }
    const row = (name, store) =>
      `<div class="wrow"><span class="wname">${this._esc(name)}</span>` +
      `<span class="wstore">${this._esc(store)}</span></div>`;
    const active = dupes.filter((h) => h.item.status !== "completed");
    const done = dupes.filter((h) => h.item.status === "completed");
    el.innerHTML =
      (active.length
        ? `<div class="wtitle">${L.dup_active}</div>` +
          active.map((h) => row(h.item.summary || "", this._name(h.entity))).join("")
        : "") +
      (done.length
        ? `<div class="wtitle">${L.dup_done}</div>` +
          done.map((h) => row(h.item.summary || "", this._name(h.entity))).join("")
        : "") +
      (pantry.length
        ? `<div class="wtitle">${L.pantry_title}</div>` +
          pantry.map((p) => row(p.display, L.pantry_store)).join("")
        : "");
    el.classList.remove("hidden");
  }

  /* ------------------------------------------------------------------ */
  /* catálogo de alimentos (sugestões de escrita)                       */
  /* ------------------------------------------------------------------ */

  /**
   * Aceita as formas prováveis do ficheiro: lista de nomes, lista de objetos
   * ({name, localeNames, aliases}), {items:[…]}, ou a resposta crua do tRPC.
   * Devolve sempre [{display, norm}] — normalizado uma só vez, porque isto
   * pode ter dezenas de milhar de entradas.
   */
  _normaliseCatalogue(raw) {
    let list = raw;
    if (list && !Array.isArray(list)) {
      // {ingredients:[…]} é o formato do export do Norish; {items:[…]} o do tRPC
      if (Array.isArray(list.ingredients)) list = list.ingredients;
      else if (Array.isArray(list.items)) list = list.items;
    }
    if (Array.isArray(list) && list[0] && list[0].result) {
      const inner = list[0].result && list[0].result.data && list[0].result.data.json;
      list = Array.isArray(inner) ? inner : inner && inner.items;
    }
    if (!Array.isArray(list)) return [];

    const out = [];
    const seen = new Set();
    const push = (text) => {
      if (typeof text !== "string") return;
      const display = text.trim();
      const norm = this._core(display);
      if (!norm || seen.has(norm)) return;
      seen.add(norm);
      out.push({ display, norm });
    };

    for (const it of list) {
      if (typeof it === "string") {
        push(it);
        continue;
      }
      if (!it || typeof it !== "object") continue;
      const loc = it.localeNames || {};
      push(loc.pt || loc.pt_PT);
      push(it.pt);
      push(it.name);
      if (Array.isArray(it.aliases)) {
        for (const a of it.aliases) {
          if (!a || typeof a !== "object") continue;
          const l = a.locale;
          if (!l || l === "pt" || l === "pt-PT" || l === "pt-BR" || l === "en") push(a.text);
        }
      }
    }
    return out;
  }

  async _loadCatalogue() {
    if (this._catState === "loading" || this._catState === "ready") return;

    // lista pequena escrita no próprio YAML
    if (Array.isArray(this._config.ingredients) && this._config.ingredients.length) {
      this._catalogue = this._normaliseCatalogue(this._config.ingredients);
      this._catState = "ready";
      this._renderSugg();
      return;
    }

    const url = this._config.ingredients_url;
    if (!url) return;

    this._catState = "loading";
    this._renderSugg();
    try {
      // cache por omissão: o HA responde 304 quando o ficheiro não mudou, e o
      // catálogo muda raramente. Trocar o ficheiro -> recarregar com Ctrl+Shift+R.
      const r = await fetch(url);
      if (!r.ok) throw new Error("HTTP " + r.status);
      const list = this._normaliseCatalogue(await r.json());
      if (!list.length) throw new Error("sem entradas reconhecíveis");
      this._catalogue = list;
      this._catState = "ready";
      console.info(`norish-shopping-card: catálogo com ${list.length} alimentos`);
    } catch (err) {
      this._catState = "error";
      console.warn("norish-shopping-card: falhou o catálogo:", err);
    }
    this._renderSugg();
  }

  /** As melhores correspondências para o texto escrito, já sem o que está na lista. */
  _suggest(text) {
    const cat = this._catalogue;
    if (!cat || !cat.length) return [];
    const q = this._core(text);
    if (q.length < 2) return [];

    const onList = new Set(this._dupeIndex().keys());
    const strong = [];
    const weak = [];
    for (const e of cat) {
      if (onList.has(e.norm)) continue;
      let score;
      if (e.norm === q) score = 0;
      else if (e.norm.startsWith(q + " ")) score = 1;
      else if (e.norm.startsWith(q)) score = 2;
      else if (e.norm.split(" ").some((w) => w.startsWith(q))) score = 3;
      else if (q.length >= 3 && e.norm.includes(q)) score = 4;
      else continue;
      if (score <= 2) strong.push({ e, score });
      else if (weak.length < 60) weak.push({ e, score });
    }
    const all = strong.concat(weak);
    all.sort(
      (a, b) =>
        a.score - b.score ||
        a.e.norm.length - b.e.norm.length ||
        a.e.norm.localeCompare(b.e.norm, "pt")
    );
    return all.slice(0, 8).map((x) => x.e);
  }

  _renderSugg() {
    if (!this._built) return;
    const el = this.$.sugg;

    if (this._catState === "loading") {
      el.innerHTML = `<span class="note">${L.cat_loading}</span>`;
      el.classList.remove("hidden");
      return;
    }
    if (this._catState === "error" && this._config.ingredients_url) {
      el.innerHTML = `<span class="note">${L.cat_error}</span>`;
      el.classList.remove("hidden");
      return;
    }

    const items = this._suggest(this.$.entry.value);
    if (!items.length) {
      el.classList.add("hidden");
      el.innerHTML = "";
      return;
    }
    el.innerHTML = items
      .map(
        (e) =>
          `<button type="button" class="chip" data-name="${this._esc(e.display)}" ` +
          `title="${L.sugg_add}: ${this._esc(e.display)}"><span class="plus">+</span>${this._esc(
            e.display
          )}</button>`
      )
      .join("");
    el.classList.remove("hidden");
  }

  /* ------------------------------------------------------------------ */
  /* actions                                                            */
  /* ------------------------------------------------------------------ */

  _addItem(text) {
    const t = (text || "").trim();
    if (!t || !this._selected) return;
    this._service("todo", "add_item", {
      entity_id: this._selected,
      item: t,
    });
  }

  _add() {
    const text = this.$.entry.value.trim();
    if (!text || !this._selected) return;
    this.$.entry.value = "";
    this._renderSugg();
    this._renderWarn();
    this._addItem(text);
  }

  _toggle(uid, checked) {
    if (!uid) return;
    this._service("todo", "update_item", {
      entity_id: this._selected,
      item: uid,
      status: checked ? "completed" : "needs_action",
    });
  }

  _remove(uid) {
    if (!uid) return;
    if (this._editing === uid) this._editing = null;
    this._service("todo", "remove_item", {
      entity_id: this._selected,
      item: uid,
    });
  }

  _clearDone() {
    if (!this._selected) return;
    this._service("todo", "remove_completed_items", {
      entity_id: this._selected,
    });
  }

  _startEdit(uid) {
    if (!uid) return;
    this._editing = uid;
    this._render();
  }

  _commitEdit(uid, value) {
    if (this._editing !== uid) return;
    const text = (value || "").trim();
    const items = this._byEntity[this._selected] || [];
    const cur = items.find((i) => i.uid === uid);
    this._editing = null;
    if (text && cur && text !== cur.summary) {
      this._service("todo", "update_item", {
        entity_id: this._selected,
        item: uid,
        rename: text,
      });
    } else {
      this._render();
    }
  }

  _service(domain, service, data) {
    const p = this._hass.callService(domain, service, data);
    Promise.resolve(p)
      .then(() => this._refreshAfterMutation())
      .catch((err) => console.warn("norish-shopping-card:", service, err));
  }

  /**
   * The integration refreshes its coordinator after a mutation, but that round
   * trip can lag; re-read the lists at two points so the UI settles even if a
   * push is missed.
   */
  _refreshAfterMutation() {
    for (const delay of [500, 1600]) {
      window.setTimeout(() => {
        if (!this._hass) return;
        for (const e of this._entities()) {
          this._hass
            .callWS({ type: "todo/item/list", entity_id: e })
            .then((r) => {
              this._byEntity[e] = (r && r.items) || [];
              this._renderStores();
              this._render();
            })
            .catch(() => {});
        }
      }, delay);
    }
  }
}

if (!customElements.get("norish-shopping-card")) {
  customElements.define("norish-shopping-card", NorishShoppingCard);
}

window.customCards = window.customCards || [];
if (!window.customCards.some((c) => c.type === "norish-shopping-card")) {
  window.customCards.push({
    type: "norish-shopping-card",
    name: "Norish Shopping Card",
    description:
      "Lista de compras estilo Bring sobre as entidades to-do do Norish (adicionar, marcar, editar, apagar).",
    preview: false,
    documentationURL: "https://github.com/jdrdionisio/norish-shopping-card",
  });
}

console.info(
  `%c NORISH-SHOPPING-CARD %c v${VERSION} `,
  "color:#fff;background:#03a9f4;font-weight:700;border-radius:4px 0 0 4px",
  "color:#03a9f4;background:#e1f5fe;font-weight:700;border-radius:0 4px 4px 0"
);
