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

  const POSITIONS_KEY = "uavpms_schema_positions";
  let data = { tables: [], relationships: [] },
    selected = "",
    version = 0,
    refreshVersion = 0,
    positions = new Map(), // name -> { x, y, h }
    activeTables = [];

  function getSavedPositions() {
    try {
      return JSON.parse(localStorage.getItem(POSITIONS_KEY) || "{}");
    } catch {
      return {};
    }
  }

  function savePositions() {
    const obj = {};
    for (const [k, v] of positions.entries()) {
      obj[k] = { x: Math.round(v.x), y: Math.round(v.y) };
    }
    localStorage.setItem(POSITIONS_KEY, JSON.stringify(obj));
  }

  function clearSavedPositions() {
    localStorage.removeItem(POSITIONS_KEY);
    positions.clear();
  }

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

  function drawRelationshipLines() {
    const rootSvg = $("schema-diagram");
    if (!rootSvg) return;

    const linesMode = $("schema-lines-mode")?.value || "selected";

    // Keep defs
    const defs = rootSvg.querySelector("defs");
    rootSvg.replaceChildren();
    if (defs) rootSvg.append(defs);

    if (linesMode === "none") return;

    const CARD_WIDTH = 280;

    for (const r of data.relationships) {
      const posA = positions.get(r.source);
      const posB = positions.get(r.target);
      if (!posA || !posB) continue;

      const isConnectedToSelected = r.source === selected || r.target === selected;

      // In "selected" mode, only show lines connected to the selected table!
      if (linesMode === "selected" && !isConnectedToSelected) {
        continue;
      }

      const tSource = activeTables.find((t) => t.name === r.source);
      const tTarget = activeTables.find((t) => t.name === r.target);
      const idxA = tSource ? tSource.columns.findIndex((c) => r.columns.includes(c.name)) : 0;
      const idxB = tTarget ? tTarget.columns.findIndex((c) => r.targetColumns.includes(c.name)) : 0;

      const clampIdxA = Math.min(Math.max(0, idxA), 11);
      const clampIdxB = Math.min(Math.max(0, idxB), 11);

      const y1 = posA.y + 42 + clampIdxA * 27 + 13.5;
      const y2 = posB.y + 42 + clampIdxB * 27 + 13.5;

      let x1, x2, pathD;

      if (r.source === r.target) {
        // Self loop
        x1 = posA.x + CARD_WIDTH;
        x2 = posA.x + CARD_WIDTH;
        pathD = `M ${x1} ${y1} C ${x1 + 60} ${y1 - 35}, ${x2 + 60} ${y2 + 35}, ${x2} ${y2}`;
      } else if (posA.x + CARD_WIDTH <= posB.x + 40) {
        // Target is clearly to the right
        x1 = posA.x + CARD_WIDTH;
        x2 = posB.x;
        const dx = Math.min(100, Math.max(40, (x2 - x1) * 0.45));
        pathD = `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`;
      } else if (posB.x + CARD_WIDTH <= posA.x + 40) {
        // Target is clearly to the left
        x1 = posA.x;
        x2 = posB.x + CARD_WIDTH;
        const dx = Math.min(100, Math.max(40, (x1 - x2) * 0.45));
        pathD = `M ${x1} ${y1} C ${x1 - dx} ${y1}, ${x2 + dx} ${y2}, ${x2} ${y2}`;
      } else {
        // Horizontally overlapping (stacked or close)
        // Connect right-to-right outer curve
        x1 = posA.x + CARD_WIDTH;
        x2 = posB.x + CARD_WIDTH;
        const dx = 50;
        pathD = `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 + dx} ${y2}, ${x2} ${y2}`;
      }

      let lineClass = "fk-line";
      if (linesMode === "all" && !isConnectedToSelected) {
        lineClass += " is-subtle";
      } else if (isConnectedToSelected) {
        lineClass += " highlight";
      }

      const path = svg("path", {
        d: pathD,
        class: lineClass,
        "data-source": r.source,
        "data-target": r.target,
        "marker-end": "url(#fk-arrow)",
      });

      path.append(
        svg(
          "title",
          {},
          `${r.name}: ${r.source} (${r.columns.join(",")}) → ${r.target} (${r.targetColumns.join(",")})`,
        ),
      );

      rootSvg.append(path);
    }
  }

  function draw() {
    const related = new Set([selected]);
    for (const r of data.relationships) {
      if (r.source === selected) related.add(r.target);
      if (r.target === selected) related.add(r.source);
    }

    activeTables = data.tables.filter(
      (t) => $("schema-scope").value === "all" || related.has(t.name),
    );
    activeTables.sort((a, b) =>
      a.name === selected ? -1 : b.name === selected ? 1 : a.name.localeCompare(b.name),
    );

    const CARD_WIDTH = 280;
    const COL_PITCH = 360;
    const cols = Math.max(1, Math.min(3, activeTables.length));
    const saved = getSavedPositions();

    let autoY = 40;
    for (let i = 0; i < activeTables.length; i += cols) {
      const row = activeTables.slice(i, i + cols);
      const rowHeights = row.map(
        (t) => 44 + Math.min(t.columns.length, 12) * 27 + (t.columns.length > 12 ? 24 : 0),
      );
      const maxHeight = Math.max(...rowHeights);

      for (const [j, t] of row.entries()) {
        const h = 44 + Math.min(t.columns.length, 12) * 27 + (t.columns.length > 12 ? 24 : 0);
        if (saved[t.name]) {
          positions.set(t.name, { x: saved[t.name].x, y: saved[t.name].y, h });
        } else {
          positions.set(t.name, { x: 40 + j * COL_PITCH, y: autoY, h });
        }
      }
      autoY += maxHeight + 60;
    }

    // Compute bounds
    let maxX = 800;
    let maxY = 600;
    for (const p of positions.values()) {
      if (p.x + CARD_WIDTH + 80 > maxX) maxX = p.x + CARD_WIDTH + 80;
      if (p.y + p.h + 80 > maxY) maxY = p.y + p.h + 80;
    }

    const zoom = Number($("schema-zoom").value) || 1;
    const container = $("canvas-zoom-container");
    container.style.width = maxX + "px";
    container.style.height = maxY + "px";
    container.style.transform = `scale(${zoom})`;

    // SVG Layer setup
    const rootSvg = $("schema-diagram");
    rootSvg.replaceChildren();
    rootSvg.setAttribute("viewBox", `0 0 ${maxX} ${maxY}`);
    rootSvg.setAttribute("width", String(maxX));
    rootSvg.setAttribute("height", String(maxY));

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

    // Nodes Layer setup
    const nodesLayer = $("schema-nodes-layer");
    nodesLayer.replaceChildren();

    for (const t of activeTables) {
      const pos = positions.get(t.name);
      const isSelected = t.name === selected;
      const card = node("div");
      card.className = `schema-card ${isSelected ? "selected" : ""}`;
      card.style.left = pos.x + "px";
      card.style.top = pos.y + "px";
      card.style.width = CARD_WIDTH + "px";
      card.setAttribute("data-table", t.name);

      // Card Header (Drag handle)
      const header = node("div");
      header.className = "schema-card-header";
      header.title = "Drag to reposition table";

      const headerLeft = node("div");
      headerLeft.className = "card-header-left";
      headerLeft.append(node("span", "▦"), node("span", t.name));
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

      // Drag and Drop Logic
      header.addEventListener("mousedown", (e) => {
        if (e.target.closest("button")) return;
        e.preventDefault();
        select(t.name);

        const startX = e.clientX;
        const startY = e.clientY;
        const origPos = { x: pos.x, y: pos.y };
        const currentZoom = Number($("schema-zoom")?.value) || 1;

        card.classList.add("dragging");
        document.body.style.cursor = "grabbing";

        const onMouseMove = (ev) => {
          const dx = (ev.clientX - startX) / currentZoom;
          const dy = (ev.clientY - startY) / currentZoom;
          pos.x = Math.max(10, origPos.x + dx);
          pos.y = Math.max(10, origPos.y + dy);

          card.style.left = pos.x + "px";
          card.style.top = pos.y + "px";

          // Real-time cable redraw
          drawRelationshipLines();
        };

        const onMouseUp = () => {
          card.classList.remove("dragging");
          document.body.style.cursor = "";
          window.removeEventListener("mousemove", onMouseMove);
          window.removeEventListener("mouseup", onMouseUp);
          savePositions();
        };

        window.addEventListener("mousemove", onMouseMove);
        window.addEventListener("mouseup", onMouseUp);
      });

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

      card.onclick = (e) => {
        if (!e.target.closest("button")) {
          select(t.name);
        }
      };

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
          if (!p.getAttribute("class")?.includes("highlight-persistent")) {
            p.classList.remove("highlight");
          }
        });
      };

      nodesLayer.append(card);
    }

    drawRelationshipLines();
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

    // Update selected styles on cards
    document.querySelectorAll(".schema-card").forEach((c) => {
      c.classList.toggle("selected", c.getAttribute("data-table") === name);
    });

    drawRelationshipLines();
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
  if ($("schema-lines-mode")) $("schema-lines-mode").onchange = drawRelationshipLines;
  if ($("btn-auto-layout")) {
    $("btn-auto-layout").onclick = () => {
      clearSavedPositions();
      draw();
    };
  }
  $("schema-refresh").onclick = refresh;
  refresh();
})();
