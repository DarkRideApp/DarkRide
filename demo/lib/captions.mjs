/**
 * On-screen caption overlay for the hero recording. Injects a fixed banner into
 * the DarkRide page and updates its text per beat — no post-production needed.
 * Re-inject after every navigation (the SPA replaces <body>): call caption()
 * again, it's idempotent.
 */
export async function caption(page, title, subtitle = '') {
  await page.evaluate(({ title, subtitle }) => {
    let el = document.getElementById('__hero_caption');
    if (!el) {
      el = document.createElement('div');
      el.id = '__hero_caption';
      el.style.cssText = [
        'position:fixed', 'left:50%', 'bottom:44px', 'transform:translateX(-50%)',
        'z-index:2147483647', 'background:rgba(11,15,26,0.92)', 'backdrop-filter:blur(10px)',
        '-webkit-backdrop-filter:blur(10px)', 'border:1px solid rgba(74,158,255,0.45)',
        'border-radius:14px', 'padding:16px 26px', 'color:#e6ebff',
        'font-family:system-ui,-apple-system,sans-serif', 'box-shadow:0 16px 48px rgba(0,0,0,0.55)',
        'text-align:center', 'max-width:78vw', 'transition:opacity .35s ease', 'pointer-events:none',
      ].join(';');
      document.body.appendChild(el);
    }
    el.style.opacity = '1';
    el.innerHTML =
      `<div style="font-size:22px;font-weight:650;letter-spacing:-0.01em">${title}</div>` +
      (subtitle ? `<div style="font-size:14px;color:#8b95b0;margin-top:5px">${subtitle}</div>` : '');
  }, { title, subtitle });
}

export async function clearCaption(page) {
  await page.evaluate(() => {
    const el = document.getElementById('__hero_caption');
    if (el) el.style.opacity = '0';
  }).catch(() => {});
}
