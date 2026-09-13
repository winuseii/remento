// Stats — real aggregates, not client-side arithmetic over a blob.
//
// The readiness score and the review heatmap are on the deferred list and are
// not here. Coverage is, because coverage is the number that keeps the rest
// honest: a deck holding two of five units can look 94% learned.

import {
  el, clear, toastError, loadingBlock, errorBlock, pluralise, plainText,
} from '../ui.js';
import * as db from '../db.js';
import { frontTextOf } from '../importer.js';

export async function render(panel, ctx) {
  const { state, setHeader } = ctx;

  const root = el('div', { class: 'wrap' });
  panel.append(root);

  setHeader({ crumb: ['Stats'], actions: [el('span', { class: 'hint' }, 'Last 30 days')] });
  clear(root);
  root.append(loadingBlock('Running the aggregates…'));

  try {
    const [global, tagRet, history] = await Promise.all([
      db.globalStats(),
      db.retentionByTag(30).catch((e) => { console.warn('retention_by_tag:', e.message); return null; }),
      db.reviewsOverTime(30).catch(() => []),
    ]);

    clear(root);
    root.append(
      globalPanel(global),
      history.length ? historyPanel(history) : null,
      el('div', { class: 'subject-panels' }),
      tagPanel(tagRet),
    );

    // Subjects load one at a time so the page is usable immediately.
    const host = root.querySelector('.subject-panels');
    for (const sub of state.subjects) {
      const box = el('section', { class: 'card-panel' },
        el('h3', { class: 'panel-title' }, sub.name),
        loadingBlock('Loading…'));
      host.append(box);
      subjectPanel(sub, state).then((node) => box.replaceWith(node))
        .catch((err) => { clear(box); box.append(errorBlock(err)); });
    }

    if (!state.subjects.length) {
      host.append(el('div', { class: 'empty' },
        el('p', { class: 'empty-title' }, 'No subjects yet'),
        el('p', {}, 'Per-subject coverage and retention appear once there is a subject to measure.')));
    }
  } catch (err) {
    clear(root);
    root.append(errorBlock(err, () => render(panel, ctx)));
    toastError('Could not load stats', err);
  }

  return { teardown() { clear(root); } };
}

// ── global ──────────────────────────────────────────────────────────────────

function globalPanel(g) {
  return el('section', { class: 'card-panel' },
    el('h3', { class: 'panel-title' }, 'Global'),
    el('div', { class: 'stats-row' },
      tile(g.dueNow, 'due now', g.dueNow ? 'warn' : 'good'),
      tile(g.doneToday, 'done today'),
      tile(g.streak, g.streak === 1 ? 'day streak' : 'day streak'),
      tile(g.total, 'cards'),
    ),
  );
}

function tile(n, label, kind) {
  return el('div', { class: `stat ${kind ? `stat-${kind}` : ''}`.trim() },
    el('div', { class: 'stat-n num' }, String(n ?? 0)),
    el('div', { class: 'stat-label' }, label));
}

// ── reviews over time ───────────────────────────────────────────────────────

/** A plain SVG bar chart. No chart library — there is no build step here. */
function historyPanel(days) {
  const byDay = new Map(days.map((d) => [d.day, d]));
  const series = [];
  for (let i = 29; i >= 0; i--) {
    const d = new Date(); d.setDate(d.getDate() - i);
    const iso = d.toISOString().slice(0, 10);
    series.push(byDay.get(iso) ?? { day: iso, n: 0, ok: 0 });
  }

  const max = Math.max(1, ...series.map((s) => s.n));
  const W = 600;
  const H = 90;
  const gap = 2;
  const bw = (W - gap * (series.length - 1)) / series.length;

  // el() makes HTML elements; an <svg> built that way is inert. The namespace
  // is not optional here.
  const svg = svgEl('svg', {
    class: 'chart', viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: 'none',
    role: 'img', 'aria-label': `Reviews per day for the last 30 days, peak ${max}`,
  });

  series.forEach((s, i) => {
    const h = s.n ? Math.max(2, (s.n / max) * (H - 4)) : 1;
    const x = i * (bw + gap);
    // The lower band is what was recalled; the rest is what was not.
    const okH = s.n ? (s.ok / s.n) * h : 0;
    svg.append(
      rect(x, H - h, bw, h, 'var(--line-2)'),
      okH ? rect(x, H - okH, bw, okH, 'var(--g-good)') : null,
      title(`${s.day}: ${s.n} reviewed, ${s.ok} recalled`),
    );
  });

  const total = series.reduce((a, s) => a + s.n, 0);

  return el('section', { class: 'card-panel' },
    el('div', { class: 'panel-head' },
      el('h3', { class: 'panel-title' }, 'Reviews, last 30 days'),
      el('span', { class: 'page-sub' }, `${total} total · peak ${max}/day`),
    ),
    svg,
    // Bars need something to stand on, or they read as floating blocks.
    el('div', { class: 'chart-base' }),
    el('div', { class: 'chart-axis' },
      el('span', {}, '30 days ago'),
      el('span', {}, 'today'),
    ),
    el('p', { class: 'hint' }, 'Green is the part graded Hard or better.'),
  );
}

const SVG_NS = 'http://www.w3.org/2000/svg';

function svgEl(tag, attrs = {}, ...children) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    node.setAttribute(k, String(v));
  }
  node.append(...children.flat().filter(Boolean));
  return node;
}

function rect(x, y, w, h, fill) {
  return svgEl('rect', {
    x, y, width: Math.max(0.5, w), height: Math.max(0, h), fill,
  });
}

function title(text) {
  const t = svgEl('title');
  t.textContent = text;
  return t;
}

// ── per subject ─────────────────────────────────────────────────────────────

async function subjectPanel(sub, state) {
  const units = state.units.filter((u) => u.subject_id === sub.id).sort((a, b) => a.no - b.no);

  const [counts, maturity, ret, worst] = await Promise.all([
    db.coverageByUnit(sub.id),
    db.maturitySplit({ subjectId: sub.id }),
    db.retention({ days: 30, subjectId: sub.id }),
    db.worstCards({ subjectId: sub.id, limit: 10 }),
  ]);

  return el('section', { class: 'card-panel' },
    el('div', { class: 'panel-head' },
      el('h3', { class: 'panel-title' }, sub.name),
      el('span', { class: 'page-sub' }, coverageLine(sub, units, counts)),
    ),
    coverageBars(sub, units, counts),
    el('div', { class: 'stats-row', style: 'margin-top:20px' },
      tile(maturity.total, 'cards'),
      tile(maturity.new, 'new'),
      tile(maturity.learning + maturity.young, 'learning'),
      tile(maturity.mature, 'mature', 'good'),
      tile(ret.pct == null ? '—' : `${Math.round(ret.pct)}%`, 'retention',
        ret.pct == null ? '' : ret.pct >= 85 ? 'good' : ret.pct >= 70 ? 'warn' : 'bad'),
    ),
    ret.reviews
      ? el('p', { class: 'hint' }, `${pluralise(ret.reviews, 'scheduled review')} in the last 30 days. Cram and quiz are excluded — they are not a measurement of recall at interval.`)
      : el('p', { class: 'hint' }, 'No scheduled reviews in the last 30 days, so retention has nothing to report.'),
    worst.length ? worstPanel(worst) : null,
  );
}

/**
 * The honest coverage line. If units_declared is blank the app says
 * "undeclared" — a confident number with no denominator is worse than none.
 */
function coverageLine(sub, units, counts) {
  const withCards = units.filter((u) => (counts.get(u.id) ?? 0) > 0).length;
  if (sub.units_declared == null) {
    return `Coverage: undeclared · ${withCards} of ${units.length} created units have cards`;
  }
  const empty = [];
  for (let n = 1; n <= sub.units_declared; n++) {
    const unit = units.find((u) => u.no === n);
    if (!unit || !(counts.get(unit.id) ?? 0)) empty.push(n);
  }
  const base = `Coverage: ${sub.units_declared - empty.length} of ${sub.units_declared} units`;
  return empty.length ? `${base} · 0 cards in ${empty.length === 1 ? 'Unit' : 'Units'} ${empty.join(', ')}` : base;
}

/**
 * The coverage bar. Unit 4 having 3 cards while the rest have 40 is the most
 * useful thing on this screen, so declared-but-missing units are drawn too.
 */
function coverageBars(sub, units, counts) {
  const declared = sub.units_declared;
  const slots = [];

  const upTo = declared ?? (units.length ? Math.max(...units.map((u) => u.no)) : 0);
  for (let n = 1; n <= upTo; n++) {
    const unit = units.find((u) => u.no === n);
    slots.push({ no: n, unit, n: unit ? (counts.get(unit.id) ?? 0) : 0, missing: !unit });
  }
  // Units numbered beyond the declared count still exist and still hold cards.
  for (const u of units) if (u.no > upTo) slots.push({ no: u.no, unit: u, n: counts.get(u.id) ?? 0 });

  const atSubjectLevel = counts.get(null) ?? 0;
  if (atSubjectLevel) slots.push({ no: null, unit: null, n: atSubjectLevel, loose: true });

  if (!slots.length) return el('p', { class: 'hint' }, 'No units yet.');

  const max = Math.max(1, ...slots.map((s) => s.n));

  return el('div', { class: 'coverage' },
    slots.map((s) => el('div', { class: 'cov-row' },
      el('span', { class: 'cov-no num' }, s.loose ? '—' : String(s.no).padStart(2, '0')),
      el('span', { class: 'cov-title' },
        s.loose ? 'Subject level' : (s.unit?.title ?? el('em', { class: 'dim' }, 'not created'))),
      el('span', { class: 'cov-bar' },
        el('span', {
          class: `cov-fill ${s.n === 0 ? 'is-empty' : ''}`.trim(),
          style: `width:${s.n ? Math.max(3, (s.n / max) * 100) : 0}%`,
        })),
      el('span', { class: `cov-n num ${s.n === 0 ? 'is-zero' : ''}`.trim() }, String(s.n)),
    )),
  );
}

function worstPanel(worst) {
  return el('div', { class: 'worst' },
    el('h4', { class: 'panel-title', style: 'margin-top:20px' }, 'Worst cards, by lapses'),
    el('ol', { class: 'worst-list' },
      worst.map((c) => el('li', { class: 'worst-item' },
        el('span', { class: 'worst-n num' }, String(c.lapses)),
        el('span', { class: 'worst-front' }, plainText(frontTextOf(c.content)) || '(no front text)'),
      )),
    ),
  );
}

// ── retention by tag ────────────────────────────────────────────────────────

/**
 * Probably the most interesting number in the app: which *kinds* of thing you
 * fail, across subjects. If derivation is 54% and definition is 91%, that is
 * how to spend a week.
 */
function tagPanel(rows) {
  if (rows == null) {
    return el('section', { class: 'card-panel' },
      el('h3', { class: 'panel-title' }, 'Retention by tag'),
      el('p', { class: 'hint' }, 'The remento_retention_by_tag RPC could not be reached. Nothing else on this page depends on it.'));
  }
  if (!rows.length) {
    return el('section', { class: 'card-panel' },
      el('h3', { class: 'panel-title' }, 'Retention by tag'),
      el('p', { class: 'hint' }, 'Nothing reviewed in the last 30 days yet.'));
  }

  return el('section', { class: 'card-panel' },
    el('div', { class: 'panel-head' },
      el('h3', { class: 'panel-title' }, 'Retention by tag'),
      el('span', { class: 'page-sub' }, 'worst first'),
    ),
    el('div', { class: 'coverage' },
      rows.map((r) => {
        const pct = Number(r.retention ?? 0);
        const kind = pct >= 85 ? 'good' : pct >= 70 ? 'warn' : 'bad';
        return el('div', { class: 'cov-row' },
          el('span', { class: 'cov-title tag-name' }, `#${r.tag}`),
          el('span', { class: 'cov-bar' },
            el('span', { class: `cov-fill is-${kind}`, style: `width:${pct}%` })),
          el('span', { class: 'cov-n num' }, `${pct}%`),
          el('span', { class: 'cov-sub num dim' }, `${r.reviews}`),
        );
      }),
    ),
    el('p', { class: 'hint' }, 'Fraction graded Hard or better, over scheduled reviews in the last 30 days. The right-hand number is how many reviews that is — a tag with four reviews is not evidence.'),
  );
}
