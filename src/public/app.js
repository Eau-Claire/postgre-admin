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
};
const base = () => "/api/tables/" + encodeURIComponent(s.meta.name);
async function api(url, opts = {}) {
  const r = await fetch(url, {
    ...opts,
    headers: { "Content-Type": "application/json", "X-CSRF-Token": s.csrf },
  });
  if (r.status === 401) {
    location.href = "/login";
    throw Error("Session expired");
  }
  const data = await r.json();
  if (!r.ok) throw Error(data.error || "Request failed");
  return data;
}
function message(text, error = false) {
  $("message").textContent = text;
  $("message").className = error ? "error" : "muted";
}
function sidebar() {
  $("tables").replaceChildren();
  for (const t of s.tables.filter((t) =>
    t.name.toLowerCase().includes($("table-search").value.toLowerCase()),
  )) {
    const b = el("button", "▦  " + t.name);
    b.className = s.meta?.name === t.name ? "active" : "";
    b.onclick = () => selectTable(t.name);
    $("tables").append(b);
  }
}
async function selectTable(name) {
  const generation = ++s.generation;
  s.meta = null;
  s.rows = [];
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
      meta.columns.length + " columns · public schema";
    $("add").disabled = !meta.permissions.insert;
    $("filter-column").replaceChildren(new Option("All rows", ""));
    for (const c of meta.columns)
      $("filter-column").add(new Option(c.name, c.name));
    $("filter-value").value = "";
    $("notice").hidden = false;
    $("notice").textContent = meta.columns.some((c) => c.pk)
      ? "Direct changes apply immediately and bypass application validation."
      : "No primary key: update/delete unavailable; page order may vary.";
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
function render() {
  if (!s.meta) return;
  const table = el("table"),
    head = el("thead"),
    tr = el("tr"),
    columns = s.meta.columns.filter((c) => !s.hidden.has(c.name));
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
    for (const c of columns) {
      const td = el("td", row[c.name] ?? "NULL");
      if (row[c.name] === null) td.className = "null";
      td.title = row[c.name] ?? "NULL";
      tr.append(td);
    }
    const actions = el("td");
    actions.className = "row-actions";
    const edit = el("button", "Open");
    edit.onclick = () => openEditor(row);
    actions.append(edit);
    if (s.meta.columns.some((c) => c.pk) && s.meta.permissions.delete) {
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
const key = (row) =>
  Object.fromEntries(
    s.meta.columns.filter((c) => c.pk).map((c) => [c.name, row[c.name]]),
  );
function openEditor(row = null) {
  s.editing = row;
  s.controls = [];
  $("editor-title").textContent =
    (row ? "Edit row" : "Add row") + " · " + s.meta.name;
  $("editor-error").textContent = "";
  $("fields").replaceChildren();
  const writable =
    !row || (s.meta.permissions.update && s.meta.columns.some((c) => c.pk));
  $("save").disabled = !writable;
  for (const [i, c] of s.meta.columns.entries()) {
    const f = el("section"),
      label = el("label", c.name + (c.pk ? " · primary key" : ""));
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
        el(
          "small",
          "Time in UTC. Keep current value preserves full precision.",
        ),
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
for (const id of ["editor", "delete-dialog"])
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
  } catch (e) {
    $("delete-error").textContent = e.message;
  } finally {
    s.busy = false;
    $("confirm-delete").disabled = false;
  }
};
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
(async () => {
  try {
    const d = await api("/api/tables");
    s.csrf = d.csrf;
    s.tables = d.tables;
    sidebar();
    const requested = decodeURIComponent(location.pathname.split("/")[2] || "");
    if (s.tables.length)
      await selectTable(
        s.tables.some((t) => t.name === requested)
          ? requested
          : s.tables[0].name,
      );
    else message("No accessible public tables.");
  } catch (e) {
    message(e.message, true);
  }
})();
