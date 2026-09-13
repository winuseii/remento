// A minimal line-icon set, in the Lucide idiom: 24×24 grid, 1.5 stroke,
// round caps and joins, currentColor. Inlined rather than fetched — an icon
// package would be a new dependency and a network round trip for eighteen
// paths totalling under 3 KB.
//
// Icons are never decorative here. Every one of these is either the whole
// affordance of a control or the only thing distinguishing two rows.

const PATHS = {
  // navigation
  drill:    'M4 5h10M4 12h16M4 19h7',
  browse:   'M3 5h18M3 12h18M3 19h18M8 5v14',
  import:   'M12 3v12m0 0 4-4m-4 4-4-4M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2',
  stats:    'M4 20V10M10 20V4M16 20v-6M22 20H2',
  settings: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-2.9 1.2v.2a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.6 1.7 1.7 0 0 0-1.9.4l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0-1.2-2.9h-.2a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.6-1.1 1.7 1.7 0 0 0-.4-1.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.9.3h.1A1.7 1.7 0 0 0 10 3.1V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 2-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.9v.1a1.7 1.7 0 0 0 1.6 1H23a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z',
  subject:  'M4 19.5A2.5 2.5 0 0 1 6.5 17H20M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2Z',

  // actions
  search:   'M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16ZM21 21l-4.3-4.3',
  edit:     'M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7M18.5 2.5a2.1 2.1 0 0 1 3 3L12 15l-4 1 1-4Z',
  close:    'M18 6 6 18M6 6l12 12',
  plus:     'M12 5v14M5 12h14',
  filter:   'M3 5h18l-7 8v6l-4-2v-4Z',
  trash:    'M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6',
  restore:  'M3 12a9 9 0 1 0 3-6.7L3 8M3 3v5h5',
  star:     'm12 3 2.9 5.8 6.1.9-4.5 4.3 1.1 6.1L12 17.2 6.4 20.1l1.1-6.1L3 9.7l6.1-.9Z',
  chevron:  'm9 6 6 6-6 6',
  down:     'm6 9 6 6 6-6',
  check:    'm20 6-11 11-5-5',
  alert:    'M12 9v4m0 4h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z',
  command:  'M15 6v12a3 3 0 1 0 3-3H6a3 3 0 1 0 3 3V6a3 3 0 1 0-3 3h12a3 3 0 1 0-3-3Z',
  menu:     'M4 6h16M4 12h16M4 18h16',
};

const NS = 'http://www.w3.org/2000/svg';

/**
 * @param {keyof PATHS} name
 * @param {{size?: number, stroke?: number, title?: string}} opts
 *   `title` makes the icon announced; without it the icon is hidden from
 *   assistive tech, which is correct when a visible label sits beside it.
 */
export function icon(name, { size = 16, stroke = 1.5, title } = {}) {
  const d = PATHS[name];
  if (!d) {
    console.warn(`icon: no such icon "${name}"`);
    return document.createComment(`missing icon ${name}`);
  }

  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', String(stroke));
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('class', 'icon');

  if (title) {
    svg.setAttribute('role', 'img');
    const t = document.createElementNS(NS, 'title');
    t.textContent = title;
    svg.append(t);
  } else {
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
  }

  // One path per subpath keeps each shape's fill rule independent, which
  // matters for the settings gear and the star.
  for (const seg of d.split(/(?=M)/).filter(Boolean)) {
    const p = document.createElementNS(NS, 'path');
    p.setAttribute('d', seg.trim());
    if (name === 'star') p.setAttribute('class', 'icon-fillable');
    svg.append(p);
  }
  return svg;
}

export const ICON_NAMES = Object.keys(PATHS);
