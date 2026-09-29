#!/usr/bin/env node
/**
 * Generates the README's SVG assets: logo (light/dark), capability icons, and
 * the download benchmark chart (light/dark). Run: node scripts/readme-assets.mjs
 *
 * The chart numbers are the measured `.88` netem lab results recorded in
 * PLAN.MD P1-06b (50 ms / 1 Gbps, 128 MiB, median of 3, SHA-256 verified).
 * Update them there first, then here.
 *
 * Colors: categorical slots 1-2 of the dataviz reference palette, validated
 * against GitHub's light (#ffffff) and dark (#0d1117) surfaces.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = (rel, svg) => {
  const file = path.join(root, "images", rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, svg.trim() + "\n");
  console.log("wrote", path.relative(root, file));
};

const FONT = "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'Noto Sans', Helvetica, Arial, sans-serif";
const MONO = "ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, monospace";

const THEMES = {
  light: {
    text: "#1f2328", secondary: "#59636e", grid: "#d1d9e0", baseline: "#818b98",
    first: "#2a78d6", repeat: "#eb6834",
  },
  dark: {
    text: "#e6edf3", secondary: "#9198a1", grid: "#3d444d", baseline: "#656c76",
    first: "#3987e5", repeat: "#d95926",
  },
};

// ---------------------------------------------------------------------------
// Logo: a terminal tile whose prompt is "released" -- the cursor floats free
// of the prompt line, with signal arcs to a remote host. Wordmark beside it.
// ---------------------------------------------------------------------------
function logo(theme) {
  const t = THEMES[theme];
  return `
<svg xmlns="http://www.w3.org/2000/svg" width="360" height="96" viewBox="0 0 360 96" role="img" aria-label="Handfree">
  <defs>
    <linearGradient id="tile" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#2a78d6"/>
      <stop offset="1" stop-color="#1baf7a"/>
    </linearGradient>
  </defs>
  <rect x="4" y="4" width="88" height="88" rx="22" fill="url(#tile)"/>
  <path d="M24 36 L40 48 L24 60" fill="none" stroke="#ffffff" stroke-width="7" stroke-linecap="round" stroke-linejoin="round"/>
  <rect x="48" y="58" width="22" height="7" rx="3.5" fill="#ffffff"/>
  <path d="M60 30 a14 14 0 0 1 14 14" fill="none" stroke="#ffffff" stroke-width="5" stroke-linecap="round" opacity="0.95"/>
  <path d="M60 18 a26 26 0 0 1 26 26" fill="none" stroke="#ffffff" stroke-width="5" stroke-linecap="round" opacity="0.6"/>
  <circle cx="61" cy="43" r="4.5" fill="#ffffff"/>
  <text x="112" y="62" font-family="${FONT}" font-size="44" font-weight="700" fill="${t.text}" letter-spacing="-0.5">Handfree</text>
</svg>`;
}

// ---------------------------------------------------------------------------
// Capability icons: 24px grid, 2px round strokes, one blue that clears 3:1 on
// both GitHub surfaces.
// ---------------------------------------------------------------------------
const ICON_COLOR = "#3987e5";
const icon = (body) => `
<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="${ICON_COLOR}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
${body}
</svg>`;
const ICONS = {
  // plug into a socket
  connect: `<path d="M9 2v5M15 2v5"/><path d="M6 7h12v4a6 6 0 0 1-12 0z"/><path d="M12 17v5"/>`,
  // terminal window with prompt
  execute: `<rect x="2.5" y="4" width="19" height="16" rx="3"/><path d="M7 10l3 2.5L7 15"/><path d="M12.5 15H17"/>`,
  // opposing arrows
  transfer: `<path d="M7 20V5"/><path d="M3.5 8.5L7 5l3.5 3.5"/><path d="M17 4v15"/><path d="M13.5 15.5L17 19l3.5-3.5"/>`,
  // play inside a circle
  run: `<circle cx="12" cy="12" r="9.5"/><path d="M10 8.5v7l5.5-3.5z"/>`,
  // two chasing arcs
  sync: `<path d="M20 11a8 8 0 0 0-14.3-4.3L4 8.5"/><path d="M4 4v4.5h4.5"/><path d="M4 13a8 8 0 0 0 14.3 4.3L20 15.5"/><path d="M20 20v-4.5h-4.5"/>`,
  // browser window with panels
  webui: `<rect x="2.5" y="3.5" width="19" height="17" rx="3"/><path d="M2.5 8.5h19"/><path d="M9 8.5v12"/><circle cx="5.5" cy="6" r="0.6" fill="${ICON_COLOR}"/><circle cx="7.8" cy="6" r="0.6" fill="${ICON_COLOR}"/>`,
};

// ---------------------------------------------------------------------------
// Chart: single-file download throughput, first call vs repeat call.
// Horizontal bars (long category labels), one axis, values at the bar tips.
// ---------------------------------------------------------------------------
const ROWS = [
  { label: "1 connection", baseline: 17.5 },
  { label: "2 connections", first: 28.5, repeat: 35.2 },
  { label: "4 connections", first: 45.6, repeat: 63.2 },
  { label: "8 connections", first: 53.8, repeat: 82.8 },
];

function chart(theme) {
  const t = THEMES[theme];
  const W = 720, left = 128, right = 56, top = 92, bar = 16, gap = 2, rowGap = 22;
  const max = 90, plotW = W - left - right;
  const x = (v) => left + (v / max) * plotW;
  const rowH = (r) => (r.baseline !== undefined ? bar : bar * 2 + gap);
  const H = top + ROWS.reduce((s, r) => s + rowH(r) + rowGap, 0) + 28;
  const plotBottom = H - 34;

  // Bar with a 4px rounded data-end, square at the baseline.
  const barPath = (y, v, fill) => {
    const x0 = left, x1 = x(v), r = 4;
    return `<path d="M${x0} ${y} H${x1 - r} a${r} ${r} 0 0 1 ${r} ${r} V${y + bar - r} a${r} ${r} 0 0 1 -${r} ${r} H${x0} Z" fill="${fill}"/>`;
  };
  const value = (y, v) =>
    `<text x="${x(v) + 8}" y="${y + bar / 2 + 4.5}" font-family="${FONT}" font-size="13" fill="${t.text}">${v.toFixed(1)}</text>`;

  const parts = [];
  for (const tick of [0, 20, 40, 60, 80]) {
    parts.push(`<line x1="${x(tick)}" y1="${top - 8}" x2="${x(tick)}" y2="${plotBottom}" stroke="${t.grid}" stroke-width="1"/>`);
    parts.push(`<text x="${x(tick)}" y="${plotBottom + 18}" text-anchor="middle" font-family="${FONT}" font-size="12" fill="${t.secondary}">${tick}</text>`);
  }
  let y = top;
  for (const r of ROWS) {
    const h = rowH(r);
    parts.push(`<text x="${left - 12}" y="${y + h / 2 + 4.5}" text-anchor="end" font-family="${FONT}" font-size="13" fill="${t.text}">${r.label}</text>`);
    if (r.baseline !== undefined) {
      parts.push(barPath(y, r.baseline, t.baseline), value(y, r.baseline));
    } else {
      parts.push(barPath(y, r.first, t.first), value(y, r.first));
      parts.push(barPath(y + bar + gap, r.repeat, t.repeat), value(y + bar + gap, r.repeat));
    }
    y += h + rowGap;
  }

  const legend = (lx, color, text) =>
    `<rect x="${lx}" y="58" width="12" height="12" rx="3" fill="${color}"/>` +
    `<text x="${lx + 18}" y="68.5" font-family="${FONT}" font-size="13" fill="${t.secondary}">${text}</text>`;

  return `
<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img"
  aria-label="Single-file download throughput in MiB/s over a 50 ms, 1 Gbps link. One connection: 17.5. Two connections: 28.5 on the first call, 35.2 on a repeat call. Four: 45.6 and 63.2. Eight: 53.8 and 82.8.">
  <text x="0" y="22" font-family="${FONT}" font-size="17" font-weight="600" fill="${t.text}">Single-file download, 128 MiB over a 50 ms / 1 Gbps link</text>
  <text x="0" y="44" font-family="${FONT}" font-size="13" fill="${t.secondary}">MiB/s · median of 3 runs · SHA-256 verified every run</text>
  ${legend(0, t.baseline, "Single connection")}
  ${legend(150, t.first, "First call (handshakes included)")}
  ${legend(378, t.repeat, "Repeat call (pooled connections)")}
  ${parts.join("\n  ")}
  <text x="${left + plotW}" y="${plotBottom + 18}" text-anchor="end" font-family="${FONT}" font-size="12" fill="${t.secondary}" dx="44">MiB/s</text>
</svg>`;
}

for (const theme of ["light", "dark"]) {
  out(`brand/logo-${theme}.svg`, logo(theme));
  out(`charts/download-${theme}.svg`, chart(theme));
}
for (const [name, body] of Object.entries(ICONS)) {
  out(`icons/${name}.svg`, icon(body));
}
