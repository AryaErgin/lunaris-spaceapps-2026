// Optional, non-modal navigation through the real LUNARIS controls.
// No mission calculations, settings or selections are changed by the tour itself.
export const GUIDE_STEPS = Object.freeze([
  {
    title: 'Choose a place and time',
    description: 'Pick a lunar study point, arrival date and viewing duration. These choices determine the conditions LUNARIS evaluates.',
    selectors: ['#visual-site', '#visual-arrival', '#visual-duration']
  },
  {
    title: 'See the lunar horizon',
    description: 'Open Surface view to see the terrain, Sun and Earth. The View clock moves the scene through time without changing your arrival.',
    selectors: ['#mode-surface']
  },
  {
    title: 'Find visibility opportunities',
    description: 'Search other supported sites and dates. The results explain where Sun and Earth can be seen together.',
    selectors: ['#find-opportunities']
  },
  {
    title: 'Compare two options',
    description: 'Compare sites or arrival dates side by side. Open Advanced only if you want the scientific methods and full evidence.',
    selectors: ['#product-compare']
  }
]);

export function initQuickTour(doc = document) {
  const trigger = doc.getElementById('tour-start');
  if (!trigger || doc.getElementById('quick-tour')) return;
  const panel = doc.createElement('section');
  panel.id = 'quick-tour';
  panel.className = 'quick-tour';
  panel.hidden = true;
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-modal', 'false');
  panel.setAttribute('aria-label', 'LUNARIS guided walkthrough');

  const top = doc.createElement('div');
  top.className = 'quick-tour-top';
  const progress = doc.createElement('span');
  progress.className = 'quick-tour-progress';
  const close = doc.createElement('button');
  close.type = 'button';
  close.className = 'quick-tour-close';
  close.textContent = 'Close';
  close.setAttribute('aria-label', 'Close guided walkthrough');
  top.append(progress, close);

  const title = doc.createElement('h2');
  title.id = 'quick-tour-title';
  const description = doc.createElement('p');
  description.id = 'quick-tour-description';
  panel.setAttribute('aria-labelledby', title.id);
  panel.setAttribute('aria-describedby', description.id);

  const footer = doc.createElement('div');
  footer.className = 'quick-tour-actions';
  const previous = doc.createElement('button');
  previous.type = 'button';
  previous.textContent = 'Back';
  previous.className = 'quick-tour-back';
  const next = doc.createElement('button');
  next.type = 'button';
  next.className = 'quick-tour-next';
  footer.append(previous, next);
  panel.append(top, title, description, footer);
  doc.body.append(panel);

  let current = -1;
  let activeTargets = [];
  const unhighlight = () => {
    for (const target of activeTargets) target.classList.remove('quick-tour-target');
    activeTargets = [];
  };
  function finish({returnFocus = true} = {}) {
    unhighlight();
    panel.hidden = true;
    current = -1;
    trigger.setAttribute('aria-expanded', 'false');
    if (returnFocus) trigger.focus({preventScroll: true});
  }
  function show(index) {
    if (index < 0 || index >= GUIDE_STEPS.length) return finish();
    unhighlight();
    current = index;
    const step = GUIDE_STEPS[current];
    progress.textContent = 'STEP ' + (index + 1) + ' OF ' + GUIDE_STEPS.length;
    title.textContent = step.title;
    description.textContent = step.description;
    previous.hidden = index === 0;
    next.textContent = index === GUIDE_STEPS.length - 1 ? 'Finish tour' : 'Next step';
    activeTargets = step.selectors.map(selector => doc.querySelector(selector)).filter(Boolean);
    for (const target of activeTargets) target.classList.add('quick-tour-target');
    const first = activeTargets[0];
    if (first) first.scrollIntoView({behavior: 'instant', block: 'center', inline: 'nearest'});
    panel.hidden = false;
    trigger.setAttribute('aria-expanded', 'true');
    next.focus({preventScroll: true});
  }
  trigger.setAttribute('aria-controls', 'quick-tour');
  trigger.setAttribute('aria-expanded', 'false');
  trigger.addEventListener('click', () => {
    // A guided exploration always begins in Mission, without resetting its inputs.
    doc.getElementById('product-explore')?.click();
    show(0);
  });
  previous.addEventListener('click', () => show(current - 1));
  next.addEventListener('click', () => current === GUIDE_STEPS.length - 1 ? finish() : show(current + 1));
  close.addEventListener('click', () => finish());
  doc.addEventListener('keydown', event => {
    if (!panel.hidden && event.key === 'Escape') {
      event.preventDefault();
      finish();
    }
  });
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => initQuickTour(), {once: true});
  else initQuickTour();
}
