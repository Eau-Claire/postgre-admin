"use strict";

// Loaded synchronously in <head> so the saved theme applies before first paint.
(() => {
  const KEY = "uavpms_theme";
  const LABELS = { auto: "Theme: Auto", light: "Theme: Light", dark: "Theme: Dark" };
  const root = document.documentElement;

  const read = () => {
    try {
      const v = localStorage.getItem(KEY);
      return v === "light" || v === "dark" ? v : "auto";
    } catch {
      return "auto";
    }
  };

  const apply = (mode) => {
    if (mode === "auto") delete root.dataset.theme;
    else root.dataset.theme = mode;
    for (const b of document.querySelectorAll("[data-theme-toggle]"))
      b.textContent = LABELS[mode];
  };

  const cycle = () => {
    const next = { auto: "light", light: "dark", dark: "auto" }[read()];
    try {
      if (next === "auto") localStorage.removeItem(KEY);
      else localStorage.setItem(KEY, next);
    } catch {}
    apply(next);
  };

  apply(read());
  document.addEventListener("DOMContentLoaded", () => {
    for (const b of document.querySelectorAll("[data-theme-toggle]")) b.onclick = cycle;
    apply(read());
  });
})();
