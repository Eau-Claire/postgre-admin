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
    
    b.append(el("span", t.name));
    b.title = t.name;

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
  s.focusKey = null;
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
      meta.columns.length + " columns" +
      (s.tableCounts[name] !== undefined ? " · about " + s.tableCounts[name] + " rows" : "") +
      " · double-click a cell to edit, select a row and press Delete to remove it";
    $("add").disabled = !meta.permissions.insert;

    $("filter-column").replaceChildren(new Option("Filter by column…", ""));
    for (const c of meta.columns)
      $("filter-column").add(new Option(c.name, c.name));
    $("filter-value").value = "";
    syncFilterControls();

    const hasPk = meta.columns.some((c) => c.pk);
    $("notice").hidden = hasPk;
    $("notice").textContent = hasPk
      ? ""
      : "This table has no primary key, so rows can be browsed and added but not edited or deleted.";

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

function keyTag(kind) {
  const t = el("span", kind);
  t.className = "key-tag " + kind.toLowerCase();
  return t;
}

function sortMark(arrow) {
  const m = el("span", arrow);
  m.className = "sort-mark";
  return m;
}

// Colour status-like values by meaning; unknown values stay neutral.
const TONES = [
  ["good", /^(confirmed|completed|approved|active|success|succeeded|done|resolved|closed|verified|enabled|true)$/i],
  ["bad", /^(rejected|failed|failure|cancel+ed|error|deleted|disabled|inactive|blocked|expired|false)$/i],
  ["wait", /^(pending|inreview|in_review|review|processing|queued|waiting|draft|scheduled|inprogress|in_progress|running|open)$/i],
];

function valuePill(c, value) {
  const label = c.choices?.find((o) => o.value === value)?.label;
  const p = el("span", label && label !== value ? `${label} (${value})` : value);
  const tone = TONES.find(([, re]) => re.test(String(value).replace(/\s+/g, "")));
  p.className = "pill" + (tone ? " tone-" + tone[0] : "");
  return p;
}

function filterColumn() {
  return s.meta?.columns.find((c) => c.name === $("filter-column").value) || null;
}

// Status-like columns (enum, CHECK list, or a text code referencing a small
// lookup table) get a dropdown. IDs stay as a typed value.
function fixedValues(c) {
  if (!c) return null;
  if (c.options?.length) return c.options.map((o) => ({ value: o, label: o }));
  if (c.choices?.length && TEXT_TYPES.includes(c.type)) return c.choices;
  return null;
}

// FK choices are only worth a dropdown when rows have a readable label
// (e.g. CategoryId -> category name); bare UUID lists are left to typing/search.
function pickList(c) {
  const fixed = fixedValues(c);
  if (fixed) return fixed;
  if (c.choices?.length && c.choices.some((o) => o.label && o.label !== o.value)) return c.choices;
  return null;
}

// The value box becomes a dropdown only for fixed-value columns.
function syncFilterControls() {
  const c = filterColumn(),
    op = $("filter-op").value,
    needsValue = !["null", "notnull"].includes(op),
    list = fixedValues(c);
  const select = $("filter-value-select");
  if (list && needsValue) {
    const current = select.value;
    select.replaceChildren(
      ...list.map((o) => new Option(o.label === o.value ? o.value : `${o.label} (${o.value})`, o.value)),
    );
    if (list.some((o) => o.value === current)) select.value = current;
    if (op === "contains") $("filter-op").value = "eq";
  }
  select.hidden = !(list && needsValue);
  $("filter-value").hidden = !!list || !needsValue;
}

// ---------- inline cell editing ----------
const TEXT_TYPES = ["text", "varchar", "bpchar"];
const NULL_TOKEN = "\u0000null";

function canInline(c) {
  return (
    !!s.meta?.permissions.update &&
    s.meta.columns.some((x) => x.pk) &&
    !c.readonly &&
    !c.pk &&
    !["json", "jsonb"].includes(c.type)
  );
}

function cellControl(c, value) {
  const list = pickList(c)
    ? pickList(c)
    : c.type === "bool"
        ? [{ value: "true", label: "true" }, { value: "false", label: "false" }]
        : null;
  if (list) {
    const sel = el("select");
    if (c.nullable) sel.add(new Option("NULL", NULL_TOKEN));
    for (const o of list)
      sel.add(new Option(o.label && o.label !== o.value ? `${o.label} (${o.value})` : o.value, o.value));
    const current = c.type === "bool" && value != null ? String(value === "t" || value === "true") : value;
    if (current != null && ![...sel.options].some((o) => o.value === current))
      sel.add(new Option(current + " (current)", current));
    sel.value = current ?? NULL_TOKEN;
    return sel;
  }
  const input = inputFor(c);
  if (value != null) {
    if (input.type === "datetime-local" && !Number.isFinite(Date.parse(value))) input.type = "text";
    input.value =
      c.type === "timestamptz" && input.type === "datetime-local"
        ? new Date(value).toISOString().slice(0, -1)
        : c.type === "timestamp"
          ? value.replace(" ", "T")
          : value;
  }
  if (c.nullable) input.placeholder = TEXT_TYPES.includes(c.type) ? "Empty text · Ctrl+Del = NULL" : "Empty = NULL";
  return input;
}

function startInlineEdit(td, row, c) {
  if (!canInline(c)) return openEditor(row);
  if (td.querySelector(".cell-editor")) return;
  const original = row[c.name];
  const ctl = cellControl(c, original);
  ctl.classList.add("cell-editor");
  td.replaceChildren(ctl);
  td.classList.add("editing");
  ctl.focus();
  if (ctl.select && ctl.tagName === "INPUT") ctl.select();

  const initial = ctl.value;
  let done = false,
    forceNull = false;
  const finish = async (save) => {
    if (done) return;
    done = true;
    if (!save) return render();
    let value;
    if (ctl.tagName === "SELECT") {
      value = ctl.value === NULL_TOKEN ? null : c.type === "bool" ? ctl.value === "true" : ctl.value;
    } else if (forceNull || (ctl.value === "" && c.nullable && !TEXT_TYPES.includes(c.type))) {
      value = null;
    } else {
      value = ctl.value;
      if (c.type === "timestamptz" && ctl.type === "datetime-local" && value) value += "Z";
    }
    if (!forceNull && ctl.value === initial) return render();
    td.classList.add("saving");
    try {
      await api(base() + "/rows", {
        method: "PATCH",
        body: JSON.stringify({ key: key(row), values: { [c.name]: value } }),
      });
      message(`Saved ${c.name}.`);
      await load();
    } catch (e) {
      message(`${c.name}: ${e.message}`, true);
      render();
    }
  };
  ctl.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      finish(true);
    } else if (e.key === "Escape") {
      e.preventDefault();
      finish(false);
    } else if (e.key === "Delete" && e.ctrlKey && c.nullable) {
      e.preventDefault();
      forceNull = true;
      finish(true);
    }
    e.stopPropagation();
  });
  if (ctl.tagName === "SELECT") ctl.addEventListener("change", () => finish(true));
  ctl.addEventListener("blur", () => finish(true));
}

function askDelete() {
  if (!s.meta?.permissions.delete || !s.meta.columns.some((c) => c.pk)) return;
  if (s.selectedKeys.size) return $("bulk-delete-btn").click();
  const row = s.rows.find((r) => keyString(key(r)) === s.focusKey);
  if (!row) return;
  s.deleting = row;
  $("delete-error").textContent = "";
  $("delete-dialog").showModal();
}

function render() {
  if (!s.meta) return;
  const table = el("table"),
    head = el("thead"),
    tr = el("tr"),
    hasPk = s.meta.columns.some((c) => c.pk),
    columns = s.meta.columns.filter((c) => !s.hidden.has(c.name));

  // Checkbox column header
  let masterCheck = null;
  if (hasPk) {
    const thCheck = el("th");
    thCheck.className = "checkbox-cell";
    masterCheck = el("input");
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
      b = el("button");
    b.type = "button";
    if (c.pk) b.append(keyTag("PK"));
    if (c.fk) b.append(keyTag("FK"));
    b.append(document.createTextNode(c.name));
    if (s.sort === c.name)
      b.append(sortMark(s.direction === "asc" ? "↑" : "↓"));
    b.title = "Sort by " + c.name;
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

  const actionsHead = el("th", "");
  actionsHead.className = "actions-cell";
  tr.append(actionsHead);
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
        tr.classList.toggle("is-selected", rowCheck.checked);
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
      const value = row[c.name];
      const td = el("td");
      if (value === null || value === undefined) {
        td.textContent = "NULL";
        td.className = "null";
      } else if (fixedValues(c)) {
        td.append(valuePill(c, value));
      } else {
        td.textContent = value;
      }
      td.title = value ?? "NULL";
      if (canInline(c)) td.classList.add("editable");
      td.ondblclick = (e) => {
        e.stopPropagation();
        startInlineEdit(td, row, c);
      };
      tr.append(td);
    }
    if (rowKeyStr && s.selectedKeys.has(rowKeyStr)) tr.classList.add("is-selected");
    if (rowKeyStr && rowKeyStr === s.focusKey) tr.classList.add("is-focused");
    tr.onclick = (e) => {
      if (e.target.closest("button, input, select, .cell-editor")) return;
      s.focusKey = rowKeyStr || null;
      s.focusRow = row;
      for (const r of $("grid").querySelectorAll("tr.is-focused")) r.classList.remove("is-focused");
      if (rowKeyStr) tr.classList.add("is-focused");
    };

    const actions = el("td");
    actions.className = "row-actions";
    const actionsInner = el("div");
    actionsInner.className = "row-actions-inner";
    actions.append(actionsInner);

    // 1. Edit / Open
    const edit = el("button", "Edit");
    edit.onclick = () => openEditor(row);
    actionsInner.append(edit);

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
      actionsInner.append(clone);
    }

    // 3. View JSON
    const jsonBtn = el("button", "JSON");
    jsonBtn.className = "btn-json";
    jsonBtn.title = "View row as JSON";
    jsonBtn.onclick = () => openJsonModal(row);
    actionsInner.append(jsonBtn);

    // 4. Delete
    if (hasPk && s.meta.permissions.delete) {
      const del = el("button", "Delete");
      del.className = "danger-text";
      del.onclick = () => {
        s.deleting = row;
        $("delete-error").textContent = "";
        $("delete-dialog").showModal();
      };
      actionsInner.append(del);
    }

    tr.append(actions);
    body.append(tr);
  }

  table.append(body);
  $("grid").replaceChildren(table);
}

function openJsonModal(rowData) {
  $("json-code").textContent = JSON.stringify(rowData, null, 2);
  $("copy-json").textContent = "Copy";
  $("json-dialog").showModal();
}

$("close-json").onclick = () => $("json-dialog").close();
$("done-json").onclick = () => $("json-dialog").close();

$("copy-json").onclick = async () => {
  try {
    await navigator.clipboard.writeText($("json-code").textContent);
    $("copy-json").textContent = "Copied";
    setTimeout(() => {
      $("copy-json").textContent = "Copy";
    }, 2000);
  } catch {
    $("copy-json").textContent = "Copy failed";
  }
};

function inputFor(c) {
  const list = pickList(c);
  if (list) {
    const select = el("select");
    select.add(new Option("Choose a value…", ""));
    for (const o of list)
      select.add(new Option(o.label && o.label !== o.value ? `${o.label} (${o.value})` : o.value, o.value));
    select.dataset.choice = "true";
    return select;
  }
  if (["json", "jsonb"].includes(c.type) || c.spatial) {
    const t = el("textarea");
    t.rows = 5;
    return t;
  }
  const input = el("input");
  input.type =
    c.type === "bool"
      ? "checkbox"
      : ["int2", "int4", "int8", "numeric", "float4", "float8"].includes(c.type)
        ? "number"
        : c.type === "date"
          ? "date"
          : ["timestamp", "timestamptz"].includes(c.type)
            ? "datetime-local"
            : "text";
  if (input.type === "number")
    input.step = ["int2", "int4", "int8"].includes(c.type) ? "1" : "any";
  if (input.type === "datetime-local") input.step = "any";
  return input;
}

function openEditor(row) {
  s.editing = row;
  s.controls = [];
  $("editor-table").textContent = s.meta.name;
  $("editor-title").textContent = row ? "Edit row" : "Add row";
  $("editor-error").textContent = "";
  $("fields").replaceChildren();
  const writable = row ? s.meta.permissions.update : s.meta.permissions.insert;

  for (let i = 0; i < s.meta.columns.length; i++) {
    const c = s.meta.columns[i],
      f = el("div"),
      head = el("div"),
      label = el("label", c.name),
      type = el("span", c.description);
    f.className = "field";
    head.className = "field-head";
    type.className = "field-type";
    label.htmlFor = "field-" + i;
    head.append(label);
    if (c.pk) head.append(keyTag("PK"));
    if (c.fk) head.append(keyTag("FK"));
    head.append(type);
    const required = !row && !c.nullable && !c.default && !c.identity && !c.generated;
    if (required) {
      const r = el("span", "required");
      r.className = "field-required";
      head.append(r);
    }
    f.append(head);

    const readonly = c.readonly || (row && c.pk) || !writable,
      mode = el("select");
    mode.className = "value-mode";
    mode.setAttribute("aria-label", c.name + " value mode");
    if (row) mode.add(new Option("Keep current", "omit"));
    else if (c.default || c.identity || c.generated)
      mode.add(new Option("Use default", "omit"));
    else if (c.nullable) mode.add(new Option("Leave unset", "omit"));
    mode.add(new Option("Set value", "value"));
    if (c.nullable) mode.add(new Option("NULL", "null"));

    const input = inputFor(c);
    input.id = "field-" + i;
    const value = row?.[c.name];
    if (
      value != null &&
      ["timestamp", "timestamptz", "date"].includes(c.type) &&
      !Number.isFinite(Date.parse(value))
    )
      input.type = "text";
    if (input.type === "checkbox") input.checked = value === "true" || value === "t";
    else if (value != null) {
      if (input.dataset.choice && ![...input.options].some((o) => o.value === value))
        input.add(new Option(value + " (current)", value));
      input.value =
        c.type === "timestamptz" && Number.isFinite(Date.parse(value))
          ? new Date(value).toISOString().slice(0, -1)
          : c.type === "timestamp"
            ? value.replace(" ", "T")
            : value;
    }

    // Editing a value switches the mode to "Set value" automatically.
    const sync = () => {
      input.disabled = readonly || mode.value === "null";
      input.classList.toggle("untouched", mode.value === "omit");
    };
    const touch = () => {
      if (mode.value !== "value" && !readonly) {
        mode.value = "value";
        sync();
      }
    };
    input.addEventListener("input", touch);
    input.addEventListener("change", touch);
    mode.onchange = sync;
    mode.disabled = readonly;
    sync();

    const control = el("div");
    control.className = "field-control";
    control.append(input, mode);
    f.append(control);
    s.controls.push({ c, input, mode });

    if (c.spatial) f.append(el("small", "PostGIS value, read-only here."));
    if (c.type === "timestamptz") f.append(el("small", "Time in UTC."));
    if (c.optionsSource === "check")
      f.append(el("small", "Allowed values come from a CHECK constraint."));

    if (c.fk) {
      f.append(el("small", `References ${c.fk.table}.${c.fk.target}`));
      if (!readonly && !pickList(c) && c.fk.width === 1 && c.fk.schema === "public") {
        const wrap = el("div"),
          search = el("input"),
          results = el("select"),
          status = el("small");
        wrap.className = "field-ref";
        search.type = "search";
        search.placeholder = "Search " + c.fk.table + "…";
        search.setAttribute("aria-label", "Search " + c.name + " references");
        results.setAttribute("aria-label", "Choose " + c.name + " reference");
        results.add(new Option("Type to search", ""));
        let timer,
          version = 0;
        const url = base() + "/references/" + encodeURIComponent(c.name);
        search.oninput = () => {
          clearTimeout(timer);
          const request = ++version;
          timer = setTimeout(async () => {
            try {
              status.textContent = "Searching…";
              const data = await api(url + "?q=" + encodeURIComponent(search.value));
              if (request !== version) return;
              results.replaceChildren(new Option(`${data.options.length} match(es)`, ""));
              for (const o of data.options)
                results.add(new Option(`${o.label ?? o.value} · ${o.value}`, o.value));
              status.textContent = data.options.length
                ? data.options.length >= 30
                  ? "Showing the first 30. Refine your search."
                  : ""
                : "No matching rows.";
            } catch (e) {
              if (request === version) status.textContent = e.message;
            }
          }, 250);
        };
        results.onchange = () => {
          if (results.value) {
            input.value = results.value;
            touch();
          }
        };
        wrap.append(search, results);
        f.append(wrap, status);
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
      if (value === "" && input.dataset.choice)
        throw Error(c.name + ": choose a value from the list.");
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

$("filter-column").onchange = syncFilterControls;
$("filter-op").onchange = syncFilterControls;

$("filter").onsubmit = (e) => {
  e.preventDefault();
  if (!$("filter-column").value) {
    message("Choose a column to filter by.", true);
    $("filter-column").focus();
    return;
  }
  const valueBox = $("filter-value-select").hidden ? $("filter-value") : $("filter-value-select");
  s.filter = {
    column: $("filter-column").value,
    op: $("filter-op").value,
    value: valueBox.value,
  };
  $("reset").hidden = false;
  s.page = 1;
  load();
};

$("reset").onclick = () => {
  s.filter = {};
  s.page = 1;
  $("filter-column").value = "";
  $("filter-value").value = "";
  $("reset").hidden = true;
  syncFilterControls();
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
  $("sql-history").replaceChildren(new Option("History…", ""));
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
  const tName = s.meta ? `"${s.meta.name}"` : `"table_name"`;
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
      $("sql-success-banner").textContent = `Query executed: ${result.command || "COMMAND OK"} (${result.rowCount ?? 0} affected in ${result.durationMs}ms)`;
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
  if (
    e.key === "Delete" &&
    s.activeTab === "table" &&
    !document.querySelector("dialog[open]") &&
    !e.target.closest("input, textarea, select")
  ) {
    e.preventDefault();
    askDelete();
    return;
  }
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
    $("tables-badge").textContent = String(s.tables.length);
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
