const RESET = "\x1B[0m";

export const ansi = {
  reset: RESET,
  bold: "\x1B[1m",
  dim: "\x1B[2m",
};

const THEMES = {
  "tokyo-night": {
    label: "tokyo-night    Balanced blue terminal theme",
    roles: {
      prompt: { fg: "#7aa2f7" },
      title: { fg: "#7dcfff", effect: "bold" },
      heading: { fg: "#7dcfff", effect: "bold" },
      muted: { fg: "#565f89" },
      bullet: { fg: "#9ece6a" },
      inlineCode: { fg: "#e0af68" },
      keyword: { fg: "#7dcfff" },
      string: { fg: "#9ece6a" },
      literal: { fg: "#e0af68" },
      selected: { fg: "#c0caf5", bg: "#3b4261" },
      match: { fg: "#1a1b26", bg: "#e0af68", effect: "bold" },
      action: { fg: "#1a1b26", bg: "#e0af68", effect: "bold" },
      diffAdd: { fg: "#1a1b26", bg: "#9ece6a" },
      diffDelete: { fg: "#ffffff", bg: "#f7768e" },
      success: { fg: "#9ece6a" },
      warning: { fg: "#e0af68" },
      error: { fg: "#f7768e" },
    },
  },
  gruvbox: {
    label: "gruvbox        Warm low-glare retro theme",
    roles: {
      prompt: { fg: "#83a598" },
      title: { fg: "#fabd2f", effect: "bold" },
      heading: { fg: "#fabd2f", effect: "bold" },
      muted: { fg: "#928374" },
      bullet: { fg: "#b8bb26" },
      inlineCode: { fg: "#fe8019" },
      keyword: { fg: "#83a598" },
      string: { fg: "#b8bb26" },
      literal: { fg: "#fabd2f" },
      selected: { fg: "#fbf1c7", bg: "#504945" },
      match: { fg: "#282828", bg: "#fabd2f", effect: "bold" },
      action: { fg: "#282828", bg: "#fabd2f", effect: "bold" },
      diffAdd: { fg: "#282828", bg: "#b8bb26" },
      diffDelete: { fg: "#fbf1c7", bg: "#cc241d" },
      success: { fg: "#b8bb26" },
      warning: { fg: "#fabd2f" },
      error: { fg: "#fb4934" },
    },
  },
  catppuccin: {
    label: "catppuccin     Soft pastel theme",
    roles: {
      prompt: { fg: "#89b4fa" },
      title: { fg: "#89dceb", effect: "bold" },
      heading: { fg: "#89dceb", effect: "bold" },
      muted: { fg: "#6c7086" },
      bullet: { fg: "#a6e3a1" },
      inlineCode: { fg: "#f9e2af" },
      keyword: { fg: "#89dceb" },
      string: { fg: "#a6e3a1" },
      literal: { fg: "#f9e2af" },
      selected: { fg: "#cdd6f4", bg: "#45475a" },
      match: { fg: "#1e1e2e", bg: "#f9e2af", effect: "bold" },
      action: { fg: "#1e1e2e", bg: "#f9e2af", effect: "bold" },
      diffAdd: { fg: "#1e1e2e", bg: "#a6e3a1" },
      diffDelete: { fg: "#1e1e2e", bg: "#f38ba8" },
      success: { fg: "#a6e3a1" },
      warning: { fg: "#f9e2af" },
      error: { fg: "#f38ba8" },
    },
  },
  starship: {
    label: "starship       Bright segmented prompt colors",
    roles: {
      prompt: { fg: "#00afff" },
      title: { fg: "#5fd7ff", effect: "bold" },
      heading: { fg: "#5fd7ff", effect: "bold" },
      muted: { fg: "#6c7891" },
      bullet: { fg: "#5fff87" },
      inlineCode: { fg: "#ffaf00" },
      keyword: { fg: "#5fd7ff" },
      string: { fg: "#5fff87" },
      literal: { fg: "#ffaf00" },
      selected: { fg: "#ffffff", bg: "#005f87" },
      match: { fg: "#111111", bg: "#ffaf00", effect: "bold" },
      action: { fg: "#111111", bg: "#ffaf00", effect: "bold" },
      diffAdd: { fg: "#111111", bg: "#5fff87" },
      diffDelete: { fg: "#ffffff", bg: "#d7005f" },
      success: { fg: "#5fff87" },
      warning: { fg: "#ffaf00" },
      error: { fg: "#ff5f87" },
    },
  },
  "neon-edge": {
    label: "neon-edge      Sharp high-contrast neon theme",
    roles: {
      prompt: { fg: "#00e5ff" },
      title: { fg: "#00e5ff", effect: "bold" },
      heading: { fg: "#2f7bff", effect: "bold" },
      muted: { fg: "#8a96b8" },
      bullet: { fg: "#a3ff12" },
      inlineCode: { fg: "#ffd400" },
      keyword: { fg: "#ff3df2" },
      string: { fg: "#39ff88" },
      literal: { fg: "#ffb000" },
      selected: { fg: "#ffffff", bg: "#004cff" },
      match: { fg: "#05070d", bg: "#ffd400", effect: "bold" },
      action: { fg: "#05070d", bg: "#00e5ff", effect: "bold" },
      diffAdd: { fg: "#05070d", bg: "#a3ff12" },
      diffDelete: { fg: "#ffffff", bg: "#ff1744" },
      success: { fg: "#39ff88" },
      warning: { fg: "#ffd400" },
      error: { fg: "#ff1744" },
    },
  },
  "mono-focus": {
    label: "mono-focus     Quiet grayscale with focused accents",
    roles: {
      prompt: { fg: "#8ab4f8" },
      title: { fg: "#d8dee9", effect: "bold" },
      heading: { fg: "#d8dee9", effect: "bold" },
      muted: { fg: "#6b7280" },
      bullet: { fg: "#9ca3af" },
      inlineCode: { fg: "#e5e7eb" },
      keyword: { fg: "#93c5fd" },
      string: { fg: "#d1d5db" },
      literal: { fg: "#fcd34d" },
      selected: { fg: "#f9fafb", bg: "#374151" },
      match: { fg: "#111827", bg: "#fcd34d", effect: "bold" },
      action: { fg: "#111827", bg: "#fcd34d", effect: "bold" },
      diffAdd: { fg: "#052e16", bg: "#86efac" },
      diffDelete: { fg: "#ffffff", bg: "#b91c1c" },
      success: { fg: "#86efac" },
      warning: { fg: "#fcd34d" },
      error: { fg: "#fca5a5" },
    },
  },
};

let currentThemeName = "tokyo-night";

export function setTheme(name) {
  const normalized = normalizeThemeName(name);
  if (!THEMES[normalized]) {
    currentThemeName = "tokyo-night";
    return currentThemeName;
  }
  currentThemeName = normalized;
  return currentThemeName;
}

export function getThemeName() {
  return currentThemeName;
}

export function listThemes() {
  return Object.entries(THEMES).map(([name, theme]) => ({
    name,
    label: theme.label,
  }));
}

export function paint(roleName, text) {
  return `${styleStart(roleName)}${text}${RESET}`;
}

export function paintFixed(style, text) {
  return `${styleFrom(style)}${text}${RESET}`;
}

export function styleStart(roleName) {
  const role = THEMES[currentThemeName].roles[roleName] ?? {};
  return styleFrom(role);
}

export function styleFrom(style) {
  return [effectCode(style.effect), style.fg ? fg(style.fg) : "", style.bg ? bg(style.bg) : ""].join("");
}

function normalizeThemeName(value) {
  return String(value ?? "").trim().toLowerCase() || "tokyo-night";
}

function effectCode(effect) {
  if (effect === "bold") return ansi.bold;
  if (effect === "dim") return ansi.dim;
  return "";
}

function fg(hex) {
  const [r, g, b] = rgb(hex);
  return `\x1B[38;2;${r};${g};${b}m`;
}

function bg(hex) {
  const [r, g, b] = rgb(hex);
  return `\x1B[48;2;${r};${g};${b}m`;
}

function rgb(hex) {
  const value = hex.replace("#", "");
  return [
    Number.parseInt(value.slice(0, 2), 16),
    Number.parseInt(value.slice(2, 4), 16),
    Number.parseInt(value.slice(4, 6), 16),
  ];
}
