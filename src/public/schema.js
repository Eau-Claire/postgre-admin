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
    const query = $("schema-search").value.toLowerCase();
    const visible = data.tables.filter((t) =>
      t.name.toLowerCase().includes(query),
    );
    if ($("schema-table-count")) {
      $("schema-table-count").textContent = data.tables.length;
    }
    for (const t of visible) {
      const b = node("button", "▦ " + t.name);
      b.className = t.name === selected ? "active" : "";
      b.onclick = () => select(t.name);
      $("schema-tables").append(b);
    }
    if (!visible.length) {
      $("schema-tables").append(node("p", "No matching tables."));
    }
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
      a.name === selected ? -1 : b.name === selected ? 1 : a.name.localeCompare(b.name),
    );

    const positions = new Map();
    const CARD_WIDTH = 280;
    const COL_PITCH = 370;
    const cols = Math.max(1, Math.min(3, tables.length));

    let y = 40;
    for (let i = 0; i < tables.length; i += cols) {
      const row = tables.slice(i, i + cols);
      const rowHeights = row.map(
        (t) => 44 + Math.min(t.columns.length, 12) * 27 + (t.columns.length > 12 ? 24 : 0),
      );
      const maxHeight = Math.max(...rowHeights);

      for (const [j, t] of row.entries()) {
        positions.set(t.name, {
          x: 40 + j * COL_PITCH,
          y,
          h: 44 + Math.min(t.columns.length, 12) * 27 + (t.columns.length > 12 ? 24 : 0),
        });
      }
      y += maxHeight + 80;
    }

    const totalWidth = Math.max(750, cols * COL_PITCH + 60);
    const totalHeight = Math.max(500, y + 40);
    const zoom = Number($("schema-zoom").value) || 1;

    const container = $("canvas-zoom-container");
    container.style.width = totalWidth + "px";
    container.style.height = totalHeight + "px";
    container.style.transform = `scale(${zoom})`;

    // 1. Draw SVG Relationships Layer
    const rootSvg = $("schema-diagram");
    rootSvg.replaceChildren();
    rootSvg.setAttribute("viewBox", `0 0 ${totalWidth} ${totalHeight}`);
    rootSvg.setAttribute("width", String(totalWidth));
    rootSvg.setAttribute("height", String(totalHeight));

    const defs = svg("defs");
    const marker = svg("marker", {
      id: "fk-arrow",
      viewBox: "0 0 10 10",
      refX: 8,
      refY: 5,
      markerWidth: 7,
      markerHeight: 7,
      orient: "auto-start-reverse",
    });
    marker.append(svg("path", { d: "M 0 1.5 L 8 5 L 0 8.5 z", fill: "#059669" }));
    defs.append(marker);
    rootSvg.append(defs);

    for (const r of data.relationships) {
      const posA = positions.get(r.source);
      const posB = positions.get(r.target);
      if (!posA || !posB) continue;

      const tSource = tables.find((t) => t.name === r.source);
      const tTarget = tables.find((t) => t.name === r.target);
      const idxA = tSource ? tSource.columns.findIndex((c) => r.columns.includes(c.name)) : 0;
      const idxB = tTarget ? tTarget.columns.findIndex((c) => r.targetColumns.includes(c.name)) : 0;

      const clampIdxA = Math.min(Math.max(0, idxA), 11);
      const clampIdxB = Math.min(Math.max(0, idxB), 11);

      const y1 = posA.y + 42 + clampIdxA * 27 + 13.5;
      const y2 = posB.y + 42 + clampIdxB * 27 + 13.5;

      let x1, x2, pathD;
      if (r.source === r.target) {
        x1 = posA.x + CARD_WIDTH;
        x2 = posA.x + CARD_WIDTH;
        pathD = `M ${x1} ${y1} C ${x1 + 65} ${y1 - 35}, ${x2 + 65} ${y2 + 35}, ${x2} ${y2}`;
      } else if (posA.x <= posB.x) {
        x1 = posA.x + CARD_WIDTH;
        x2 = posB.x;
        const dx = Math.max(45, Math.abs(x2 - x1) * 0.45);
        pathD = `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`;
      } else {
        x1 = posA.x;
        x2 = posB.x + CARD_WIDTH;
        const dx = Math.max(45, Math.abs(x2 - x1) * 0.45);
        pathD = `M ${x1} ${y1} C ${x1 - dx} ${y1}, ${x2 + dx} ${y2}, ${x2} ${y2}`;
      }

      const path = svg("path", {
        d: pathD,
        class: "fk-line",
        "data-source": r.source,
        "data-target": r.target,
        "marker-end": "url(#fk-arrow)",
      });
      path.append(
        svg(
          "title",
          {},
          `${r.name}: ${r.source}(${r.columns.join(",")}) → ${r.target}(${r.targetColumns.join(",")})`,
        ),
      );
      rootSvg.append(path);
    }

    // 2. Draw HTML Table Cards Layer
    const nodesLayer = $("schema-nodes-layer");
    nodesLayer.replaceChildren();

    for (const t of tables) {
      const pos = positions.get(t.name);
      const isSelected = t.name === selected;
      const card = node("div");
      card.className = `schema-card ${isSelected ? "selected" : ""}`;
      card.style.left = pos.x + "px";
      card.style.top = pos.y + "px";
      card.style.width = CARD_WIDTH + "px";
      card.setAttribute("data-table", t.name);

      // Card Header
      const header = node("div");
      header.className = "schema-card-header";

      const headerLeft = node("div");
      headerLeft.className = "card-header-left";
      headerLeft.append(
        node("span", "▦"),
        node("span", t.name)
      );
      headerLeft.querySelector("span:first-child").className = "card-icon";
      headerLeft.querySelector("span:last-child").className = "card-name";

      const headerRight = node("div");
      headerRight.className = "card-header-right";

      const badge = node("span", String(t.columns.length) + " cols");
      badge.className = "card-col-count";

      const queryBtn = node("button", "⚡");
      queryBtn.type = "button";
      queryBtn.className = "card-query-btn";
      queryBtn.title = `Query "${t.name}" in SQL Console`;
      queryBtn.onclick = (e) => {
        e.stopPropagation();
        if (window.openSideSql) {
          window.openSideSql(`SELECT * FROM "${t.name}" LIMIT 25;`);
        }
      };

      headerRight.append(badge, queryBtn);
      header.append(headerLeft, headerRight);
      card.append(header);

      // Columns list
      const colContainer = node("div");
      colContainer.className = "schema-card-columns";

      t.columns.forEach((c) => {
        const isFk = data.relationships.some(
          (r) => r.source === t.name && r.columns.includes(c.name),
        );
        const row = node("div");
        row.className = `card-col-row ${c.pk ? "is-pk" : ""} ${isFk ? "is-fk" : ""}`;
        row.title = `${c.name}: ${c.type}${c.nullable ? " (nullable)" : " (NOT NULL)"}`;

        const nameGroup = node("div");
        nameGroup.className = "col-name-group";

        if (c.pk) {
          const pkBadge = node("span", "PK");
          pkBadge.className = "pk-badge";
          nameGroup.append(pkBadge);
        } else if (isFk) {
          const fkBadge = node("span", "FK");
          fkBadge.className = "fk-badge";
          nameGroup.append(fkBadge);
        } else {
          const dot = node("span", "•");
          dot.className = "dot-badge";
          nameGroup.append(dot);
        }

        const nameSpan = node("span", c.name);
        nameSpan.className = "col-name";
        nameGroup.append(nameSpan);

        const typeSpan = node("span", c.type);
        typeSpan.className = "col-type-pill";

        row.append(nameGroup, typeSpan);
        colContainer.append(row);
      });

      card.append(colContainer);

      // Card Events
      card.onclick = () => select(t.name);
      card.ondblclick = () => {
        location.href = "/tables/" + encodeURIComponent(t.name);
      };

      // Hover cable highlighting
      card.onmouseenter = () => {
        rootSvg.querySelectorAll(`path[data-source="${t.name}"], path[data-target="${t.name}"]`).forEach((p) => {
          p.classList.add("highlight");
        });
      };
      card.onmouseleave = () => {
        rootSvg.querySelectorAll(".fk-line.highlight").forEach((p) => {
          p.classList.remove("highlight");
        });
      };

      nodesLayer.append(card);
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
      b.type = "button";
      b.className = "btn-xs";
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

    const queryTableBtn = $("btn-query-table");
    if (queryTableBtn) {
      queryTableBtn.onclick = () => {
        if (window.openSideSql) {
          window.openSideSql(`SELECT * FROM "${name}" LIMIT 25;`);
        }
      };
    }

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
