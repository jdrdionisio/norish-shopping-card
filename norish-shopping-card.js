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

const VERSION = "1.0.0";
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
};

class NorishShoppingCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._hass = null;
    this._config = { title: "Lista de compras", entities: null };
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
      { title: "Lista de compras", entities: null },
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
  /* actions                                                            */
  /* ------------------------------------------------------------------ */

  _add() {
    const text = this.$.entry.value.trim();
    if (!text || !this._selected) return;
    this.$.entry.value = "";
    this._service("todo", "add_item", {
      entity_id: this._selected,
      item: text,
    });
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
