"use strict";

(() => {
  const $ = (id) => document.getElementById(id);
  const node = (tag, text, cls) => {
    const e = document.createElement(tag);
    if (text !== undefined && text !== null) e.textContent = text;
    if (cls) e.className = cls;
    return e;
  };
  const svg = (tag, attrs = {}) => {
    const e = document.createElementNS("http://www.w3.org/2000/svg", tag);
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
    return e;
  };

  const LAYOUT_KEY = "uavpms_schema_layout_v4";
  const ZOOM_KEY = "uavpms_schema_zoom_v3";
  const CARD_W = 250;
  const GAP_X = 90; // between dependency layers
  const GAP_SUB = 36; // between wrapped columns of the same layer
  const GAP_Y = 28;
  const PAD = 40;

  const state = {
    data: { tables: [], relationships: [] },
    selected: "",
    hovered: "",
    scope: "all",
    detail: "all",
    lines: "focus", // "focus": only the selected/hovered table's links; "all": every link
    zoom: 1,
    positions: new Map(), // name -> {x, y}
    sizes: new Map(), // name -> {h, anchors: Map(column -> y), headerY}
    cards: new Map(), // name -> element
    active: [], // tables currently drawn
    extent: { w: 800, h: 600 },
    version: 0,
    refreshVersion: 0,
  };

  // ---------- helpers ----------
  const readJSON = (key, fallback) => {
    try {
      return JSON.parse(localStorage.getItem(key) || "null") ?? fallback;
    } catch {
      return fallback;
    }
  };
  const writeJSON = (key, value) => {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {}
  };

  async function get(url) {
    const r = await fetch(url);
    if (r.status === 401) {
      location.href = "/login";
      throw Error("Session expired");
    }
    const d = await r.json();
    if (!r.ok) throw Error(d.error || "Request failed");
    return d;
  }

  const TYPE_SHORT = [
    [/^character varying/, "varchar"],
    [/^character\b/, "char"],
    [/^timestamp\((\d)\) with time zone$/, "timestamptz($1)"],
    [/^timestamp with time zone$/, "timestamptz"],
    [/^timestamp without time zone$/, "timestamp"],
    [/^time with time zone$/, "timetz"],
    [/^double precision$/, "float8"],
    [/^boolean$/, "bool"],
    [/^integer$/, "int4"],
    [/^bigint$/, "int8"],
    [/^smallint$/, "int2"],
    [/^real$/, "float4"],
  ];
  const shortType = (t = "") => {
    for (const [re, rep] of TYPE_SHORT) if (re.test(t)) return t.replace(re, rep);
    return t;
  };

  const rels = () => state.data.relationships || [];
  const fkColumns = (table) =>
    new Set(rels().filter((r) => r.source === table).flatMap((r) => r.columns || []));
  const neighbours = (table) => {
    const set = new Set();
    for (const r of rels()) {
      if (r.source === table) set.add(r.target);
      if (r.target === table) set.add(r.source);
    }
    set.delete(table);
    return set;
  };

  // ---------- sidebar ----------
  function sidebar() {
    const list = $("schema-tables");
    list.replaceChildren();
    const q = ($("schema-search").value || "").toLowerCase();
    const visible = state.data.tables.filter((t) => t.name.toLowerCase().includes(q));
    $("schema-table-count").textContent = String(state.data.tables.length);
    for (const t of visible) {
      const b = node("button");
      b.type = "button";
      b.className = t.name === state.selected ? "active" : "";
      b.title = t.name;
      b.append(node("span", t.name), node("span", String(t.columns.length), "table-badge"));
      b.onclick = () => select(t.name, { center: true });
      list.append(b);
    }
    if (!visible.length) list.append(node("p", "No matching tables."));
  }

  // ---------- cards ----------
  function visibleColumns(t) {
    if (state.detail === "names") return [];
    if (state.detail === "keys") {
      const fks = fkColumns(t.name);
      return t.columns.filter((c) => c.pk || fks.has(c.name));
    }
    return t.columns;
  }

  function buildCard(t) {
    const fks = fkColumns(t.name);
    const card = node("div", null, "schema-card");
    card.dataset.table = t.name;
    card.style.width = CARD_W + "px";

    const header = node("div", null, "schema-card-header");
    header.append(node("span", t.name, "card-name"), node("span", t.columns.length + " cols", "card-count"));
    header.title = t.name + " — drag to move, double-click to open rows";
    card.append(header);

    const cols = visibleColumns(t);
    for (const c of cols) {
      const row = node("div", null, "card-col-row");
      row.dataset.column = c.name;
      if (c.pk) row.classList.add("is-pk");
      if (c.nullable && !c.pk) row.classList.add("is-null");
      const tagCell = node("span");
      if (c.pk) tagCell.append(node("span", "PK", "key-tag pk"));
      else if (fks.has(c.name)) tagCell.append(node("span", "FK", "key-tag fk"));
      row.append(tagCell, node("span", c.name, "col-name"), node("span", shortType(c.type), "col-type"));
      row.title = `${c.name} · ${c.type}${c.nullable ? " · nullable" : " · not null"}`;
      card.append(row);
    }
    const hidden = t.columns.length - cols.length;
    if (hidden > 0 && state.detail === "keys")
      card.append(node("div", `+ ${hidden} other column${hidden > 1 ? "s" : ""}`, "card-more"));

    header.addEventListener("mousedown", (e) => startDrag(e, t.name, card));
    card.addEventListener("click", () => select(t.name));
    card.addEventListener("dblclick", () => {
      location.href = "/tables/" + encodeURIComponent(t.name);
    });
    card.addEventListener("mouseenter", () => {
      state.hovered = t.name;
      highlight();
    });
    card.addEventListener("mouseleave", () => {
      state.hovered = "";
      highlight();
    });
    return card;
  }

  function measure(name, card) {
    const header = card.querySelector(".schema-card-header");
    const headerY = header.offsetTop + header.offsetHeight / 2;
    const anchors = new Map();
    for (const row of card.querySelectorAll(".card-col-row"))
      anchors.set(row.dataset.column, row.offsetTop + row.offsetHeight / 2);
    state.sizes.set(name, { h: card.offsetHeight, headerY, anchors });
  }

  // ---------- layout ----------
  // Referenced ("parent") tables sit on the left, dependants flow to the right.
  function autoLayout(tables) {
    const names = new Set(tables.map((t) => t.name));
    const out = new Map(),
      inc = new Map();
    for (const n of names) {
      out.set(n, new Set());
      inc.set(n, new Set());
    }
    for (const r of rels()) {
      if (r.source === r.target || !names.has(r.source) || !names.has(r.target)) continue;
      out.get(r.source).add(r.target);
      inc.get(r.target).add(r.source);
    }

    const depth = new Map(),
      visiting = new Set();
    const depthOf = (n) => {
      if (depth.has(n)) return depth.get(n);
      if (visiting.has(n)) return 0; // cycle
      visiting.add(n);
      let d = 0;
      for (const t of out.get(n)) d = Math.max(d, depthOf(t) + 1);
      visiting.delete(n);
      depth.set(n, d);
      return d;
    };

    const isolated = [],
      layers = [];
    for (const t of tables) {
      if (!out.get(t.name).size && !inc.get(t.name).size) {
        isolated.push(t.name);
        continue;
      }
      const d = depthOf(t.name);
      (layers[d] ||= []).push(t.name);
    }

    // Order: most-referenced first in the root layer, then barycentre sweeps
    // (down via referenced tables, up via referencing tables) to reduce line crossings.
    const order = new Map();
    const setOrder = (layer) => layer.forEach((n, i) => order.set(n, i / Math.max(1, layer.length - 1)));
    const bary = (n, neighbours) => {
      const idx = [...neighbours].map((t) => order.get(t)).filter((v) => v !== undefined);
      return idx.length ? idx.reduce((s, v) => s + v, 0) / idx.length : order.get(n) ?? 0.5;
    };
    layers.forEach((layer, li) => {
      if (!layer) return;
      if (li === 0) layer.sort((a, b) => inc.get(b).size - inc.get(a).size || a.localeCompare(b));
      else layer.sort((a, b) => bary(a, out.get(a)) - bary(b, out.get(b)) || a.localeCompare(b));
      setOrder(layer);
    });
    for (let sweep = 0; sweep < 4; sweep++) {
      for (let li = layers.length - 2; li >= 0; li--) {
        const layer = layers[li];
        if (!layer?.length) continue;
        layer.sort((a, b) => bary(a, inc.get(a)) - bary(b, inc.get(b)));
        setOrder(layer);
      }
      for (let li = 1; li < layers.length; li++) {
        const layer = layers[li];
        if (!layer?.length) continue;
        layer.sort((a, b) => bary(a, out.get(a)) - bary(b, out.get(b)));
        setOrder(layer);
      }
    }
    isolated.sort((a, b) => a.localeCompare(b));

    const heightOf = (n) => state.sizes.get(n)?.h ?? 120;
    const all = [...layers.filter(Boolean).flat(), ...isolated];
    const totalH = all.reduce((s, n) => s + heightOf(n) + GAP_Y, 0);
    const tallest = Math.max(0, ...all.map(heightOf));
    const maxColH = Math.max(tallest, Math.sqrt((totalH * (CARD_W + GAP_X)) / 1.6));

    const positions = new Map();
    let x = PAD;
    const place = (group, gapAfter) => {
      let colX = x,
        y = PAD;
      for (const n of group) {
        if (y > PAD && y + heightOf(n) > PAD + maxColH) {
          colX += CARD_W + GAP_SUB;
          y = PAD;
        }
        positions.set(n, { x: colX, y });
        y += heightOf(n) + GAP_Y;
      }
      x = colX + CARD_W + gapAfter;
    };
    for (const layer of layers) if (layer?.length) place(layer, GAP_X);
    if (isolated.length) place(isolated, GAP_X);
    return positions;
  }

  // Manual positions are remembered only for the full diagram with all columns.
  const persistLayout = () => state.scope === "all" && state.detail === "all";

  // ---------- drawing ----------
  function draw({ relayout = false } = {}) {
    const layer = $("schema-nodes-layer");
    layer.replaceChildren();
    state.cards.clear();
    state.sizes.clear();

    let tables = state.data.tables;
    if (state.scope === "related" && state.selected) {
      const keep = neighbours(state.selected);
      keep.add(state.selected);
      tables = tables.filter((t) => keep.has(t.name));
    }
    state.active = tables;

    for (const t of tables) {
      const card = buildCard(t);
      layer.append(card);
      state.cards.set(t.name, card);
      measure(t.name, card);
    }

    const auto = autoLayout(tables);
    const saved = persistLayout() && !relayout ? readJSON(LAYOUT_KEY, {}) : {};
    state.positions.clear();
    for (const t of tables) {
      const p = saved[t.name] || auto.get(t.name) || { x: PAD, y: PAD };
      state.positions.set(t.name, { x: p.x, y: p.y });
    }
    if (relayout && persistLayout()) writeJSON(LAYOUT_KEY, {});

    for (const [name, card] of state.cards) placeCard(name, card);
    updateExtent();
    drawLines();
    highlight();
  }

  function placeCard(name, card) {
    const p = state.positions.get(name);
    card.style.left = p.x + "px";
    card.style.top = p.y + "px";
  }

  function updateExtent() {
    let w = 600,
      h = 400;
    for (const [name, p] of state.positions) {
      w = Math.max(w, p.x + CARD_W + PAD + 60);
      h = Math.max(h, p.y + (state.sizes.get(name)?.h || 0) + PAD);
    }
    state.extent = { w, h };
    const stage = $("canvas-stage"),
      diagram = $("schema-diagram");
    stage.style.width = w + "px";
    stage.style.height = h + "px";
    diagram.setAttribute("width", w);
    diagram.setAttribute("height", h);
    diagram.setAttribute("viewBox", `0 0 ${w} ${h}`);
    applyZoom();
  }

  function anchorY(name, columns) {
    const size = state.sizes.get(name);
    if (!size) return 0;
    for (const c of columns || []) if (size.anchors.has(c)) return size.anchors.get(c);
    return size.headerY;
  }

  function edgeGeometry(r) {
    const a = state.positions.get(r.source),
      b = state.positions.get(r.target);
    if (!a || !b) return null;
    const y1 = a.y + anchorY(r.source, r.columns),
      y2 = b.y + anchorY(r.target, r.targetColumns);
    let x1, x2, d1, d2;
    if (r.source === r.target) {
      x1 = x2 = a.x + CARD_W;
      d1 = d2 = 1;
    } else if (Math.abs(a.x - b.x) < CARD_W * 0.6) {
      x1 = a.x + CARD_W;
      x2 = b.x + CARD_W;
      d1 = d2 = 1;
    } else if (a.x < b.x) {
      x1 = a.x + CARD_W;
      x2 = b.x;
      d1 = 1;
      d2 = -1;
    } else {
      x1 = a.x;
      x2 = b.x + CARD_W;
      d1 = -1;
      d2 = 1;
    }
    const bend =
      d1 === d2 ? 36 + Math.min(70, Math.abs(y2 - y1) * 0.15) : Math.max(40, Math.abs(x2 - x1) * 0.45);
    const tip = 7; // arrow length; the line stops at the arrow base
    const ex = x2 + d2 * tip;
    const path = `M ${x1} ${y1} C ${x1 + d1 * bend} ${y1}, ${ex + d2 * bend} ${y2}, ${ex} ${y2}`;
    const arrow = `${x2},${y2} ${ex},${y2 - 4} ${ex},${y2 + 4}`;
    return { path, arrow, x1, y1 };
  }

  function drawLines() {
    const root = $("schema-diagram");
    root.replaceChildren();
    const names = new Set(state.active.map((t) => t.name));
    for (const r of rels()) {
      if (!names.has(r.source) || !names.has(r.target)) continue;
      const g = edgeGeometry(r);
      if (!g) continue;
      const group = svg("g", { "data-source": r.source, "data-target": r.target });
      const title = svg("title");
      title.textContent = `${r.source}.${(r.columns || []).join(", ")} → ${r.target}.${(r.targetColumns || []).join(", ")}`;
      group.append(
        title,
        svg("path", { d: g.path, class: "fk-line" }),
        svg("circle", { cx: g.x1, cy: g.y1, r: 2.6, class: "fk-end" }),
        svg("polygon", { points: g.arrow, class: "fk-end" }),
      );
      root.append(group);
    }
  }

  function highlight() {
    const focus = state.hovered || state.selected;
    const focusMode = state.lines === "focus";
    const near = focus ? neighbours(focus) : new Set();
    for (const [name, card] of state.cards) {
      const related = !!focus && (name === focus || near.has(name));
      card.classList.toggle("selected", name === state.selected);
      card.classList.toggle("neighbour", !!focus && near.has(name));
      card.classList.toggle("dimmed", !!state.hovered && !related);
      card.classList.toggle("faint", focusMode && !!focus && !state.hovered && !related);
      for (const row of card.querySelectorAll(".card-col-row.linked")) row.classList.remove("linked");
    }
    for (const g of $("schema-diagram").querySelectorAll("g")) {
      const on = !!focus && (g.dataset.source === focus || g.dataset.target === focus);
      g.classList.toggle("hidden-link", focusMode && !on);
      for (const el of g.querySelectorAll(".fk-line, .fk-end")) {
        el.classList.toggle("active", on);
        el.classList.toggle("faded", !focusMode && !!focus && !on);
      }
      if (on) g.parentNode.append(g); // draw on top
    }
    if (focus) {
      for (const r of rels()) {
        if (r.source !== focus && r.target !== focus) continue;
        markRows(r.source, r.columns);
        markRows(r.target, r.targetColumns);
      }
    }
  }

  function markRows(table, columns) {
    const card = state.cards.get(table);
    if (!card) return;
    for (const c of columns || []) {
      const row = card.querySelector(`.card-col-row[data-column="${CSS.escape(c)}"]`);
      if (row) row.classList.add("linked");
    }
  }

  // ---------- interaction ----------
  function startDrag(e, name, card) {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const p = state.positions.get(name);
    const sx = e.clientX,
      sy = e.clientY,
      ox = p.x,
      oy = p.y;
    let moved = false;
    card.classList.add("dragging");
    const move = (ev) => {
      const dx = (ev.clientX - sx) / state.zoom,
        dy = (ev.clientY - sy) / state.zoom;
      if (Math.abs(dx) + Math.abs(dy) > 2) moved = true;
      p.x = Math.max(8, Math.round(ox + dx));
      p.y = Math.max(8, Math.round(oy + dy));
      placeCard(name, card);
      drawLines();
      highlight();
    };
    const up = () => {
      card.classList.remove("dragging");
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      if (!moved) return;
      updateExtent();
      if (persistLayout()) {
        const saved = readJSON(LAYOUT_KEY, {});
        for (const [n, pos] of state.positions) saved[n] = { x: pos.x, y: pos.y };
        writeJSON(LAYOUT_KEY, saved);
      }
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  }

  function applyZoom() {
    const z = state.zoom;
    $("canvas-stage").style.transform = `scale(${z})`;
    $("canvas-spacer").style.width = state.extent.w * z + "px";
    $("canvas-spacer").style.height = state.extent.h * z + "px";
    $("zoom-label").textContent = Math.round(z * 100) + "%";
  }

  function setZoom(z, focusPoint) {
    const canvas = $("schema-canvas");
    const next = Math.min(2, Math.max(0.2, Math.round(z * 100) / 100));
    const fx = focusPoint ? focusPoint.x : canvas.clientWidth / 2,
      fy = focusPoint ? focusPoint.y : canvas.clientHeight / 2;
    const cx = (canvas.scrollLeft + fx) / state.zoom,
      cy = (canvas.scrollTop + fy) / state.zoom;
    state.zoom = next;
    applyZoom();
    canvas.scrollLeft = cx * next - fx;
    canvas.scrollTop = cy * next - fy;
    writeJSON(ZOOM_KEY, next);
  }

  // floor keeps the first view readable on big schemas; the Fit button passes 0.2.
  function fit(floor = 0.2) {
    const canvas = $("schema-canvas");
    const z = Math.min(
      (canvas.clientWidth - 24) / state.extent.w,
      (canvas.clientHeight - 24) / state.extent.h,
      1,
    );
    state.zoom = Math.max(floor, Math.round(z * 100) / 100);
    applyZoom();
    canvas.scrollLeft = 0;
    canvas.scrollTop = 0;
    writeJSON(ZOOM_KEY, state.zoom);
  }

  function centerOn(name) {
    const p = state.positions.get(name),
      size = state.sizes.get(name);
    if (!p) return;
    const canvas = $("schema-canvas");
    const cx = (p.x + CARD_W / 2) * state.zoom,
      cy = (p.y + Math.min(size?.h || 0, canvas.clientHeight / state.zoom) / 2) * state.zoom;
    canvas.scrollTo({
      left: cx - canvas.clientWidth / 2,
      top: Math.max(0, cy - canvas.clientHeight / 2),
      behavior: "smooth",
    });
  }

  function setupCanvas() {
    const canvas = $("schema-canvas");
    let pan = null;
    canvas.addEventListener("mousedown", (e) => {
      if (e.button !== 0 || e.target.closest(".schema-card")) return;
      pan = { x: e.clientX, y: e.clientY, l: canvas.scrollLeft, t: canvas.scrollTop };
      canvas.classList.add("panning");
    });
    window.addEventListener("mousemove", (e) => {
      if (!pan) return;
      canvas.scrollLeft = pan.l - (e.clientX - pan.x);
      canvas.scrollTop = pan.t - (e.clientY - pan.y);
    });
    window.addEventListener("mouseup", () => {
      pan = null;
      canvas.classList.remove("panning");
    });
    canvas.addEventListener(
      "wheel",
      (e) => {
        if (!e.ctrlKey && !e.metaKey) return;
        e.preventDefault();
        const rect = canvas.getBoundingClientRect();
        setZoom(state.zoom * (e.deltaY < 0 ? 1.1 : 1 / 1.1), {
          x: e.clientX - rect.left,
          y: e.clientY - rect.top,
        });
      },
      { passive: false },
    );
  }

  // ---------- definition panel ----------
  function relationshipsPanel() {
    const box = $("schema-relations");
    box.replaceChildren();
    const name = state.selected;
    const outgoing = rels().filter((r) => r.source === name);
    const incoming = rels().filter((r) => r.target === name && r.source !== name);
    const group = (title, items, other, describe) => {
      if (!items.length) return;
      const g = node("div", null, "rel-group");
      g.append(node("p", title));
      for (const r of items) {
        const b = node("button", null, "rel-item");
        b.type = "button";
        b.append(node("strong", other(r)), node("code", describe(r)));
        b.title = r.name || "";
        b.onclick = () => select(other(r), { center: true });
        g.append(b);
      }
      box.append(g);
    };
    group(
      "References",
      outgoing,
      (r) => r.target,
      (r) => `${(r.columns || []).join(", ")} → ${(r.targetColumns || []).join(", ")}`,
    );
    group(
      "Referenced by",
      incoming,
      (r) => r.source,
      (r) => `${(r.columns || []).join(", ")} → ${(r.targetColumns || []).join(", ")}`,
    );
    if (!outgoing.length && !incoming.length)
      box.append(node("p", "No foreign keys to or from this table.", "empty-note"));
  }

  function columnsPanel(columns) {
    const box = $("schema-columns");
    box.replaceChildren();
    if (!columns?.length) return;
    const table = node("table"),
      head = node("tr");
    for (const h of ["Column", "Type", "Null", "Default"]) head.append(node("th", h));
    const thead = node("thead");
    thead.append(head);
    const body = node("tbody");
    for (const c of columns) {
      const tr = node("tr"),
        nameCell = node("td");
      if (c.pk) nameCell.append(node("span", "PK", "key-tag pk"));
      else if (c.fk) nameCell.append(node("span", "FK", "key-tag fk"));
      nameCell.append(document.createTextNode(c.name));
      nameCell.title = c.fk ? `${c.name} → ${c.fk.table}.${c.fk.target}` : c.name;
      const def = node("td", c.identity ? "identity" : c.default ?? "");
      def.title = c.default ?? "";
      if (!c.default && !c.identity) def.className = "null";
      tr.append(nameCell, node("td", shortType(c.description)), node("td", c.nullable ? "yes" : "no"), def);
      body.append(tr);
    }
    table.append(thead, body);
    box.append(table);
  }

  function enumsPanel(columns) {
    const box = $("schema-enums");
    box.replaceChildren();
    const withValues = (columns || []).filter((c) => c.options?.length);
    for (const c of withValues) {
      const row = node("div", null, "enum-row");
      row.append(node("div", `${c.name} · ${c.optionsSource === "check" ? "CHECK constraint" : "enum type"}`));
      const pills = node("div", null, "pills");
      for (const o of c.options) pills.append(node("span", o, "pill"));
      row.append(pills);
      box.append(row);
    }
    if (!withValues.length)
      box.append(
        node("p", "No enum or CHECK (… IN (…)) constraints on this table.", "empty-note"),
      );
  }

  async function select(name, { center = false } = {}) {
    if (!name) return;
    const changedScope = state.scope === "related" && name !== state.selected;
    state.selected = name;
    const current = ++state.version;
    sidebar();
    if (changedScope) draw();
    else highlight();
    if (center) centerOn(name);
    relationshipsPanel();

    history.replaceState(null, "", "/schema?table=" + encodeURIComponent(name));
    $("definition-title").textContent = name;
    $("browse-table").href = "/tables/" + encodeURIComponent(name);
    $("btn-query-table").onclick = () =>
      window.openSideSql && window.openSideSql(`SELECT * FROM "${name}" LIMIT 25;`);
    $("schema-sql").textContent = "";
    $("schema-indexes").textContent = "";
    $("definition-status").textContent = "Loading definition…";

    try {
      const d = await get("/api/tables/" + encodeURIComponent(name) + "/definition");
      if (current !== state.version) return;
      columnsPanel(d.columns);
      enumsPanel(d.columns);
      $("schema-sql").textContent = d.sql || "";
      $("schema-indexes").textContent =
        (d.indexes || []).map((i) => i.definition + ";").join("\n\n") || "No indexes.";
      $("definition-status").textContent = "";
    } catch (e) {
      if (current === state.version) $("definition-status").textContent = e.message;
    }
  }

  async function refresh() {
    const request = ++state.refreshVersion;
    $("schema-status").textContent = "Loading schema…";
    $("schema-refresh").disabled = true;
    try {
      const result = await get("/api/schema");
      if (request !== state.refreshVersion) return;
      state.data = result || { tables: [], relationships: [] };
      $("schema-summary").textContent = `${state.data.tables.length} tables · ${rels().length} foreign keys · public schema`;

      const requested = state.selected || new URLSearchParams(location.search).get("table");
      state.selected = state.data.tables.some((t) => t.name === requested)
        ? requested
        : state.data.tables[0]?.name || "";

      sidebar();
      draw();
      $("schema-status").textContent = state.data.tables.length ? "" : "No accessible public tables.";
      const savedZoom = readJSON(ZOOM_KEY, null);
      if (typeof savedZoom === "number") {
        state.zoom = savedZoom;
        applyZoom();
      } else fit(0.7);
      if (state.selected) await select(state.selected, { center: !!requested });
    } catch (e) {
      $("schema-status").textContent = e.message;
    } finally {
      $("schema-refresh").disabled = false;
    }
  }

  function segmented(attr, key) {
    for (const b of document.querySelectorAll(`[data-${attr}]`)) {
      b.onclick = () => {
        state[key] = b.dataset[attr];
        for (const o of document.querySelectorAll(`[data-${attr}]`))
          o.classList.toggle("active", o === b);
        draw();
        if (key === "scope") fit(0.7);
      };
    }
  }

  function init() {
    $("schema-search").oninput = sidebar;
    segmented("scope", "scope");
    segmented("detail", "detail");
    for (const b of document.querySelectorAll("[data-lines]")) {
      b.onclick = () => {
        state.lines = b.dataset.lines;
        for (const o of document.querySelectorAll("[data-lines]")) o.classList.toggle("active", o === b);
        highlight();
      };
    }
    $("zoom-in").onclick = () => setZoom(state.zoom * 1.15);
    $("zoom-out").onclick = () => setZoom(state.zoom / 1.15);
    $("zoom-fit").onclick = () => fit();
    $("btn-auto-layout").onclick = () => {
      draw({ relayout: true });
      fit(0.7);
    };
    $("schema-refresh").onclick = refresh;
    setupCanvas();
    refresh();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
