"use strict";
(() => {
  const $ = (id) => document.getElementById(id);
  const node = (tag, text) => {
    const e = document.createElement(tag);
    if (text !== undefined) e.textContent = text;
    return e;
  };
  const svg = (tag, attrs = {}, text) => {
    const e = document.createElementNS("http://www.w3.org/2000/svg", tag);
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
    if (text !== undefined) e.textContent = text;
    return e;
  };
  let data = { tables: [], relationships: [] },
    selected = "",
    version = 0,
    refreshVersion = 0;
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
  function sidebar() {
    $("schema-tables").replaceChildren();
    const visible = data.tables.filter((t) =>
      t.name.toLowerCase().includes($("schema-search").value.toLowerCase()),
    );
    for (const t of visible) {
      const b = node("button", "▦ " + t.name);
      b.className = t.name === selected ? "active" : "";
      b.onclick = () => select(t.name);
      $("schema-tables").append(b);
    }
    if (!visible.length)
      $("schema-tables").append(node("p", "No matching tables."));
  }
  function draw() {
    const related = new Set([selected]);
    for (const r of data.relationships) {
      if (r.source === selected) related.add(r.target);
      if (r.target === selected) related.add(r.source);
    }
    const tables = data.tables.filter(
      (t) => $("schema-scope").value === "all" || related.has(t.name),
    );
    tables.sort((a, b) =>
      a.name === selected
        ? -1
        : b.name === selected
          ? 1
          : a.name.localeCompare(b.name),
    );
    const positions = new Map(),
      cols = Math.max(1, Math.min(3, tables.length));
    let y = 45;
    for (let i = 0; i < tables.length; i += cols) {
      const row = tables.slice(i, i + cols);
      for (const [j, t] of row.entries())
        positions.set(t.name, {
          x: 60 + j * 370,
          y,
          h: 58 + t.columns.length * 24,
        });
      y += Math.max(...row.map((t) => 58 + t.columns.length * 24)) + 100;
    }
    const width = Math.max(450, cols * 370 + 70),
      height = Math.max(300, y),
      zoom = Number($("schema-zoom").value),
      root = $("schema-diagram");
    root.replaceChildren();
    root.setAttribute("viewBox", `0 0 ${width} ${height}`);
    root.setAttribute("width", width * zoom);
    root.setAttribute("height", height * zoom);
    const defs = svg("defs"),
      marker = svg("marker", {
        id: "fk-arrow",
        viewBox: "0 0 10 10",
        refX: 9,
        refY: 5,
        markerWidth: 7,
        markerHeight: 7,
        orient: "auto-start-reverse",
      });
    marker.append(svg("path", { d: "M 0 0 L 10 5 L 0 10 z", fill: "#087f5b" }));
    defs.append(marker);
    root.append(defs);
    for (const r of data.relationships) {
      const a = positions.get(r.source),
        b = positions.get(r.target);
      if (!a || !b) continue;
      const x1 = a.x + 300,
        y1 = a.y + 25,
        x2 = b.x,
        y2 = b.y + 25;
      const path = svg("path", {
        d:
          r.source === r.target
            ? `M ${x1} ${y1} C ${x1 + 55} ${y1 - 70}, ${a.x - 45} ${y1 - 70}, ${a.x} ${y1}`
            : `M ${x1} ${y1} C ${x1 + 50} ${y1}, ${x2 - 50} ${y2}, ${x2} ${y2}`,
        class: "fk-line",
        "marker-end": "url(#fk-arrow)",
      });
      path.append(
        svg(
          "title",
          {},
          `${r.name}: ${r.source} (${r.columns.join(", ")}) → ${r.target} (${r.targetColumns.join(", ")})`,
        ),
      );
      root.append(path);
    }
    for (const t of tables) {
      const p = positions.get(t.name),
        g = svg("g", {
          transform: `translate(${p.x} ${p.y})`,
          class: t.name === selected ? "schema-node selected" : "schema-node",
          tabindex: 0,
          role: "button",
          "aria-label": `Inspect ${t.name}, ${t.columns.length} columns`,
        });
      g.append(
        svg("rect", { width: 300, height: p.h, rx: 9 }),
        svg(
          "text",
          { x: 14, y: 27, class: "node-title" },
          t.name.length > 31 ? t.name.slice(0, 28) + "…" : t.name,
        ),
        svg("title", {}, t.name),
      );
      t.columns.forEach((c, i) => {
        const fk = data.relationships.some(
          (r) => r.source === t.name && r.columns.includes(c.name),
        );
        const text = svg(
          "text",
          { x: 14, y: 57 + i * 24, class: c.pk ? "node-pk" : "node-column" },
          `${c.pk ? "PK " : fk ? "FK " : "   "}${c.name}`.slice(0, 35),
        );
        text.append(
          svg(
            "title",
            {},
            `${c.name}: ${c.type}${c.nullable ? " · nullable" : " · not null"}`,
          ),
        );
        g.append(text);
      });
      g.addEventListener("click", () => select(t.name));
      g.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          select(t.name);
        }
      });
      root.append(g);
    }
  }
  function relationships() {
    $("schema-relations").replaceChildren();
    const links = data.relationships.filter(
      (r) => r.source === selected || r.target === selected,
    );
    for (const r of links) {
      const card = node("div");
      card.className = "relation-card";
      card.append(
        node("strong", r.name),
        node(
          "p",
          `${r.source} (${r.columns.join(", ")}) → ${r.targetSchema}.${r.target} (${r.targetColumns.join(", ")})`,
        ),
      );
      const other = r.source === selected ? r.target : r.source,
        b = node("button", "Inspect " + other);
      b.onclick = () => select(other);
      card.append(b);
      $("schema-relations").append(card);
    }
    if (!links.length)
      $("schema-relations").append(
        node("p", "No foreign keys between accessible public tables."),
      );
  }
  async function select(name) {
    selected = name;
    const current = ++version;
    sidebar();
    draw();
    relationships();
    history.replaceState(null, "", "/schema?table=" + encodeURIComponent(name));
    $("definition-title").textContent = name;
    $("browse-table").href = "/tables/" + encodeURIComponent(name);
    $("schema-sql").textContent = "";
    $("schema-indexes").textContent = "";
    $("schema-enums").replaceChildren();
    $("definition-status").textContent = "Loading definition…";
    try {
      const d = await get(
        "/api/tables/" + encodeURIComponent(name) + "/definition",
      );
      if (current !== version) return;
      $("schema-sql").textContent = d.sql;
      $("schema-indexes").textContent =
        d.indexes.map((i) => i.definition + ";").join("\n\n") || "No indexes.";
      for (const c of d.columns.filter((c) => c.options.length))
        $("schema-enums").append(
          node("p", `${c.name}: ${c.options.join(", ")}`),
        );
      if (!$("schema-enums").hasChildNodes())
        $("schema-enums").append(node("p", "No PostgreSQL enum columns."));
      $("definition-status").textContent = "";
    } catch (e) {
      if (current === version) $("definition-status").textContent = e.message;
    }
  }
  async function refresh() {
    const request = ++refreshVersion;
    ++version;
    $("schema-status").textContent = "Loading schema…";
    $("schema-refresh").disabled = true;
    try {
      const result = await get("/api/schema");
      if (request !== refreshVersion) return;
      data = result;
      $("schema-summary").textContent =
        `${data.tables.length} tables · ${data.relationships.length} foreign keys · public schema`;
      const requested =
        selected || new URLSearchParams(location.search).get("table");
      selected = data.tables.some((t) => t.name === requested)
        ? requested
        : data.tables[0]?.name || "";
      sidebar();
      draw();
      $("schema-status").textContent = data.tables.length
        ? ""
        : "No accessible public tables.";
      if (selected) await select(selected);
      else {
        $("schema-sql").textContent = "";
        $("schema-indexes").textContent = "";
        $("schema-relations").replaceChildren();
        $("schema-enums").replaceChildren();
        $("definition-title").textContent = "Select a table";
        $("definition-status").textContent = "";
      }
    } catch (e) {
      $("schema-status").textContent = e.message;
    } finally {
      $("schema-refresh").disabled = false;
    }
  }
  $("schema-search").oninput = sidebar;
  $("schema-scope").onchange = draw;
  $("schema-zoom").onchange = draw;
  $("schema-refresh").onclick = refresh;
  refresh();
})();
