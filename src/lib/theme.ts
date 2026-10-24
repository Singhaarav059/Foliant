// The colour theme: the device's setting, or light or dark chosen in the
// header (src/components/ThemeMenu.tsx). A choice is kept in localStorage and
// shows as data-theme on <html>, which globals.css reads.

export type Theme = "system" | "light" | "dark";
export const THEMES: Theme[] = ["system", "light", "dark"];
export const THEME_KEY = "theme";

// The browser bar colour for each theme, matching --bg.
export const THEME_COLOR = { light: "#f3f0e8", dark: "#110f0c" } as const;

// Runs in <head> before the first paint, so a chosen theme never flashes the
// other one. Plain ES5, wrapped in try: storage can be blocked.
export const THEME_SCRIPT = `try{var t=localStorage.getItem("${THEME_KEY}");if(t==="light"||t==="dark"){document.documentElement.dataset.theme=t;document.querySelectorAll('meta[name="theme-color"]').forEach(function(m){m.content=t==="dark"?"${THEME_COLOR.dark}":"${THEME_COLOR.light}"})}}catch(e){}`;
