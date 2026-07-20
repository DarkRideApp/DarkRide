/**
 * Pipeline smoke scenario — records a self-contained animated page so the
 * record -> mp4/gif mechanics can be verified without a running DarkRide or an
 * emulator. Proves Playwright capture + ffmpeg conversion work end to end.
 */
export default async function smoke(page /*, ctx */) {
  await page.setContent(`
    <style>
      :root { color-scheme: dark; }
      body { margin:0; height:100vh; display:grid; place-items:center;
             background:#0b0f1a; font-family:system-ui,sans-serif; overflow:hidden; }
      .card { text-align:center; color:#e6ebff; }
      h1 { font-size:44px; margin:0 0 8px; letter-spacing:-0.02em; }
      p { color:#8b95b0; margin:0; }
      .bar { width:360px; height:6px; margin:28px auto 0; border-radius:3px;
             background:#1b2233; overflow:hidden; }
      .bar i { display:block; height:100%; width:0; border-radius:3px;
               background:linear-gradient(90deg,#4a9eff,#7c5cff);
               animation:fill 3.2s ease-in-out forwards; }
      .dot { display:inline-block; width:10px; height:10px; border-radius:50%;
             background:#4a9eff; margin-right:8px; animation:pulse 1s infinite; }
      @keyframes fill { to { width:100%; } }
      @keyframes pulse { 50% { opacity:0.3; } }
    </style>
    <div class="card">
      <h1><span class="dot"></span>DarkRide demo pipeline</h1>
      <p>Playwright capture → ffmpeg → mp4 + gif</p>
      <div class="bar"><i></i></div>
    </div>
  `);
  // Hold on screen long enough for the animation to complete.
  await page.waitForTimeout(3600);
}
