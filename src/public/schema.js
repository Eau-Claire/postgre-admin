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

  const POSITIONS_KEY = "uavpms_schema_positions_manhattan_v1";
  const CARD_WIDTH = 250;
  const COL_PITCH = 340;
  const ROW_GAP = 36;

  let data = { tables: [], relationships: [] },
    selected = "",
    hoveredTable = "",
    version = 0,
    refreshVersion = 0,
    positions = new Map();

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
    const list = $("schema-tables");
    list.replaceChildren();
    const query = $("schema-search").value.toLowerCase();
    const visible = data.tables.filter((t) =>
      t.name.toLowerCase().includes(query),
    );
    $("schema-table-count").textContent = String(visible.length);
    for (const t of visible) {
      const b = node("button", t.name);
      b.className = t.name === selected ? "active" : "";
      b.onclick = () => select(t.name);
      list.append(b);
    }
    if (!visible.length) {
      list.append(node("p", "No matching public tables."));
    }
  }

  // Hierarchical DAG column layout (mimics Supabase clean arrangement)
  function computeHierarchicalLayout(tables) {
    const outgoing = new Map();
    const incoming = new Map();
    for (const t of tables) {
      outgoing.set(t.name, new Set());
      incoming.set(t.name, new Set());
    }

    for (const r of data.relationships) {
      if (outgoing.has(r.source) && incoming.has(r.target) && r.source !== r.target) {
        outgoing.get(r.source).add(r.target);
        incoming.get(r.target).add(r.source);
      }
    }

    // Assign layers (0 = referencing child, 1 = intermediate, 2 = referenced parent)
    const layers = new Map();
    for (const t of tables) {
      if (outgoing.get(t.name).size === 0 && incoming.get(t.name).size > 0) {
        layers.set(t.name, 2);
      } else if (outgoing.get(t.name).size > 0 && incoming.get(t.name).size > 0) {
        layers.set(t.name, 1);
      } else {
        layers.set(t.name, 0);
      }
    }

    const layerBuckets = [[], [], []];
    for (const t of tables) {
      const l = layers.get(t.name) ?? 0;
      layerBuckets[l].push(t);
    }

    // Evenly distribute if single column
    if (layerBuckets[1].length === 0 && layerBuckets[2].length === 0 && layerBuckets[0].length > 3) {
      const all = layerBuckets[0];
      layerBuckets[0] = all.slice(0, Math.ceil(all.length / 3));
      layerBuckets[1] = all.slice(Math.ceil(all.length / 3), Math.ceil((2 * all.length) / 3));
      layerBuckets[2] = all.slice(Math.ceil((2 * all.length) / 3));
    }

    let startX = 50;
    layerBuckets.forEach((bucket, colIdx) => {
      let currentY = 40;
      bucket.forEach((t) => {
        const colCount = Math.min(t.columns.length, 14);
        const cardHeight = 34 + colCount * 28 + 8;
        positions.set(t.name, {
          x: startX + colIdx * COL_PITCH,
          y: currentY,
          h: cardHeight,
        });
        currentY += cardHeight + ROW_GAP;
      });
    });
  }

  // Orthogonal stepped Manhattan path with 90° rounded corners (exact match to user image)
  function buildOrthogonalPath(x1, y1, x2, y2) {
    const r = 5; // corner radius
    const dy = y2 - y1;
    const dx = x2 - x1;

    if (Math.abs(dy) < 3) {
      return `M ${x1} ${y1} L ${x2} ${y2}`;
    }

    const midX = Math.round((x1 + x2) / 2);
    const sgnY = dy > 0 ? 1 : -1;
    const sgnX = dx > 0 ? 1 : -1;
    const c = Math.min(r, Math.abs(midX - x1) / 2, Math.abs(dy) / 2);

    return (
      `M ${x1} ${y1} ` +
      `L ${midX - sgnX * c} ${y1} ` +
      `Q ${midX} ${y1}, ${midX} ${y1 + sgnY * c} ` +
      `L ${midX} ${y2 - sgnY * c} ` +
      `Q ${midX} ${y2}, ${midX + sgnX * c} ${y2} ` +
      `L ${x2} ${y2}`
    );
  }

  function buildOuterPath(x1, y1, x2, y2, outerX) {
    const r = 5;
    const dy = y2 - y1;
    const sgnY = dy > 0 ? 1 : -1;
    return (
      `M ${x1} ${y1} ` +
      `L ${outerX - r} ${y1} ` +
      `Q ${outerX} ${y1}, ${outerX} ${y1 + sgnY * r} ` +
      `L ${outerX} ${y2 - sgnY * r} ` +
      `Q ${outerX} ${y2}, ${outerX - r} ${y2} ` +
      `L ${x2} ${y2}`
    );
  }

  function drawRelationshipLines() {
    const rootSvg = $("schema-diagram");
    if (!rootSvg) return;

    const linesMode = $("schema-lines-mode")?.value || "selected";
    const defs = rootSvg.querySelector("defs");
    rootSvg.replaceChildren();
    if (defs) rootSvg.append(defs);

    if (linesMode === "none") return;

    const activeTable = hoveredTable || selected;

    for (const r of data.relationships) {
      const posA = positions.get(r.source);
      const posB = positions.get(r.target);
      if (!posA || !posB) continue;

      const isConnected = r.source === activeTable || r.target === activeTable;

      if (linesMode === "selected" && activeTable && !isConnected) {
        continue;
      }

      const tSource = data.tables.find((t) => t.name === r.source);
      const tTarget = data.tables.find((t) => t.name === r.target);
      const idxA = tSource ? tSource.columns.findIndex((c) => r.columns.includes(c.name)) : 0;
      const idxB = tTarget ? tTarget.columns.findIndex((c) => r.targetColumns.includes(c.name)) : 0;

      const clampIdxA = Math.min(Math.max(0, idxA), 13);
      const clampIdxB = Math.min(Math.max(0, idxB), 13);

      const y1 = posA.y + 34 + clampIdxA * 28 + 14;
      const y2 = posB.y + 34 + clampIdxB * 28 + 14;

      let x1, x2, pathD;

      if (r.source === r.target) {
        // Self loop
        x1 = posA.x + CARD_WIDTH;
        x2 = posA.x + CARD_WIDTH;
        pathD = buildOuterPath(x1, y1, x2, y2, x1 + 40);
      } else if (posA.x + CARD_WIDTH <= posB.x + 20) {
        // Target is to the right
        x1 = posA.x + CARD_WIDTH;
        x2 = posB.x;
        pathD = buildOrthogonalPath(x1, y1, x2, y2);
      } else if (posB.x + CARD_WIDTH <= posA.x + 20) {
        // Target is to the left
        x1 = posA.x;
        x2 = posB.x + CARD_WIDTH;
        pathD = buildOrthogonalPath(x1, y1, x2, y2);
      } else {
        // Horizontally overlapping
        const outerX = Math.max(posA.x, posB.x) + CARD_WIDTH + 30;
        pathD = buildOuterPath(posA.x + CARD_WIDTH, y1, posB.x + CARD_WIDTH, y2, outerX);
      }

      let lineClass = "fk-line";
      if (isConnected) {
        lineClass += " highlight";
      } else if (linesMode === "all" && activeTable && !isConnected) {
        lineClass += " is-faded";
      }

      const path = svg("path", {
        d: pathD,
        class: lineClass,
        "data-source": r.source,
        "data-target": r.target,
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
  }

  function draw() {
    if (!data.tables.length) return;

    const scope = $("schema-scope")?.value || "all";
    let activeTables = data.tables;

    if (scope === "related" && selected) {
      const relatedNames = new Set([selected]);
      data.relationships.forEach((r) => {
        if (r.source === selected) relatedNames.add(r.target);
        if (r.target === selected) relatedNames.add(r.source);
      });
      activeTables = data.tables.filter((t) => relatedNames.has(t.name));
    }

    const saved = getSavedPositions();
    const hasSaved = Object.keys(saved).length > 0;

    if (!hasSaved) {
      computeHierarchicalLayout(activeTables);
    } else {
      for (const t of activeTables) {
        const colCount = Math.min(t.columns.length, 14);
        const cardHeight = 34 + colCount * 28 + 8;
        if (saved[t.name]) {
          positions.set(t.name, { x: saved[t.name].x, y: saved[t.name].y, h: cardHeight });
        } else {
          positions.set(t.name, { x: 50, y: 40, h: cardHeight });
        }
      }
    }

    // Bounds calculation
    let maxX = 850;
    let maxY = 600;
    for (const p of positions.values()) {
      if (p.x + CARD_WIDTH + 100 > maxX) maxX = p.x + CARD_WIDTH + 100;
      if (p.y + p.h + 100 > maxY) maxY = p.y + p.h + 100;
    }

    const zoom = Number($("schema-zoom")?.value) || 1;
    const container = $("canvas-zoom-container");
    container.style.width = maxX + "px";
    container.style.height = maxY + "px";
    container.style.transform = `scale(${zoom})`;

    // SVG Layer Setup
    const rootSvg = $("schema-diagram");
    rootSvg.replaceChildren();
    rootSvg.setAttribute("viewBox", `0 0 ${maxX} ${maxY}`);
    rootSvg.setAttribute("width", String(maxX));
    rootSvg.setAttribute("height", String(maxY));

    // Nodes Layer
    const nodesLayer = $("schema-nodes-layer");
    nodesLayer.replaceChildren();

    for (const t of activeTables) {
      const pos = positions.get(t.name);
      if (!pos) continue;

      const isSelected = t.name === selected;
      const card = node("div");
      card.className = `schema-card ${isSelected ? "selected" : ""}`;
      card.style.left = pos.x + "px";
      card.style.top = pos.y + "px";
      card.style.width = CARD_WIDTH + "px";
      card.setAttribute("data-table", t.name);

      // Card Header: Solid emerald green banner matching Supabase screenshot
      const header = node("div");
      header.className = "schema-card-header";

      const nameSpan = node("span", t.name);
      nameSpan.className = "card-name";
      header.append(nameSpan);

      const queryBtn = node("button", "⚡");
      queryBtn.type = "button";
      queryBtn.className = "card-query-btn";
      queryBtn.title = `Query "${t.name}" in Side SQL Console`;
      queryBtn.onclick = (e) => {
        e.stopPropagation();
        if (window.openSideSql) {
          window.openSideSql(`SELECT * FROM "${t.name}" LIMIT 25;`);
        }
      };
      header.append(queryBtn);
      card.append(header);

      // Drag and Drop
      header.addEventListener("mousedown", (e) => {
        if (e.target.closest("button")) return;
        e.preventDefault();
        select(t.name);

        const startX = e.clientX;
        const startY = e.clientY;
        const origX = pos.x;
        const origY = pos.y;
        const currentZoom = Number($("schema-zoom")?.value) || 1;

        card.classList.add("dragging");
        document.body.style.cursor = "grabbing";

        const onMouseMove = (ev) => {
          const dx = (ev.clientX - startX) / currentZoom;
          const dy = (ev.clientY - startY) / currentZoom;
          pos.x = Math.max(10, origX + dx);
          pos.y = Math.max(10, origY + dy);

          card.style.left = pos.x + "px";
          card.style.top = pos.y + "px";

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
        row.className = `card-col-row ${c.pk ? "is-pk" : ""}`;

        const nameGroup = node("div");
        nameGroup.className = "col-name-group";

        const iconsGroup = node("span");
        iconsGroup.className = "col-icons";

        if (c.pk) {
          // Key icon + non-null diamond + identity hash
          const keyIcon = node("span", "⚿");
          keyIcon.className = "icon-key";
          const notNullIcon = node("span", "◆");
          notNullIcon.className = "icon-notnull";
          const idIcon = node("span", "#");
          idIcon.className = "icon-id";
          iconsGroup.append(keyIcon, notNullIcon, idIcon);
        } else if (!c.nullable) {
          const notNullIcon = node("span", "◆");
          notNullIcon.className = "icon-notnull";
          iconsGroup.append(notNullIcon);
        } else {
          const nullIcon = node("span", "◇");
          nullIcon.className = "icon-null";
          iconsGroup.append(nullIcon);
        }

        const colName = node("span", c.name);
        colName.className = "col-name";
        nameGroup.append(iconsGroup, colName);

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

      // Hover cable highlighting & isolated focus
      card.onmouseenter = () => {
        hoveredTable = t.name;
        highlightConnections(t.name);
      };
      card.onmouseleave = () => {
        hoveredTable = "";
        highlightConnections(selected);
      };

      nodesLayer.append(card);
    }

    drawRelationshipLines();
  }

  function highlightConnections(tableName) {
    document.querySelectorAll(".schema-card").forEach((c) => {
      c.classList.remove("connected-highlight");
    });

    if (!tableName) {
      drawRelationshipLines();
      return;
    }

    const connected = new Set();
    data.relationships.forEach((r) => {
      if (r.source === tableName) connected.add(r.target);
      if (r.target === tableName) connected.add(r.source);
    });

    connected.forEach((name) => {
      const c = document.querySelector(`.schema-card[data-table="${name}"]`);
      if (c) c.classList.add("connected-highlight");
    });

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

    document.querySelectorAll(".schema-card").forEach((c) => {
      c.classList.toggle("selected", c.getAttribute("data-table") === name);
    });

    highlightConnections(name);
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

  // Setup background click-and-drag panning
  function setupCanvasPanning() {
    const canvas = $("schema-canvas");
    let isPanning = false;
    let startX = 0, startY = 0, scrollLeft = 0, scrollTop = 0;

    canvas.addEventListener("mousedown", (e) => {
      if (e.target.closest(".schema-card") || e.target.closest("button")) return;
      isPanning = true;
      startX = e.pageX - canvas.offsetLeft;
      startY = e.pageY - canvas.offsetTop;
      scrollLeft = canvas.scrollLeft;
      scrollTop = canvas.scrollTop;
    });

    canvas.addEventListener("mouseleave", () => { isPanning = false; });
    canvas.addEventListener("mouseup", () => { isPanning = false; });

    canvas.addEventListener("mousemove", (e) => {
      if (!isPanning) return;
      e.preventDefault();
      const x = e.pageX - canvas.offsetLeft;
      const y = e.pageY - canvas.offsetTop;
      canvas.scrollLeft = scrollLeft - (x - startX);
      canvas.scrollTop = scrollTop - (y - startY);
    });
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

  setupCanvasPanning();
  refresh();
})();
