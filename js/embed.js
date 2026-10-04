// Remento inside PATHS. PATHS serves this same app at localhost:8420/remento/
// and shows it in its College tab, in an iframe with ?embed=1. Then, and only
// then, Remento talks to PATHS:
//   to PATHS    remento:ready     signed in and showing a tab
//               remento:tab       which tab it shows
//               remento:graded    a card was graded (PATHS counts it for the daily goal)
//               remento:imported  cards went in through Import
//   from PATHS  paths:tab         show this tab
//               paths:import      put this card set into Import
// Both pages are on the same origin, and every message is checked for it.

export const EMBEDDED = window.parent !== window && new URLSearchParams(location.search).has('embed');

if (EMBEDDED) document.documentElement.classList.add('embedded');

export function tellPaths(type, data = {}) {
  if (!EMBEDDED) return;
  try { window.parent.postMessage({ type: `remento:${type}`, ...data }, location.origin); } catch { /* PATHS went away */ }
}

export function fromPaths(fn) {
  if (!EMBEDDED) return;
  window.addEventListener('message', (e) => {
    if (e.origin !== location.origin || e.source !== window.parent || !e.data || typeof e.data !== 'object') return;
    fn(e.data);
  });
}
