"use strict";

(() => {
  const $ = (id) => document.getElementById(id);
  const el = (tag, text) => {
    const n = document.createElement(tag);
    if (text !== undefined) n.textContent = text;
    return n;
  };

  let csrfToken = "";
  let lastResult = null;
  const HISTORY_KEY = "uavpms_sql_history";
  const WIDTH_KEY = "uavpms_sql_drawer_width";

  function getHistory() {
    try {
      return JSON.parse(localStorage.getItem(HISTORY_KEY) || "[]");
    } catch {
      return [];
    }
  }

  function saveHistory(query) {
    if (!query || !query.trim()) return;
    let list = getHistory().filter((q) => q.trim() !== query.trim());
    list.unshift(query.trim());
    if (list.length > 20) list = list.slice(0, 20);
    localStorage.setItem(HISTORY_KEY, JSON.stringify(list));
    renderHistory();
  }

  function renderHistory() {
    const select = $("side-sql-history");
    if (!select) return;
    select.replaceChildren(new Option("🕒 History…", ""));
    for (const q of getHistory()) {
      const preview = q.replace(/\s+/g, " ").slice(0, 40);
      select.add(new Option(preview, q));
    }
  }

  async function getCsrf() {
    if (csrfToken) return csrfToken;
    try {
      const res = await fetch("/api/tables");
      if (res.ok) {
        const data = await res.json();
        csrfToken = data.csrf || "";
      }
    } catch {}
    return csrfToken;
  }

  function restoreSavedWidth() {
    const drawer = $("side-sql-drawer");
    if (!drawer) return;
    const saved = localStorage.getItem(WIDTH_KEY);
    if (saved) {
      const num = Number(saved);
      if (num >= 320 && num <= window.innerWidth - 50) {
        drawer.style.width = num + "px";
      }
    }
  }

  function openDrawer(initialQuery) {
    const drawer = $("side-sql-drawer");
    if (!drawer) return;
    restoreSavedWidth();
    drawer.removeAttribute("hidden");
    // Small timeout to allow transition
    requestAnimationFrame(() => {
      drawer.classList.add("open");
    });
    const input = $("side-sql-input");
    if (input) {
      if (initialQuery) input.value = initialQuery;
      setTimeout(() => input.focus(), 150);
    }
    renderHistory();
  }

  function closeDrawer() {
    const drawer = $("side-sql-drawer");
    if (!drawer) return;
    drawer.classList.remove("open");
    setTimeout(() => {
      if (!drawer.classList.contains("open")) {
        drawer.setAttribute("hidden", "");
      }
    }, 250);
  }

  function toggleDrawer() {
    const drawer = $("side-sql-drawer");
    if (!drawer) return;
    if (drawer.classList.contains("open") && !drawer.hasAttribute("hidden")) {
      closeDrawer();
    } else {
      openDrawer();
    }
  }

  function setupResizer() {
    const resizer = $("side-sql-resizer");
    const drawer = $("side-sql-drawer");
    if (!resizer || !drawer) return;

    let isDragging = false;

    resizer.addEventListener("mousedown", (e) => {
      isDragging = true;
      resizer.classList.add("dragging");
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
      e.preventDefault();
    });

    window.addEventListener("mousemove", (e) => {
      if (!isDragging) return;
      const newWidth = window.innerWidth - e.clientX;
      const minWidth = 340;
      const maxWidth = Math.max(minWidth, window.innerWidth - 60);
      if (newWidth >= minWidth && newWidth <= maxWidth) {
        drawer.style.width = newWidth + "px";
        localStorage.setItem(WIDTH_KEY, String(newWidth));
      }
    });

    window.addEventListener("mouseup", () => {
      if (isDragging) {
        isDragging = false;
        resizer.classList.remove("dragging");
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
      }
    });
  }

  async function runQuery() {
    const input = $("side-sql-input");
    if (!input) return;
    const query = input.value.trim();
    const errorEl = $("side-sql-error");
    const successEl = $("side-sql-success");
    const runBtn = $("side-sql-run");
    const grid = $("side-sql-grid");
    const durationEl = $("side-sql-duration");
    const rowCountEl = $("side-sql-row-count");
    const exportBtns = $("side-sql-export-btns");

    if (!query) {
      if (errorEl) {
        errorEl.textContent = "Please enter a SQL query.";
        errorEl.hidden = false;
      }
      return;
    }

    if (errorEl) errorEl.hidden = true;
    if (successEl) successEl.hidden = true;
    if (runBtn) runBtn.disabled = true;
    if (grid) grid.setAttribute("aria-busy", "true");

    try {
      saveHistory(query);
      const token = await getCsrf();
      const res = await fetch("/api/sql", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-CSRF-Token": token,
        },
        body: JSON.stringify({ sql: query }),
      });

      if (res.status === 401) {
        location.href = "/login";
        return;
      }

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Query failed");

      lastResult = data;
      if (durationEl) {
        durationEl.textContent = data.durationMs + " ms";
        durationEl.hidden = false;
      }

      if (data.fields && data.fields.length > 0) {
        // Tabular result
        if (rowCountEl) rowCountEl.textContent = (data.rows?.length || 0) + " rows";
        if (exportBtns) exportBtns.hidden = false;
        renderGrid(data);
      } else {
        // Command result
        if (rowCountEl) rowCountEl.textContent = (data.rowCount ?? 0) + " affected";
        if (exportBtns) exportBtns.hidden = true;
        if (grid) grid.replaceChildren();
        if (successEl) {
          successEl.textContent = `✓ ${data.command || "COMMAND OK"} (${data.rowCount ?? 0} affected in ${data.durationMs}ms)`;
          successEl.hidden = false;
        }
      }
    } catch (err) {
      if (errorEl) {
        errorEl.textContent = err.message;
        errorEl.hidden = false;
      }
      if (grid) grid.replaceChildren();
      if (exportBtns) exportBtns.hidden = true;
    } finally {
      if (runBtn) runBtn.disabled = false;
      if (grid) grid.setAttribute("aria-busy", "false");
    }
  }

  function renderGrid(res) {
    const grid = $("side-sql-grid");
    if (!grid) return;
    const table = el("table"),
      thead = el("thead"),
      tbody = el("tbody"),
      trHead = el("tr");

    for (const field of res.fields) {
      trHead.append(el("th", field.name));
    }
    thead.append(trHead);
    table.append(thead);

    for (const row of res.rows || []) {
      const tr = el("tr");
      for (const field of res.fields) {
        const val = row[field.name];
        const td = el("td", val === null ? "NULL" : (typeof val === "object" ? JSON.stringify(val) : String(val)));
        if (val === null) td.className = "null";
        td.title = val === null ? "NULL" : String(val);
        tr.append(td);
      }
      tbody.append(tr);
    }
    table.append(tbody);
    grid.replaceChildren(table);
  }

  function exportResult(format) {
    if (!lastResult || !lastResult.rows) return;
    const fields = lastResult.fields.map((f) => f.name);
    let blob;

    if (format === "json") {
      blob = new Blob([JSON.stringify(lastResult.rows, null, 2)], { type: "application/json" });
    } else {
      const escapeCsv = (val) => {
        if (val === null || val === undefined) return "";
        const str = typeof val === "object" ? JSON.stringify(val) : String(val);
        if (str.includes(",") || str.includes('"') || str.includes("\n") || str.includes("\r")) {
          return '"' + str.replaceAll('"', '""') + '"';
        }
        return str;
      };
      const lines = [fields.map(escapeCsv).join(",")];
      for (const row of lastResult.rows) {
        lines.push(fields.map((f) => escapeCsv(row[f])).join(","));
      }
      blob = new Blob([lines.join("\r\n")], { type: "text/csv;charset=utf-8" });
    }

    const url = URL.createObjectURL(blob);
    const a = el("a");
    a.href = url;
    a.download = `query_result.${format}`;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }

  function init() {
    restoreSavedWidth();
    setupResizer();

    const toggleBtn = $("btn-toggle-side-sql");
    if (toggleBtn) toggleBtn.onclick = toggleDrawer;

    const floatBtn = $("btn-float-side-sql");
    if (floatBtn) floatBtn.onclick = toggleDrawer;

    const closeBtn = $("side-sql-close");
    if (closeBtn) closeBtn.onclick = closeDrawer;

    const clearBtn = $("side-sql-clear");
    if (clearBtn) {
      clearBtn.onclick = () => {
        const input = $("side-sql-input");
        if (input) { input.value = ""; input.focus(); }
        const err = $("side-sql-error");
        if (err) err.hidden = true;
        const succ = $("side-sql-success");
        if (succ) succ.hidden = true;
        const grid = $("side-sql-grid");
        if (grid) grid.replaceChildren();
        const exportBtns = $("side-sql-export-btns");
        if (exportBtns) exportBtns.hidden = true;
      };
    }

    const runBtn = $("side-sql-run");
    if (runBtn) runBtn.onclick = runQuery;

    const input = $("side-sql-input");
    if (input) {
      input.onkeydown = (e) => {
        if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
          e.preventDefault();
          runQuery();
        } else if (e.key === "Tab") {
          e.preventDefault();
          const start = input.selectionStart, end = input.selectionEnd;
          input.value = input.value.substring(0, start) + "  " + input.value.substring(end);
          input.selectionStart = input.selectionEnd = start + 2;
        }
      };
    }

    const templates = $("side-sql-templates");
    if (templates) {
      templates.onchange = () => {
        const val = templates.value;
        if (!val) return;
        let tName = tableName;
        const titleEl = $("definition-title") || $("table-title");
        if (titleEl && titleEl.textContent && !titleEl.textContent.includes("Select")) {
          tName = `"${titleEl.textContent.trim()}"`;
        }
        let sql = "";
        switch (val) {
          case "select_all": sql = `SELECT * FROM ${tName} LIMIT 25;`; break;
          case "count": sql = `SELECT count(*) AS total_count FROM ${tName};`; break;
          case "insert": sql = `INSERT INTO ${tName} (col1, col2)\nVALUES ('val1', 'val2');\n`; break;
          case "update": sql = `UPDATE ${tName}\nSET col1 = 'val'\nWHERE id = 'target_id';\n`; break;
          case "explain": sql = `EXPLAIN ANALYZE\nSELECT * FROM ${tName} LIMIT 25;\n`; break;
        }
        if (input) {
          input.value = sql;
          input.focus();
        }
        templates.value = "";
      };
    }

    const historySelect = $("side-sql-history");
    if (historySelect) {
      historySelect.onchange = () => {
        if (historySelect.value && input) {
          input.value = historySelect.value;
          input.focus();
        }
      };
    }

    const exportCsv = $("side-sql-export-csv");
    if (exportCsv) exportCsv.onclick = () => exportResult("csv");

    const exportJson = $("side-sql-export-json");
    if (exportJson) exportJson.onclick = () => exportResult("json");

    // Close on Escape key
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        const drawer = $("side-sql-drawer");
        if (drawer && drawer.classList.contains("open")) {
          closeDrawer();
        }
      }
    });

    renderHistory();
  }

  window.openSideSql = (query) => openDrawer(query);
  window.closeSideSql = closeDrawer;

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
