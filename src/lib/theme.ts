// Appearance (System / Light / Dark). Stored per PC in the webview's
// localStorage, which the main and Quick Entry windows share.
export type ThemePref = "system" | "light" | "dark";

const KEY = "cairn.theme";
const media = typeof window !== "undefined" && window.matchMedia ? window.matchMedia("(prefers-color-scheme: dark)") : null;

export function getThemePref(): ThemePref {
  try {
    const v = localStorage.getItem(KEY);
    if (v === "light" || v === "dark") return v;
  } catch {
    /* storage unavailable */
  }
  return "system";
}

function apply() {
  const pref = getThemePref();
  const dark = pref === "dark" || (pref === "system" && !!media?.matches);
  document.documentElement.dataset.theme = dark ? "dark" : "light";
}

export function setThemePref(pref: ThemePref) {
  try {
    if (pref === "system") localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, pref);
  } catch {
    /* storage unavailable */
  }
  apply();
}

export function initTheme() {
  apply();
  media?.addEventListener("change", apply);
  // Another window changed the preference.
  window.addEventListener("storage", (e) => e.key === KEY && apply());
}
