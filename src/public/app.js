"use strict";

const $ = (id) => document.getElementById(id),
  el = (tag, text) => {
    const n = document.createElement(tag);
    if (text !== undefined) n.textContent = text;
    return n;
  };

const s = {
  tables: [],
  meta: null,
  rows: [],
  page: 1,
  size: 25,
  filter: {},
  sort: "",
  direction: "asc",
  hidden: new Set(),
  csrf: "",
  generation: 0,
  busy: false,
  selectedKeys: new Map(), // keyString -> keyObj
  activeTab: "table", // "table" | "sql"
  lastSqlResult: null,
  tableCounts: {},
};

const base = () => "/api/tables/" + encodeURIComponent(s.meta.name);

async function api(url, opts = {}) {
  const r = await fetch(url, {
    ...opts,
    headers: { "Content-Type": "application/json", "X-CSRF-Token": s.csrf, ...(opts.headers || {}) },
  });
  if (r.status === 401) {
    location.href = "/login";
    throw Error("Session expired");
  }
  const data = await r.json();
  if (!r.ok) throw Error(data.error || "Request failed");
  return data;
}

async function downloadExport(url, opts = {}, fallbackName = "export.csv") {
  const r = await fetch(url, {
    ...opts,
    headers: { "Content-Type": "application/json", "X-CSRF-Token": s.csrf, ...(opts.headers || {}) },
  });
  if (r.status === 401) {
    location.href = "/login";
    throw Error("Session expired");
  }
  if (!r.ok) {
    const data = await r.json().catch(() => ({}));
    throw Error(data.error || "Export failed");
  }
  const blob = await r.blob();
  const disposition = r.headers.get("Content-Disposition") || "";
  const match = disposition.match(/filename="?([^"]+)"?/);
  const filename = match ? match[1] : fallbackName;
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(link.href), 5000);
}

function message(text, error = false) {
  $("message").textContent = text;
  $("message").className = error ? "error" : "muted";
}

function switchTab(tab) {
  s.activeTab = tab;
  if (tab === "sql") {
    $("view-table-editor").hidden = true;
    $("view-sql-editor").hidden = false;
    $("nav-table-editor").classList.remove("active");
    $("nav-sql-editor").classList.add("active");
    history.replaceState(null, "", "/sql");
    $("sql-input").focus();
  } else {
    $("view-sql-editor").hidden = true;
    $("view-table-editor").hidden = false;
    $("nav-sql-editor").classList.remove("active");
    $("nav-table-editor").classList.add("active");
    if (s.meta) {
      history.replaceState(null, "", "/tables/" + encodeURIComponent(s.meta.name));
    } else {
      history.replaceState(null, "", "/tables");
    }
  }
}

function sidebar() {
  $("tables").replaceChildren();
  const query = $("table-search").value.toLowerCase();
  for (const t of s.tables.filter((t) => t.name.toLowerCase().includes(query))) {
    const b = el("button");
    b.className = s.meta?.name === t.name ? "active" : "";
    
    const nameSpan = el("span", "▦  " + t.name);
    b.append(nameSpan);

    if (s.tableCounts[t.name] !== undefined) {
      const badge = el("span", String(s.tableCounts[t.name]));
      badge.className = "table-badge";
      b.append(badge);
    }

    b.onclick = () => {
      switchTab("table");
      selectTable(t.name);
    };
    $("tables").append(b);
  }
}

async function fetchTableCounts() {
  for (const t of s.tables) {
    try {
      const res = await api("/api/tables/" + encodeURIComponent(t.name) + "/count");
      s.tableCounts[t.name] = res.count;
      sidebar();
    } catch {
      // Ignore count error
    }
  }
}

async function selectTable(name) {
  const generation = ++s.generation;
  s.meta = null;
  s.rows = [];
  s.selectedKeys.clear();
  updateBulkBar();

  $("grid").replaceChildren();
  $("add").disabled = true;
  $("prev").disabled = true;
  $("next").disabled = true;
  message("Loading table…");

  try {
    const meta = await api("/api/tables/" + encodeURIComponent(name));
    if (generation !== s.generation) return;
    s.meta = meta;
    s.page = 1;
    s.sort = "";
    s.filter = {};
    s.hidden = new Set();
    history.replaceState(null, "", "/tables/" + encodeURIComponent(name));
    
    $("table-title").textContent = name;
    $("table-detail").textContent =
      meta.columns.length + " columns · public schema" +
      (s.tableCounts[name] !== undefined ? " · ~" + s.tableCounts[name] + " total rows" : "");
    $("add").disabled = !meta.permissions.insert;

    $("filter-column").replaceChildren(new Option("All columns", ""));
    for (const c of meta.columns)
      $("filter-column").add(new Option(c.name, c.name));
    $("filter-value").value = "";

    $("notice").hidden = false;
    $("notice").textContent = meta.columns.some((c) => c.pk)
      ? "Full administrative access. Primary keys enabled for edits, clones and bulk deletions."
      : "No primary key: row editing/deleting unavailable; sorting may vary.";

    $("column-list").replaceChildren();
    for (const c of meta.columns) {
      const l = el("label"),
        b = el("input");
      b.type = "checkbox";
      b.checked = true;
      b.onchange = () => {
        b.checked ? s.hidden.delete(c.name) : s.hidden.add(c.name);
        render();
      };
      l.append(b, document.createTextNode(c.name));
      $("column-list").append(l);
    }
    sidebar();
    await load();
  } catch (e) {
    if (generation === s.generation) message(e.message, true);
  }
}

async function load() {
  if (!s.meta) return;
  const g = ++s.generation,
    q = new URLSearchParams({ page: s.page, size: s.size, ...s.filter });
  if (s.sort) {
    q.set("sort", s.sort);
    q.set("direction", s.direction);
  }
  message("Loading rows…");
  $("grid").setAttribute("aria-busy", "true");
  $("prev").disabled = true;
  $("next").disabled = true;
  try {
    const d = await api(base() + "/rows?" + q);
    if (g !== s.generation) return;
    s.rows = d.rows;
    render();
    message(
      d.rows.length ? "" : "No rows found. Add a row or change your filter.",
    );
    $("page-info").textContent =
      `Page ${s.page} · ${d.rows.length} rows shown${d.hasNext ? " · more available" : ""}`;
    $("prev").disabled = s.page === 1;
    $("next").disabled = !d.hasNext;
  } catch (e) {
    if (g === s.generation) {
      $("grid").replaceChildren();
      message(e.message, true);
    }
  } finally {
    if (g === s.generation) $("grid").setAttribute("aria-busy", "false");
  }
}

const key = (row) =>
  Object.fromEntries(
    s.meta.columns.filter((c) => c.pk).map((c) => [c.name, row[c.name]]),
  );

const keyString = (k) => JSON.stringify(k);

function updateBulkBar() {
  const count = s.selectedKeys.size;
  const bar = $("bulk-bar");
  if (!bar) return;
  if (count > 0) {
    bar.hidden = false;
    bar.style.display = "flex";
    $("bulk-count").textContent = count + (count === 1 ? " row selected" : " rows selected");
  } else {
    bar.hidden = true;
    bar.style.display = "none";
  }
}

function render() {
  if (!s.meta) return;
  const table = el("table"),
    head = el("thead"),
    tr = el("tr"),
    hasPk = s.meta.columns.some((c) => c.pk),
    columns = s.meta.columns.filter((c) => !s.hidden.has(c.name));

  // Checkbox column header
  if (hasPk) {
    const thCheck = el("th");
    thCheck.className = "checkbox-cell";
    const masterCheck = el("input");
    masterCheck.type = "checkbox";
    masterCheck.title = "Select / Deselect all on current page";

    // Determine master state
    const allSelectedOnPage =
      s.rows.length > 0 &&
      s.rows.every((r) => s.selectedKeys.has(keyString(key(r))));
    const someSelectedOnPage =
      s.rows.some((r) => s.selectedKeys.has(keyString(key(r))));
    masterCheck.checked = allSelectedOnPage;
    masterCheck.indeterminate = !allSelectedOnPage && someSelectedOnPage;

    masterCheck.onchange = () => {
      for (const row of s.rows) {
        const kStr = keyString(key(row));
        if (masterCheck.checked) {
          s.selectedKeys.set(kStr, key(row));
        } else {
          s.selectedKeys.delete(kStr);
        }
      }
      updateBulkBar();
      render();
    };
    thCheck.append(masterCheck);
    tr.append(thCheck);
  }

  for (const c of columns) {
    const th = el("th"),
      b = el(
        "button",
        `${c.pk ? "⚿ " : ""}${c.name}${s.sort === c.name ? (s.direction === "asc" ? " ↑" : " ↓") : ""}`,
      );
    b.onclick = () => {
      s.direction = s.sort === c.name && s.direction === "asc" ? "desc" : "asc";
      s.sort = c.name;
      s.page = 1;
      load();
    };
    th.setAttribute(
      "aria-sort",
      s.sort === c.name
        ? s.direction === "asc"
          ? "ascending"
          : "descending"
        : "none",
    );
    th.append(
      b,
      el("small", c.description + (c.spatial ? " · read-only" : "")),
    );
    tr.append(th);
  }

  tr.append(el("th", "Actions"));
  head.append(tr);
  table.append(head);

  const body = el("tbody");
  for (const row of s.rows) {
    const tr = el("tr");
    const rowKey = hasPk ? key(row) : null;
    const rowKeyStr = rowKey ? keyString(rowKey) : "";

    // Checkbox per row
    if (hasPk) {
      const tdCheck = el("td");
      tdCheck.className = "checkbox-cell";
      const rowCheck = el("input");
      rowCheck.type = "checkbox";
      rowCheck.checked = s.selectedKeys.has(rowKeyStr);
      rowCheck.onchange = () => {
        if (rowCheck.checked) {
          s.selectedKeys.set(rowKeyStr, rowKey);
        } else {
          s.selectedKeys.delete(rowKeyStr);
        }
        updateBulkBar();
        if (masterCheck) {
          const allSelected =
            s.rows.length > 0 &&
            s.rows.every((r) => s.selectedKeys.has(keyString(key(r))));
          const someSelected =
            s.rows.some((r) => s.selectedKeys.has(keyString(key(r))));
          masterCheck.checked = allSelected;
          masterCheck.indeterminate = !allSelected && someSelected;
        }
      };
      tdCheck.append(rowCheck);
      tr.append(tdCheck);
    }

    for (const c of columns) {
      const td = el("td", row[c.name] ?? "NULL");
      if (row[c.name] === null) td.className = "null";
      td.title = row[c.name] ?? "NULL";
      tr.append(td);
    }

    const actions = el("td");
    actions.className = "row-actions";

    // 1. Edit / Open
    const edit = el("button", "Edit");
    edit.onclick = () => openEditor(row);
    actions.append(edit);

    // 2. Clone
    if (hasPk && s.meta.permissions.insert) {
      const clone = el("button", "Clone");
      clone.className = "btn-clone";
      clone.title = "Duplicate this row";
      clone.onclick = async () => {
        if (!confirm("Clone this row? Non-primary key attributes will be copied.")) return;
        try {
          message("Cloning row…");
          await api(base() + "/rows/clone", {
            method: "POST",
            body: JSON.stringify({ key: rowKey }),
          });
          message("Row cloned successfully.");
          await load();
          fetchTableCounts();
        } catch (e) {
          message("Clone failed: " + e.message, true);
        }
      };
      actions.append(clone);
    }

    // 3. View JSON
    const jsonBtn = el("button", "JSON");
    jsonBtn.className = "btn-json";
    jsonBtn.title = "View row as JSON";
    jsonBtn.onclick = () => openJsonModal(row);
    actions.append(jsonBtn);

    // 4. Delete
    if (hasPk && s.meta.permissions.delete) {
      const del = el("button", "Delete");
      del.className = "danger-text";
      del.onclick = () => {
        s.deleting = row;
        $("delete-error").textContent = "";
        $("delete-dialog").showModal();
      };
      actions.append(del);
    }

    tr.append(actions);
    body.append(tr);
  }

  table.append(body);
  $("grid").replaceChildren(table);
}

function openJsonModal(rowData) {
  $("json-code").textContent = JSON.stringify(rowData, null, 2);
  $("copy-json").textContent = "📋 Copy to Clipboard";
  $("json-dialog").showModal();
}

$("close-json").onclick = () => $("json-dialog").close();
$("done-json").onclick = () => $("json-dialog").close();

$("copy-json").onclick = async () => {
  try {
    await navigator.clipboard.writeText($("json-code").textContent);
    $("copy-json").textContent = "✓ Copied!";
    setTimeout(() => {
      $("copy-json").textContent = "📋 Copy to Clipboard";
    }, 2000);
  } catch {
    $("copy-json").textContent = "Failed to copy";
  }
};

function openEditor(row) {
  s.editing = row;
  s.controls = [];
  $("editor-title").textContent = row ? "Edit row" : "Add row";
  $("editor-error").textContent = "";
  $("fields").replaceChildren();
  const writable = row ? s.meta.permissions.update : s.meta.permissions.insert;

  for (let i = 0; i < s.meta.columns.length; i++) {
    const c = s.meta.columns[i],
      f = el("div"),
      label = el("label", c.name);
    f.className = "field";
    label.htmlFor = "field-" + i;
    f.append(
      label,
      el("small", c.description + (c.spatial ? " · PostGIS, read-only" : "")),
    );
    const readonly = c.readonly || (row && c.pk) || !writable,
      mode = el("select");
    mode.setAttribute("aria-label", c.name + " value mode");
    if (row) mode.add(new Option("Keep current value", "omit"));
    else if (c.default || c.identity || c.generated)
      mode.add(new Option("Use database default", "omit"));
    else if (c.nullable) mode.add(new Option("Leave unset (NULL)", "omit"));
    mode.add(new Option("Set value", "value"));
    if (c.nullable) mode.add(new Option("NULL", "null"));

    let input;
    if (c.options.length) {
      input = el("select");
      for (const o of c.options) input.add(new Option(o, o));
    } else if (["json", "jsonb"].includes(c.type) || c.spatial) {
      input = el("textarea");
      input.rows = 5;
    } else {
      input = el("input");
      input.type =
        c.type === "bool"
          ? "checkbox"
          : ["int2", "int4", "int8", "numeric", "float4", "float8"].includes(
                c.type,
              )
            ? "number"
            : c.type === "date"
              ? "date"
              : ["timestamp", "timestamptz"].includes(c.type)
                ? "datetime-local"
                : "text";
      if (input.type === "number")
        input.step = ["int2", "int4", "int8"].includes(c.type) ? "1" : "any";
      if (input.type === "datetime-local") input.step = "any";
    }
    input.id = "field-" + i;
    const value = row?.[c.name];
    if (
      value != null &&
      ["timestamp", "timestamptz", "date"].includes(c.type) &&
      !Number.isFinite(Date.parse(value))
    )
      input.type = "text";
    if (input.type === "checkbox")
      input.checked = value === "true" || value === "t";
    else if (value != null)
      input.value =
        c.type === "timestamptz" && Number.isFinite(Date.parse(value))
          ? new Date(value).toISOString().slice(0, -1)
          : c.type === "timestamp"
            ? value.replace(" ", "T")
            : value;

    if (c.type === "timestamptz")
      f.append(
        el("small", "Time in UTC. Keep current value preserves full precision."),
      );

    const sync = () => {
      input.disabled = readonly || mode.value !== "value";
    };
    mode.onchange = sync;
    mode.disabled = readonly;
    sync();

    f.append(mode, input);
    s.controls.push({ c, input, mode });

    if (c.fk) {
      f.append(
        el("small", `References ${c.fk.schema}.${c.fk.table}.${c.fk.target}`),
      );
      if (!readonly && c.fk.width === 1 && c.fk.schema === "public") {
        const search = el("input"),
          results = el("select"),
          status = el("small");
        search.placeholder = "Search referenced rows…";
        search.setAttribute("aria-label", "Search " + c.name + " references");
        results.setAttribute("aria-label", "Choose " + c.name + " reference");
        results.add(new Option("Search to choose a reference", ""));
        let timer,
          version = 0;
        const url = base() + "/references/" + encodeURIComponent(c.name);
        search.oninput = () => {
          clearTimeout(timer);
          const request = ++version;
          timer = setTimeout(async () => {
            try {
              status.textContent = "Searching…";
              const data = await api(
                url + "?q=" + encodeURIComponent(search.value),
              );
              if (request !== version) return;
              results.replaceChildren(new Option("Choose a reference", ""));
              for (const o of data.options)
                results.add(
                  new Option(`${o.label ?? o.value} · ${o.value}`, o.value),
                );
              status.textContent = data.options.length
                ? "Up to 30 results. Refine your search."
                : "No matching references.";
            } catch (e) {
              if (request === version) status.textContent = e.message;
            }
          }, 250);
        };
        results.onchange = () => {
          if (results.value) {
            mode.value = "value";
            sync();
            input.value = results.value;
          }
        };
        f.append(search, results, status);
      }
    }
    $("fields").append(f);
  }
  $("editor").showModal();
}

$("row-form").onsubmit = async (e) => {
  e.preventDefault();
  if (s.busy) return;
  try {
    const values = {};
    for (const { c, input, mode } of s.controls) {
      if (mode.disabled || mode.value === "omit") continue;
      let value =
        mode.value === "null"
          ? null
          : input.type === "checkbox"
            ? input.checked
            : input.value;
      if (value !== null && ["json", "jsonb"].includes(c.type)) {
        try {
          JSON.parse(value);
        } catch {
          throw Error(c.name + ": enter valid JSON.");
        }
      }
      if (
        value !== null &&
        c.type === "timestamptz" &&
        input.type === "datetime-local" &&
        value
      )
        value += "Z";
      values[c.name] = value;
    }
    s.busy = true;
    $("save").disabled = true;
    await api(base() + "/rows", {
      method: s.editing ? "PATCH" : "POST",
      body: JSON.stringify({
        values,
        ...(s.editing ? { key: key(s.editing) } : {}),
      }),
    });
    $("editor").close();
    await load();
    fetchTableCounts();
  } catch (e) {
    $("editor-error").textContent = e.message;
  } finally {
    s.busy = false;
    $("save").disabled = false;
  }
};

for (const id of ["close-editor", "cancel-editor"])
  $(id).onclick = () => {
    if (!s.busy) $("editor").close();
  };

for (const id of ["editor", "delete-dialog", "bulk-delete-dialog", "json-dialog"])
  $(id).addEventListener("cancel", (e) => {
    if (s.busy) e.preventDefault();
  });

$("cancel-delete").onclick = () => {
  if (!s.busy) $("delete-dialog").close();
};

$("confirm-delete").onclick = async () => {
  if (s.busy) return;
  s.busy = true;
  $("confirm-delete").disabled = true;
  try {
    await api(base() + "/rows", {
      method: "DELETE",
      body: JSON.stringify({ key: key(s.deleting), confirm: true }),
    });
    $("delete-dialog").close();
    if (s.rows.length === 1 && s.page > 1) s.page--;
    await load();
    fetchTableCounts();
  } catch (e) {
    $("delete-error").textContent = e.message;
  } finally {
    s.busy = false;
    $("confirm-delete").disabled = false;
  }
};

// Bulk Actions Handlers
$("bulk-clear-btn").onclick = () => {
  s.selectedKeys.clear();
  updateBulkBar();
  render();
};

$("bulk-delete-btn").onclick = () => {
  const count = s.selectedKeys.size;
  if (count === 0) return;
  $("bulk-delete-message").textContent = `You are about to permanently delete ${count} selected row(s). Database cascade rules may delete related rows. This cannot be undone.`;
  $("bulk-delete-error").textContent = "";
  $("bulk-delete-dialog").showModal();
};

$("cancel-bulk-delete").onclick = () => {
  if (!s.busy) $("bulk-delete-dialog").close();
};

$("confirm-bulk-delete").onclick = async () => {
  if (s.busy) return;
  s.busy = true;
  $("confirm-bulk-delete").disabled = true;
  try {
    const keys = Array.from(s.selectedKeys.values());
    const res = await api(base() + "/rows/bulk-delete", {
      method: "POST",
      body: JSON.stringify({ keys }),
    });
    $("bulk-delete-dialog").close();
    s.selectedKeys.clear();
    updateBulkBar();
    message(`Deleted ${res.affected} rows successfully.`);
    await load();
    fetchTableCounts();
  } catch (e) {
    $("bulk-delete-error").textContent = e.message;
  } finally {
    s.busy = false;
    $("confirm-bulk-delete").disabled = false;
  }
};

// Export Handlers
$("export-table-csv").onclick = async () => {
  if (!s.meta) return;
  const q = new URLSearchParams({ format: "csv", ...s.filter });
  if (s.sort) { q.set("sort", s.sort); q.set("direction", s.direction); }
  message("Preparing CSV export…");
  try {
    await downloadExport(base() + "/export?" + q, {}, s.meta.name + ".csv");
    message("Export completed.");
  } catch (e) {
    message("Export failed: " + e.message, true);
  }
};

$("export-table-json").onclick = async () => {
  if (!s.meta) return;
  const q = new URLSearchParams({ format: "json", ...s.filter });
  if (s.sort) { q.set("sort", s.sort); q.set("direction", s.direction); }
  message("Preparing JSON export…");
  try {
    await downloadExport(base() + "/export?" + q, {}, s.meta.name + ".json");
    message("Export completed.");
  } catch (e) {
    message("Export failed: " + e.message, true);
  }
};

$("bulk-export-csv").onclick = async () => {
  if (!s.meta || s.selectedKeys.size === 0) return;
  message("Exporting selected rows…");
  try {
    await downloadExport(base() + "/export", {
      method: "POST",
      body: JSON.stringify({
        format: "csv",
        keys: Array.from(s.selectedKeys.values()),
      }),
    }, s.meta.name + "_selected.csv");
    message("Export completed.");
  } catch (e) {
    message("Export failed: " + e.message, true);
  }
};

$("bulk-export-json").onclick = async () => {
  if (!s.meta || s.selectedKeys.size === 0) return;
  message("Exporting selected rows…");
  try {
    await downloadExport(base() + "/export", {
      method: "POST",
      body: JSON.stringify({
        format: "json",
        keys: Array.from(s.selectedKeys.values()),
      }),
    }, s.meta.name + "_selected.json");
    message("Export completed.");
  } catch (e) {
    message("Export failed: " + e.message, true);
  }
};

// Toolbar Handlers
$("add").onclick = () => openEditor();
$("table-search").oninput = sidebar;
$("refresh").onclick = load;

$("filter").onsubmit = (e) => {
  e.preventDefault();
  s.filter = $("filter-column").value
    ? {
        column: $("filter-column").value,
        op: $("filter-op").value,
        value: $("filter-value").value,
      }
    : {};
  s.page = 1;
  load();
};

$("reset").onclick = () => {
  s.filter = {};
  s.page = 1;
  $("filter-column").value = "";
  $("filter-value").value = "";
  load();
};

$("size").onchange = () => {
  s.size = Number($("size").value);
  s.page = 1;
  load();
};

$("prev").onclick = () => {
  s.page--;
  load();
};

$("next").onclick = () => {
  s.page++;
  load();
};

$("logout").onclick = async () => {
  try {
    await api("/logout", { method: "POST", body: "{}" });
    location.href = "/login";
  } catch (e) {
    message(e.message, true);
  }
};

// Tab switching buttons
$("nav-table-editor").onclick = () => switchTab("table");
$("nav-sql-editor").onclick = () => switchTab("sql");

// ==========================================
// SQL EDITOR LOGIC
// ==========================================

const SQL_HISTORY_KEY = "uavpms_sql_history";

function getSqlHistory() {
  try {
    return JSON.parse(localStorage.getItem(SQL_HISTORY_KEY) || "[]");
  } catch {
    return [];
  }
}

function saveSqlHistory(query) {
  if (!query || !query.trim()) return;
  let history = getSqlHistory().filter((q) => q.trim() !== query.trim());
  history.unshift(query.trim());
  if (history.length > 20) history = history.slice(0, 20);
  localStorage.setItem(SQL_HISTORY_KEY, JSON.stringify(history));
  updateHistoryDropdown();
}

function updateHistoryDropdown() {
  const history = getSqlHistory();
  $("sql-history").replaceChildren(new Option("🕒 History…", ""));
  for (const item of history) {
    const preview = item.replace(/\s+/g, " ").slice(0, 45);
    $("sql-history").add(new Option(preview, item));
  }
}

$("sql-history").onchange = () => {
  if ($("sql-history").value) {
    $("sql-input").value = $("sql-history").value;
    $("sql-input").focus();
  }
};

$("sql-templates").onchange = () => {
  const val = $("sql-templates").value;
  if (!val) return;
  const tName = s.meta ? `"${s.meta.name}"` : tableName;
  let snippet = "";
  switch (val) {
    case "select_all":
      snippet = `SELECT * FROM ${tName} LIMIT 25;`;
      break;
    case "count":
      snippet = `SELECT count(*) AS total_rows FROM ${tName};`;
      break;
    case "insert":
      snippet = `INSERT INTO ${tName} (column1, column2)\nVALUES ('value1', 'value2');\n`;
      break;
    case "update":
      snippet = `UPDATE ${tName}\nSET column1 = 'new_value'\nWHERE id = 'target_id';\n`;
      break;
    case "delete":
      snippet = `DELETE FROM ${tName}\nWHERE id = 'target_id';\n`;
      break;
    case "create_table":
      snippet = `CREATE TABLE "NewTable" (\n  "Id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),\n  "Name" text NOT NULL,\n  "CreatedAt" timestamptz DEFAULT now()\n);\n`;
      break;
    case "explain":
      snippet = `EXPLAIN ANALYZE\nSELECT * FROM ${tName} LIMIT 50;\n`;
      break;
  }
  $("sql-input").value = snippet;
  $("sql-templates").value = "";
  $("sql-input").focus();
};

$("sql-clear").onclick = () => {
  $("sql-input").value = "";
  $("sql-error").hidden = true;
  $("sql-success-banner").hidden = true;
  $("sql-grid").replaceChildren();
  $("sql-results-header").hidden = true;
  $("sql-duration").hidden = true;
  $("sql-row-count").hidden = true;
  $("sql-input").focus();
};

async function runSqlQuery() {
  const query = $("sql-input").value.trim();
  if (!query) {
    $("sql-error").textContent = "Please enter a SQL query to execute.";
    $("sql-error").hidden = false;
    return;
  }

  $("sql-error").hidden = true;
  $("sql-success-banner").hidden = true;
  $("sql-run").disabled = true;
  $("sql-grid").setAttribute("aria-busy", "true");

  try {
    saveSqlHistory(query);
    const result = await api("/api/sql", {
      method: "POST",
      body: JSON.stringify({ sql: query }),
    });

    s.lastSqlResult = result;

    $("sql-duration").textContent = result.durationMs + " ms";
    $("sql-duration").hidden = false;

    if (result.fields && result.fields.length > 0) {
      // Query returned tabular rows (e.g. SELECT, EXPLAIN)
      $("sql-row-count").textContent = (result.rows?.length || 0) + " row(s)";
      $("sql-row-count").hidden = false;
      renderSqlGrid(result);
    } else {
      // Non-tabular query (e.g. INSERT, UPDATE, DELETE, CREATE, ALTER)
      $("sql-row-count").textContent = (result.rowCount ?? 0) + " affected";
      $("sql-row-count").hidden = false;
      $("sql-grid").replaceChildren();
      $("sql-results-header").hidden = true;
      $("sql-success-banner").textContent = `✓ Query executed successfully: ${result.command || "COMMAND OK"} (${result.rowCount ?? 0} affected in ${result.durationMs}ms)`;
      $("sql-success-banner").hidden = false;
      fetchTableCounts();
    }
  } catch (err) {
    $("sql-error").textContent = err.message;
    $("sql-error").hidden = false;
    $("sql-grid").replaceChildren();
    $("sql-results-header").hidden = true;
  } finally {
    $("sql-run").disabled = false;
    $("sql-grid").setAttribute("aria-busy", "false");
  }
}

function renderSqlGrid(res) {
  $("sql-results-header").hidden = false;
  const table = el("table"),
    thead = el("thead"),
    tbody = el("tbody"),
    trHead = el("tr");

  for (const field of res.fields) {
    const th = el("th", field.name);
    trHead.append(th);
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
  $("sql-grid").replaceChildren(table);
}

// SQL Export CSV / JSON
$("sql-export-csv").onclick = () => {
  if (!s.lastSqlResult || !s.lastSqlResult.rows) return;
  const fields = s.lastSqlResult.fields.map((f) => f.name);
  const escapeCsv = (val) => {
    if (val === null || val === undefined) return "";
    const str = typeof val === "object" ? JSON.stringify(val) : String(val);
    if (str.includes(",") || str.includes('"') || str.includes("\n") || str.includes("\r")) {
      return '"' + str.replaceAll('"', '""') + '"';
    }
    return str;
  };

  const lines = [fields.map(escapeCsv).join(",")];
  for (const row of s.lastSqlResult.rows) {
    lines.push(fields.map((f) => escapeCsv(row[f])).join(","));
  }

  const blob = new Blob([lines.join("\r\n")], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = el("a");
  a.href = url;
  a.download = "query_result.csv";
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
};

$("sql-export-json").onclick = () => {
  if (!s.lastSqlResult || !s.lastSqlResult.rows) return;
  const blob = new Blob([JSON.stringify(s.lastSqlResult.rows, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = el("a");
  a.href = url;
  a.download = "query_result.json";
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
};

$("sql-run").onclick = runSqlQuery;

// SQL textarea keyboard handling (Ctrl+Enter to run, Tab to indent)
$("sql-input").onkeydown = (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
    e.preventDefault();
    runSqlQuery();
  } else if (e.key === "Tab") {
    e.preventDefault();
    const start = $("sql-input").selectionStart,
      end = $("sql-input").selectionEnd;
    $("sql-input").value =
      $("sql-input").value.substring(0, start) +
      "  " +
      $("sql-input").value.substring(end);
    $("sql-input").selectionStart = $("sql-input").selectionEnd = start + 2;
  }
};

// Global shortcuts
document.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === "N" || e.key === "n")) {
    if (s.activeTab === "table" && s.meta && s.meta.permissions.insert) {
      e.preventDefault();
      openEditor();
    }
  }
});

// App Initialization
(async () => {
  try {
    updateHistoryDropdown();
    const d = await api("/api/tables");
    s.csrf = d.csrf;
    s.tables = d.tables;
    $("tables-badge").textContent = s.tables.length + " tables";
    sidebar();
    fetchTableCounts();

    const path = location.pathname;
    if (path.startsWith("/sql")) {
      switchTab("sql");
    } else {
      const requested = decodeURIComponent(path.split("/")[2] || "");
      if (s.tables.length) {
        await selectTable(
          s.tables.some((t) => t.name === requested)
            ? requested
            : s.tables[0].name,
        );
      } else {
        message("No accessible public tables.");
      }
    }
  } catch (e) {
    message(e.message, true);
  }
})();
