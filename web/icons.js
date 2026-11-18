// One style for every icon: 24px grid, 2.2 stroke in currentColor, round caps and joins.
const ICONS = {
  pin: ["M9 3h6v6l3 4H6l3-4V3z", "M12 17v4"],
  shuffle: ["M16 3h5v5", "M4 20L21 3", "M21 16v5h-5", "M15 15l6 6", "M4 4l5 5"],
  repeat: ["M17 2l4 4-4 4", "M3 11v-1a4 4 0 0 1 4-4h14", "M7 22l-4-4 4-4", "M21 13v1a4 4 0 0 1-4 4H3"],
  dice: ["M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z", "M8 8h.01", "M16 16h.01", "M12 12h.01"],
  history: ["M3 12a9 9 0 1 0 3-6.7L3 8", "M3 3v5h5", "M12 7v5l3 2"],
  minus: ["M5 12h14"],
  plus: ["M12 5v14", "M5 12h14"],
  trash: ["M3 6h18", "M8 6V4h8v2", "M19 6l-1 14H6L5 6", "M10 11v6", "M14 11v6"],
  prev: ["M15 18l-6-6 6-6"],
  next: ["M9 18l6-6-6-6"],
  up: ["M6 15l6-6 6 6"],
  down: ["M6 9l6 6 6-6"],
  external: ["M14 4h6v6", "M20 4l-9 9", "M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"],
  link: ["M10 14a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1", "M14 10a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1"],
  eject: ["M12 4l8 10H4z", "M4 19h16"],
  refresh: ["M21 12a9 9 0 1 1-3-6.7L21 8", "M21 3v5h-5"],
  goto: ["M5 12h14", "M13 6l6 6-6 6"],
  settings: ["M4 6h9", "M17 6h3", "M13 4v4", "M4 12h3", "M11 12h9", "M7 10v4", "M4 18h9", "M17 18h3", "M13 16v4"],
};

export function glyph(name) {
  if (!ICONS[name]) return document.createTextNode(name);
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", "14");
  svg.setAttribute("height", "14");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "2.2");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  for (const d of ICONS[name]) {
    const path = document.createElementNS(svg.namespaceURI, "path");
    path.setAttribute("d", d);
    svg.append(path);
  }
  return svg;
}
