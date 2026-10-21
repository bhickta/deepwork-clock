/**
 * Inline vector control icons.
 *
 * Every icon is drawn with DOM SVG elements from a fixed set of path data, so
 * nothing is fetched from the network and no markup is parsed from a string.
 * Icons are decorative: the accessible name always lives on the control.
 */

const SVG_NS = "http://www.w3.org/2000/svg";

type Primitive =
  | { kind: "path"; d: string; fill?: boolean }
  | { kind: "circle"; cx: number | string; cy: number | string; r: number | string; fill?: boolean }
  | { kind: "line"; x1: number | string; y1: number | string; x2: number | string; y2: number | string }
  | {
      kind: "rect";
      x: number | string;
      y: number | string;
      width: number | string;
      height: number | string;
      rx?: number | string;
      ry?: number | string;
      fill?: boolean;
    };

const ICONS: Readonly<Record<string, readonly Primitive[]>> = {
  play: [{ kind: "path", d: "M8 5.2v13.6L19 12 8 5.2z", fill: true }],
  pause: [
    { kind: "rect", x: "8", y: "5", width: "3", height: "14", fill: true },
    { kind: "rect", x: "13", y: "5", width: "3", height: "14", fill: true }
  ],
  reset: [
    { kind: "path", d: "M4 12a8 8 0 1 0 8-8 8 8 0 0 0-6 2.7L4 8.7" },
    { kind: "path", d: "M4 4v4.7h4.7" }
  ],
  next: [
    { kind: "path", d: "M6 5.5v13l9-6.5-9-6.5z", fill: true },
    { kind: "line", x1: "18", y1: "5.5", x2: "18", y2: "18.5" }
  ],
  settings: [
    { kind: "line", x1: "4", y1: "7", x2: "20", y2: "7" },
    { kind: "line", x1: "4", y1: "12", x2: "20", y2: "12" },
    { kind: "line", x1: "4", y1: "17", x2: "20", y2: "17" },
    { kind: "circle", cx: "9", cy: "7", r: "2.2" },
    { kind: "circle", cx: "15", cy: "12", r: "2.2" },
    { kind: "circle", cx: "8", cy: "17", r: "2.2" }
  ],
  pin: [
    { kind: "path", d: "M9.5 3h5l-.8 5.4 2.8 3.6H7.5l2.8-3.6L9.5 3z" },
    { kind: "line", x1: "12", y1: "12", x2: "12", y2: "21" }
  ],
  help: [
    { kind: "circle", cx: "12", cy: "12", r: "9" },
    { kind: "path", d: "M9.4 9.6a2.7 2.7 0 1 1 3.3 2.6c-.7.3-.7.9-.7 1.5" },
    { kind: "circle", cx: "12", cy: "17", r: "1", fill: true }
  ],
  about: [
    { kind: "circle", cx: "12", cy: "12", r: "9" },
    { kind: "line", x1: "12", y1: "11", x2: "12", y2: "16.5" },
    { kind: "circle", cx: "12", cy: "7.6", r: "1", fill: true }
  ],
  compact: [
    { kind: "path", d: "M9 4v5H4" },
    { kind: "path", d: "M15 4v5h5" },
    { kind: "path", d: "M15 20v-5h5" },
    { kind: "path", d: "M9 20v-5H4" }
  ],
  /** Two overlapping frames: the compact window that stays above others. */
  float: [
    { kind: "rect", x: "4", y: "4", width: "12", height: "10", rx: "2.5", ry: "2.5" },
    { kind: "rect", x: "8", y: "10", width: "12", height: "10", rx: "2.5", ry: "2.5" }
  ],
  expand: [
    { kind: "path", d: "M4 9V4h5" },
    { kind: "path", d: "M15 4h5v5" },
    { kind: "path", d: "M20 15v5h-5" },
    { kind: "path", d: "M9 20H4v-5" }
  ],
  close: [
    { kind: "line", x1: "6", y1: "6", x2: "18", y2: "18" },
    { kind: "line", x1: "18", y1: "6", x2: "6", y2: "18" }
  ],
  download: [
    { kind: "path", d: "M12 4v10" },
    { kind: "path", d: "M8 11l4 4 4-4" },
    { kind: "path", d: "M5 19h14" }
  ],
  trash: [
    { kind: "path", d: "M4 7h16" },
    { kind: "path", d: "M10 4h4" },
    { kind: "path", d: "M6.5 7l1 13h9l1-13" }
  ],
  check: [{ kind: "path", d: "M5 13l4 4 10-10" }],
  clock: [
    { kind: "circle", cx: "12", cy: "12", r: "9" },
    { kind: "path", d: "M12 7v5.2l3.2 2" }
  ],
  history: [
    { kind: "line", x1: "9", y1: "7", x2: "20", y2: "7" },
    { kind: "line", x1: "9", y1: "12", x2: "20", y2: "12" },
    { kind: "line", x1: "9", y1: "17", x2: "20", y2: "17" },
    { kind: "circle", cx: "5", cy: "7", r: "1.3", fill: true },
    { kind: "circle", cx: "5", cy: "12", r: "1.3", fill: true },
    { kind: "circle", cx: "5", cy: "17", r: "1.3", fill: true }
  ],
  bell: [
    { kind: "path", d: "M6 9.5a6 6 0 1 1 12 0c0 4.5 2 5.5 2 5.5H4s2-1 2-5.5" },
    { kind: "path", d: "M10 18.5a2 2 0 0 0 4 0" }
  ],
  warning: [
    { kind: "path", d: "M12 4.5 21 19.5H3L12 4.5z" },
    { kind: "line", x1: "12", y1: "10", x2: "12", y2: "14.5" },
    { kind: "circle", cx: "12", cy: "17", r: "1", fill: true }
  ],
  volume: [
    { kind: "path", d: "M11 5.5L6.5 9.5H3.5v5h3l4.5 4z" },
    { kind: "path", d: "M15.2 9.2a4 4 0 0 1 0 5.6" }
  ],
  chevron: [{ kind: "path", d: "M6 9.5l6 6 6-6" }],
  menu: [
    { kind: "line", x1: "5", y1: "7", x2: "19", y2: "7" },
    { kind: "line", x1: "5", y1: "12", x2: "19", y2: "12" },
    { kind: "line", x1: "5", y1: "17", x2: "19", y2: "17" }
  ],
  keyboard: [
    { kind: "rect", x: "2.5", y: "6", width: "19", height: "12" },
    { kind: "line", x1: "6", y1: "10", x2: "6", y2: "10" },
    { kind: "line", x1: "9.5", y1: "10", x2: "9.5", y2: "10" },
    { kind: "line", x1: "13", y1: "10", x2: "13", y2: "10" },
    { kind: "line", x1: "16.5", y1: "10", x2: "16.5", y2: "10" },
    { kind: "line", x1: "7.5", y1: "14", x2: "16.5", y2: "14" }
  ]
};

export type IconName = keyof typeof ICONS;

/** True when the requested icon exists. */
export function hasIcon(name: string): name is IconName {
  return Object.prototype.hasOwnProperty.call(ICONS, name);
}

/**
 * Build an inline SVG icon.
 *
 * The icon is hidden from assistive technology; the surrounding control owns
 * the accessible name.
 */
export function createIcon(name: IconName, size = 20): SVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.75");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  svg.classList.add("icon");

  const primitives = ICONS[name] ?? ICONS["clock"];
  for (const primitive of primitives) {
    const node = document.createElementNS(SVG_NS, primitive.kind);
    node.setAttribute("fill", primitive.kind === "line" ? "none" : "currentColor");
    if (primitive.kind === "path") {
      node.setAttribute("d", primitive.d);
      node.setAttribute("stroke", primitive.fill === true ? "none" : "currentColor");
    } else if (primitive.kind === "circle") {
      node.setAttribute("cx", String(primitive.cx));
      node.setAttribute("cy", String(primitive.cy));
      node.setAttribute("r", String(primitive.r));
      node.setAttribute("stroke", primitive.fill === true ? "none" : "currentColor");
    } else if (primitive.kind === "line") {
      node.setAttribute("x1", String(primitive.x1));
      node.setAttribute("y1", String(primitive.y1));
      node.setAttribute("x2", String(primitive.x2));
      node.setAttribute("y2", String(primitive.y2));
    } else {
      node.setAttribute("x", String(primitive.x));
      node.setAttribute("y", String(primitive.y));
      node.setAttribute("width", String(primitive.width));
      node.setAttribute("height", String(primitive.height));
      if (primitive.rx !== undefined) {
        node.setAttribute("rx", String(primitive.rx));
      }
      if (primitive.ry !== undefined) {
        node.setAttribute("ry", String(primitive.ry));
      }
      // A filled rectangle keeps the behaviour of the pause glyph; an
      // outlined one uses the same currentColor stroke as the paths.
      node.setAttribute("fill", primitive.fill === true ? "currentColor" : "none");
      node.setAttribute("stroke", primitive.fill === true ? "none" : "currentColor");
    }
    svg.appendChild(node);
  }
  return svg;
}

/** Replace the icon inside a container without touching the container itself. */
export function setIcon(container: HTMLElement, name: IconName, size = 20): void {
  container.textContent = "";
  container.appendChild(createIcon(name, size));
}
