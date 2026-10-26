import type { RecipeBehavior } from '@sf/core';

/**
 * Runtime behaviours: tiny, dependency-free JS attached to converted sections.
 * The source site's own bundle is never copied — interactivity is re-implemented
 * from a small registry so every section stays self-contained and theme-safe.
 *
 * Elements are found through data-sf-role="<type>.<role>" markers that the converter
 * writes before class names are rewritten, so behaviours survive renaming.
 */
export interface BehaviorDef {
  roles: string[];
  /** Function source: (root, opts) => void */
  source: string;
}

export const BEHAVIORS: Record<string, BehaviorDef> = {
  accordion: {
    roles: ['item', 'trigger'],
    source: `function (root, o) {
  var attr = o.openAttr || 'data-open';
  root.querySelectorAll('[data-sf-role~="accordion.trigger"]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var item = btn.closest('[data-sf-role~="accordion.item"]');
      if (!item) return;
      var open = !item.hasAttribute(attr);
      if (o.single) root.querySelectorAll('[data-sf-role~="accordion.item"][' + attr + ']').forEach(function (other) {
        if (other !== item) { other.removeAttribute(attr); var t = other.querySelector('[aria-expanded]'); if (t) t.setAttribute('aria-expanded', 'false'); }
      });
      if (open) item.setAttribute(attr, ''); else item.removeAttribute(attr);
      btn.setAttribute('aria-expanded', String(open));
    });
  });
}`,
  },

  dropdown: {
    roles: ['trigger', 'menu', 'option', 'label'],
    source: `function (root, o) {
  var trigger = root.querySelector('[data-sf-role~="dropdown.trigger"]');
  var menu = root.querySelector('[data-sf-role~="dropdown.menu"]');
  if (!trigger || !menu) return;
  var label = root.querySelector('[data-sf-role~="dropdown.label"]');
  var set = function (open) {
    menu.hidden = !open;
    menu.setAttribute('data-state', open ? 'open' : 'closed');
    trigger.setAttribute('aria-expanded', String(open));
  };
  set(false);
  trigger.addEventListener('click', function (e) { e.stopPropagation(); set(menu.hidden); });
  document.addEventListener('click', function (e) { if (!menu.contains(e.target)) set(false); });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') set(false); });
  menu.querySelectorAll('[data-sf-role~="dropdown.option"]').forEach(function (opt) {
    opt.addEventListener('click', function () {
      if (opt.getAttribute('aria-disabled') === 'true') return;
      menu.querySelectorAll('[data-sf-role~="dropdown.option"]').forEach(function (x) {
        var on = x === opt;
        if (x.hasAttribute('aria-checked')) x.setAttribute('aria-checked', String(on));
        if (on) x.setAttribute('data-active', 'true'); else x.removeAttribute('data-active');
      });
      var text = opt.querySelector('[data-sf-role~="dropdown.option-label"]') || opt;
      if (label) label.textContent = text.textContent.trim();
      set(false);
    });
  });
}`,
  },

  'hover-video': {
    roles: ['item', 'video'],
    source: `function (root, o) {
  var ready = o.readyClass || 'is-ready';
  var canHover = window.matchMedia('(hover: hover)').matches;
  root.querySelectorAll('[data-sf-role~="hover-video.item"]').forEach(function (item) {
    var video = item.querySelector('[data-sf-role~="hover-video.video"]');
    if (!video) return;
    var load = function () { if (!video.getAttribute('src') && video.dataset.src) video.src = video.dataset.src; };
    var play = function () { load(); var p = video.play(); if (p && p.catch) p.catch(function () {}); };
    video.addEventListener('playing', function () { video.classList.add(ready); });
    if (canHover) {
      item.addEventListener('pointerenter', play);
      item.addEventListener('pointerleave', function () { video.pause(); });
    } else if ('IntersectionObserver' in window) {
      new IntersectionObserver(function (entries) {
        entries.forEach(function (en) { if (en.isIntersecting) play(); else video.pause(); });
      }, { threshold: 0.6 }).observe(item);
    }
  });
}`,
  },

  'drag-scroll': {
    roles: ['track'],
    source: `function (root) {
  root.querySelectorAll('[data-sf-role~="drag-scroll.track"]').forEach(function (track) {
    var down = false, startX = 0, startLeft = 0;
    track.addEventListener('pointerdown', function (e) { if (e.pointerType !== 'mouse') return; down = true; startX = e.clientX; startLeft = track.scrollLeft; });
    window.addEventListener('pointerup', function () { down = false; });
    track.addEventListener('pointermove', function (e) { if (down) track.scrollLeft = startLeft - (e.clientX - startX); });
  });
}`,
  },
};

export function behaviorRoles(behaviors: RecipeBehavior[]): { role: string; selector: string }[] {
  const out: { role: string; selector: string }[] = [];
  for (const b of behaviors) {
    const def = BEHAVIORS[b.type];
    if (!def) throw new Error(`Unknown behaviour "${b.type}". Available: ${Object.keys(BEHAVIORS).join(', ')}`);
    for (const [role, selector] of Object.entries(b.roles)) out.push({ role: `${b.type}.${role}`, selector });
  }
  return out;
}

/** Self-booting script for one section; idempotent and theme-editor aware. */
export function behaviorScript(scopeClass: string, behaviors: RecipeBehavior[], prefix: string): string {
  if (!behaviors.length) return '';
  const calls = behaviors
    .map((b) => {
      const opts: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(b.options ?? {})) opts[k] = /Class$/.test(k) && typeof v === 'string' ? `${prefix}-${v}` : v;
      return `    (${BEHAVIORS[b.type].source})(root, ${JSON.stringify(opts)});`;
    })
    .join('\n');
  return `(function () {
  function init(root) {
    if (root.__sfInit) return;
    root.__sfInit = true;
${calls}
  }
  function boot() { document.querySelectorAll('.${scopeClass}').forEach(init); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
  document.addEventListener('shopify:section:load', boot);
})();
`;
}
