'use strict';

/* ══════════════════════════════════════════════════════════════════
   QuoteLeadsAI — the assistant panel.

   The brain is the quoteleadsai-chat edge function: it holds the Anthropic key
   as a server secret and runs the QuoteLeads tools (the same modules the
   local MCP server uses) against this database. Nothing runs on anyone's
   laptop, so this works from the deployed site on any device.

   The browser sends a question and the conversation so far, and gets an
   answer back. It never sees the key, and it cannot ask for a tool the
   function did not offer.

   Voice is the browser's own: speechSynthesis to speak, SpeechRecognition
   to listen. Both are optional — typing always works.
   ══════════════════════════════════════════════════════════════════ */
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  const p = document.getElementById('jv-panel');
  if (p && p.classList.contains('hud')) { e.preventDefault(); JV.toggleHud(); }
});

/* ── HUD core ──────────────────────────────────────────────────────────────
   The full-screen centrepiece, on one canvas: a breathing particle sphere, a
   lit nucleus, three tilted orbits with satellites, and a spectrum ring.

   It keeps no state of its own. Each frame it reads body[data-jv] (set by
   JV's status()) and body[data-jv-speaking], and eases its colour and energy
   towards what those say, so it can only ever show what he is really doing.
   pulse() is a kick from speech, one per spoken word.

   Runs only while the HUD is open and the tab is visible. Reduced motion gets
   a still core that still changes colour with state. */
const HUD_FX = (() => {
  const STATES = {
    idle:      { c: [95, 216, 255],  e: .16, spin: .10 },
    ready:     { c: [95, 216, 255],  e: .20, spin: .12 },
    busy:      { c: [169, 147, 255], e: .62, spin: .55 },
    listening: { c: [255, 181, 71],  e: .48, spin: .18 },
    speaking:  { c: [140, 236, 255], e: .50, spin: .22 },
    err:       { c: [255, 93, 108],  e: .22, spin: .06 },
  };
  const N = 640, BARS = 120;
  const pts = [];
  for (let i = 0; i < N; i++) {             // Fibonacci sphere: even, no clumps
    const y = 1 - (i / (N - 1)) * 2, r = Math.sqrt(1 - y * y), th = i * 2.399963;
    pts.push([Math.cos(th) * r, y, Math.sin(th) * r, Math.random()]);
  }
  const spec = new Float32Array(BARS), specT = new Float32Array(BARS);
  const ORBITS = [
    { tilt: 1.15, yaw: .2,  r: 1.32, sp: .55, ph: 0 },
    { tilt: .45,  yaw: 1.9, r: 1.46, sp: -.38, ph: 2.1 },
    { tilt: 1.75, yaw: 3.4, r: 1.6,  sp: .27, ph: 4.2 },
  ];
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;

  let cv, ctx, W = 0, raf = 0, timer = 0, running = false;
  let t = 0, last = 0, rot = 0, kick = 0, lastHalo = '';
  let col = STATES.idle.c.slice(), energy = STATES.idle.e, spin = STATES.idle.spin;

  function size() {
    const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    const box = cv.getBoundingClientRect();
    W = Math.max(1, Math.round(box.width * dpr));
    if (cv.width !== W) { cv.width = W; cv.height = W; }
  }

  function state() {
    const b = document.body.dataset;
    if (b.jvSpeaking === '1' && b.jv !== 'listening') return STATES.speaking;
    return STATES[b.jv] || STATES.idle;
  }

  const rgba = (a, k = 1) =>
    `rgba(${Math.min(255, col[0] * k) | 0},${Math.min(255, col[1] * k) | 0},${Math.min(255, col[2] * k) | 0},${a})`;

  function frame(now) {
    const dt = Math.min(.05, last ? (now - last) / 1000 : .016);
    last = now;
    if (!reduced) t += dt;

    // Ease towards the target state rather than snapping: a hard cut from
    // thinking to idle reads as a glitch.
    const s = state(), k = 1 - Math.pow(.02, dt);
    for (let i = 0; i < 3; i++) col[i] += (s.c[i] - col[i]) * k;
    energy += (s.e - energy) * k;
    spin += (s.spin - spin) * k;
    kick *= Math.pow(.04, dt);
    const en = Math.min(1, energy + kick * .5);
    if (!reduced) rot += spin * dt;

    const c = ctx, cx = W / 2, cy = W / 2, R = W * .2;
    c.clearRect(0, 0, W, W);
    c.globalCompositeOperation = 'lighter';

    // Halo is CSS behind the canvas (a full-canvas gradient every frame is the
    // single most expensive thing to draw); only repaint it when it changes.
    const halo = rgba((.16 + en * .14).toFixed(2));
    if (halo !== lastHalo) { cv.parentNode.style.setProperty('--glow', halo); lastHalo = halo; }
    let g;

    // Particle sphere. Cheap trig "noise" displaces the surface so it breathes
    // and, when he is busy, churns.
    const cr = Math.cos(rot), sr = Math.sin(rot);
    const tl = .38 + Math.sin(t * .23) * .12, ct = Math.cos(tl), st = Math.sin(tl);
    const amp = .04 + en * .16, dot = Math.max(1, W / 520);
    c.fillStyle = rgba(1, 1.25);
    for (let i = 0; i < N; i++) {
      const p = pts[i];
      let x = p[0], y = p[1], z = p[2];
      const n = Math.sin(x * 3.1 + t * 1.3) * Math.sin(y * 3.7 + t * .9) * Math.sin(z * 2.9 + t * 1.1);
      const d = 1 + n * amp + Math.sin(t * 2 + p[3] * 6.28) * .012;
      x *= d; y *= d; z *= d;
      const x1 = x * cr - z * sr, z1 = x * sr + z * cr;   // spin about Y
      const y2 = y * ct - z1 * st, z2 = y * st + z1 * ct; // tilt about X
      const f = 3 / (3 - z2);
      const depth = (z2 + 1.2) / 2.4;
      c.globalAlpha = .12 + depth * .75;
      const sz = dot * (.6 + depth * 1.5) * f;
      c.fillRect(cx + x1 * R * f - sz / 2, cy + y2 * R * f - sz / 2, sz, sz);
    }

    c.globalAlpha = 1;

    // Nucleus
    const nr = R * (.42 + en * .12 + Math.sin(t * 2.2) * .02);
    g = c.createRadialGradient(cx, cy, 0, cx, cy, nr);
    g.addColorStop(0, `rgba(255,255,255,${.55 + en * .35})`);
    g.addColorStop(.25, rgba(.55 + en * .3, 1.1));
    g.addColorStop(1, rgba(0));
    c.fillStyle = g; c.beginPath(); c.arc(cx, cy, nr, 0, 6.2832); c.fill();

    // Orbits: 3D circles, brighter on the near side, each with a satellite.
    c.lineWidth = Math.max(1, W / 700);
    for (const o of ORBITS) {
      const ca = Math.cos(o.tilt), sa = Math.sin(o.tilt), cyw = Math.cos(o.yaw + rot * .4), syw = Math.sin(o.yaw + rot * .4);
      const P = (a) => {
        let x = Math.cos(a) * o.r, y = 0, z = Math.sin(a) * o.r;
        const y1 = y * ca - z * sa, z1 = y * sa + z * ca;
        const x2 = x * cyw - z1 * syw, z2 = x * syw + z1 * cyw;
        const f = 3 / (3 - z2 * .6);
        return [cx + x2 * R * f, cy + y1 * R * f, z2];
      };
      const far = new Path2D(), near = new Path2D();
      let prev = P(0);
      for (let i = 1; i <= 64; i++) {
        const q = P(i / 64 * 6.2832), path = q[2] > 0 ? near : far;
        path.moveTo(prev[0], prev[1]); path.lineTo(q[0], q[1]);
        prev = q;
      }
      c.strokeStyle = rgba(.06 + en * .05); c.stroke(far);
      c.strokeStyle = rgba(.24 + en * .2); c.stroke(near);
      const sat = P(o.ph + t * o.sp * (1 + en * 1.5));
      g = c.createRadialGradient(sat[0], sat[1], 0, sat[0], sat[1], R * .09);
      g.addColorStop(0, 'rgba(255,255,255,.95)'); g.addColorStop(.3, rgba(.8)); g.addColorStop(1, rgba(0));
      c.fillStyle = g; c.beginPath(); c.arc(sat[0], sat[1], R * .09, 0, 6.2832); c.fill();
    }

    // Spectrum ring: bars ease towards random targets scaled by energy, so
    // idle is a faint ripple and speech is a lively one.
    const r0 = R * 1.9, maxL = R * (.08 + en * .42);
    for (let i = 0; i < BARS; i++) {
      if (!reduced && Math.random() < .12 + en * .3) specT[i] = Math.random() * (.25 + en * .75) + kick * .6;
      spec[i] += (specT[i] - spec[i]) * Math.min(1, dt * 14);
    }
    c.lineWidth = Math.max(1.5, W / 330); c.lineCap = 'round';
    const buckets = [new Path2D(), new Path2D(), new Path2D(), new Path2D()];
    for (let i = 0; i < BARS; i++) {
      const v = (spec[i] + spec[(i + 1) % BARS] + spec[(i + BARS - 1) % BARS]) / 3;
      const a = i / BARS * 6.2832 + rot * .25 - 1.5708;
      const l = 2 + v * maxL, ca = Math.cos(a), sa = Math.sin(a);
      const b = buckets[Math.min(3, (v * 4) | 0)];
      b.moveTo(cx + ca * r0, cy + sa * r0); b.lineTo(cx + ca * (r0 + l), cy + sa * (r0 + l));
    }
    buckets.forEach((b, i) => { c.strokeStyle = rgba(.25 + i * .17); c.stroke(b); });

    // Outer instrument rings: a fine full circle, and segmented arcs turning
    // the other way.
    c.lineCap = 'butt';
    c.lineWidth = Math.max(1, W / 900);
    c.strokeStyle = rgba(.18);
    c.beginPath(); c.arc(cx, cy, R * 1.82, 0, 6.2832); c.stroke();
    c.lineWidth = Math.max(1.5, W / 420);
    const segs = 6, gap = .16;
    for (let i = 0; i < segs; i++) {
      const a0 = i / segs * 6.2832 - rot * .6;
      c.strokeStyle = rgba(i % 2 ? .22 : .45);
      c.beginPath(); c.arc(cx, cy, R * 2.32, a0, a0 + 6.2832 / segs - gap); c.stroke();
    }
    c.lineWidth = Math.max(1, W / 800);
    const sweep = t * .9;
    c.strokeStyle = rgba(.6, 1.15);
    c.beginPath(); c.arc(cx, cy, R * 2.42, sweep, sweep + .5 + en * .9); c.stroke();

    c.globalCompositeOperation = 'source-over';
  }

  function loop(now) {
    if (!running) return;
    if (!document.hidden) frame(now);
    if (reduced) timer = setTimeout(() => loop(performance.now()), 400);
    else raf = requestAnimationFrame(loop);
  }

  return {
    start() {
      cv = cv || document.getElementById('hud-canvas');
      if (!cv || running) return;
      ctx = ctx || cv.getContext('2d');
      running = true; last = 0;
      size();
      window.addEventListener('resize', size);
      loop(performance.now());
    },
    stop() {
      running = false;
      cancelAnimationFrame(raf); clearTimeout(timer);
      window.removeEventListener('resize', size);
    },
    pulse(n = 1) { kick = Math.min(1.2, kick + .35 * n); },
  };
})();

const JV = (() => {
  // The conversation itself lives server-side (quoteleadsai_threads), so a reload
  // or another device continues it. `restored` is whether this page has
  // fetched it yet.
  let restored = false, busy = false, rec = null, micOn = false;
  // Whether the browser's recognizer is actually running. Not the same as
  // micOn: after an error the button resets at once, but the recognizer keeps
  // running until its own onend - and start() in that gap throws "recognition
  // has already started". Only onend clears this.
  let recRunning = false;
  let voice = localStorage.getItem('ql_quoteleadsai_voice') !== '0';
  // On by default. It was opt-in while the tools were unproven; the point of
  // the assistant is telling him to do things, and a switch you have to find
  // and flip every session is a switch that makes the feature look broken.
  // Still per-browser and still off-able, and the irreversible tools confirm
  // before they act.
  let writes = localStorage.getItem('ql_quoteleadsai_writes') !== '0';

  const $$ = id => document.getElementById(id);
  const body = () => $$('jv-body');
  const esc = t => { const d = document.createElement('div'); d.textContent = String(t ?? ''); return d.innerHTML; };

  function status(text, cls) {
    const el = $$('jv-status'); if (el) el.textContent = text;
    const dot = $$('jv-dot'); if (dot) dot.className = 'jv-dot' + (cls ? ' ' + cls : '');
    const r = $$('jv-reactor'); if (r) r.classList.toggle('live', cls === 'ready' || cls === 'busy');
    // The HUD reads its state from here rather than keeping its own. One
    // source of truth means the reactor cannot claim he is thinking while he
    // is idle, which is the only way an ambient display like this stays
    // trustworthy rather than becoming decoration.
    document.body.dataset.jv = micOn ? 'listening' : (cls || 'idle');
    const lbl = $$('hud-label');
    if (lbl) lbl.textContent = (micOn ? 'Listening' : text || 'Standing by').toUpperCase();
  }

  // His replies use a little markdown: **bold**, `code` and "- " lists.
  // Escaped first, so only these three ever become markup.
  const md = (t) => esc(t)
    .replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>')
    .replace(/`([^`\n]+)`/g, '<code>$1</code>')
    .replace(/^([ \t]*)[-*] /gm, '$1• ');

  function line(cls, text) {
    const el = document.createElement('div');
    el.className = 'jv-msg ' + cls;
    if (cls === 'sys') el.innerHTML = text;
    else if (cls === 'quoteleadsai') el.innerHTML = md(text);
    else el.textContent = text;
    body().appendChild(el);
    body().scrollTop = body().scrollHeight;
    return el;
  }

  // Live numbers for the HUD columns. Best effort throughout: the reactor is
  // the point, and a failed count should dim a row rather than blank the
  // screen or throw into the console.
  async function loadHudStats() {
    const watch = $$('hud-watch'), pipe = $$('hud-pipe');
    const row = (label, n, warn) =>
      `<div class="hud-row${warn && n ? ' warn' : ''}"><span>${esc(label)}</span><b>${esc(n)}</b></div>`;

    try {
      const { data } = await db.rpc('quoteleadsai_status');
      const byKind = (data && data.open_by_kind) || {};
      const labels = (typeof QUOTELEADSAI_WATCH_LABELS !== 'undefined') ? QUOTELEADSAI_WATCH_LABELS : {};
      let html = Object.keys(labels).map((k) => row(labels[k], byKind[k] || 0, true)).join('');
      html += row('Texts queued to send', (data && data.queued) || 0, true);
      watch.innerHTML = html || row('nothing open', 0);
    } catch (_) {
      watch.innerHTML = row('unavailable', '—');
    }

    try {
      const { data: leads } = await db
        .from('leads').select('stage').limit(5000);
      const rows = leads || [];
      const open = rows.filter((l) => l.stage !== 'closed_won' && l.stage !== 'closed_lost').length;
      const prop = rows.filter((l) => l.stage === 'proposal').length;
      const won  = rows.filter((l) => l.stage === 'closed_won').length;
      pipe.innerHTML =
        row('open leads', open) +
        row('at proposal', prop, true) +
        row('closed won', won) +
        row('leads per sale', won ? (rows.length / won).toFixed(1) : '—');
    } catch (_) {
      pipe.innerHTML = row('unavailable', '—');
    }
  }

  async function ask(text) {
    text = String(text || '').trim();
    if (!text || busy) return;
    line('you', text);
    busy = true;
    status('Thinking…', 'busy');

    const thinking = line('quoteleadsai', '…');
    try {
      // `db` is declared with `let` (index.html:2947), so it lives in the
      // global lexical scope and is NOT a property of window — checking
      // window.db reports "not signed in" for a perfectly good session.
      if (typeof db === 'undefined' || !db) throw new Error('Sign in first.');
      const { data: { session } } = await db.auth.getSession();
      if (!session) throw new Error('Your session has expired — sign in again.');

      const res = await fetch(_ep + '/functions/v1/quoteleadsai-chat', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          apikey: _ak,
          Authorization: 'Bearer ' + session.access_token,
        },
        // Only the new question. quoteleadsai-chat keeps the conversation and what
        // he remembers, so follow-ups like "and last month?" resolve against
        // what was said here, yesterday, or from your phone.
        body: JSON.stringify({ text, allow_writes: writes }),
      });

      const out = await res.json();
      if (!res.ok || out.error) throw new Error(out.error || ('Request failed: ' + res.status));

      if (Array.isArray(out.tools) && out.tools.length) {
        const t = document.createElement('div');
        t.className = 'jv-tool';
        t.textContent = '⟢ ' + [...new Set(out.tools)].join(', ').replace(/_/g, ' ');
        body().insertBefore(t, thinking);
      }

      thinking.innerHTML = md(out.reply || '(no answer)');
      status('Ready', 'ready');
      if (voice) speak(thinking.textContent);
    } catch (e) {
      thinking.remove();
      line('sys', esc(e.message));
      status('Error', 'err');
    } finally {
      busy = false;
      body().scrollTop = body().scrollHeight;
    }
  }

  /* ── speech ── */
  // The browser's own voice, and only that. There was a server-rendered voice
  // here; it was removed rather than left dormant behind a missing key, because
  // a path that switches itself on the moment a secret appears is a path nobody
  // remembers is there.
  function hush() {
    if (window.speechSynthesis) speechSynthesis.cancel();
    delete document.body.dataset.jvSpeaking;
  }

  /**
   * Pick the closest thing to the QuoteLeadsAI voice the browser actually has.
   *
   * The default is whatever the OS considers first, which is usually a
   * generic American one. A British male voice is shipped by both Chrome
   * ("Google UK English Male") and macOS ("Daniel"), and is a far better
   * match. Preference order, first hit wins; falls back to the default.
   */
  const VOICE_ORDER = [
    /Google UK English Male/i,
    /\bDaniel\b/i,           // iOS + macOS en-GB
    /\bArthur\b/i,           // iOS + macOS en-GB, newer
    /\bOliver\b/i,
    /\bGeorge\b/i,
    /\bRishi\b/i,            // iOS en-IN male
    /Microsoft (Ryan|George|Guy|Christopher)/i,
    // Android's Google TTS names its voices by codename, not by anything
    // readable. -gbb- and -gbd- are the male en-GB ones; -gba- and -gbc- are
    // female. Without these, Android never matched a single pattern above and
    // fell through to the guesswork below.
    /en[-_]gb[-_]x[-_](gbb|gbd)/i,
    /en[-_]au[-_]x[-_](aub|aud)/i,
    /en[-_]GB.*male/i,
  ];

  // Known-female voices, so the fallback cannot land on one. This is the bug
  // that put a female voice on a phone: the last resort was "any en-GB voice",
  // and on most phones the first en-GB voice in the list is female.
  const VOICE_AVOID = /(female|\bKaren\b|\bSamantha\b|\bMartha\b|\bSerena\b|\bKate\b|\bMoira\b|\bFiona\b|\bTessa\b|\bVeena\b|\bZira\b|\bHazel\b|\bSusan\b|\bCatherine\b|[-_]x[-_](gba|gbc|aua|auc))/i;

  let picked = null, pickedOnce = false;

  function pickVoice() {
    if (pickedOnce) return picked;
    const all = window.speechSynthesis?.getVoices?.() ?? [];
    // getVoices() is empty until the list loads, so don't cache an empty pick.
    if (!all.length) return null;
    pickedOnce = true;

    // An explicit choice always wins. Stored per device on purpose: which
    // voices exist depends entirely on the phone or laptop in hand, so a
    // single shared setting would be wrong on every device but one.
    let saved = null;
    try { saved = localStorage.getItem('jv-voice'); } catch (_) {}
    if (saved) {
      const exact = all.find(v => v.name === saved);
      if (exact) { picked = exact; return picked; }
    }

    for (const want of VOICE_ORDER) {
      const hit = all.find(v => (want.test(v.name) || want.test(`${v.lang} ${v.name}`))
        && !VOICE_AVOID.test(v.name));
      if (hit) { picked = hit; break; }
    }
    // Still nothing: any English voice that is not on the avoid list, British
    // first. Better silence from the OS default than a voice that was picked
    // precisely because nothing else matched.
    picked = picked
      || all.find(v => /^en[-_]GB/i.test(v.lang) && !VOICE_AVOID.test(v.name))
      || all.find(v => /^en/i.test(v.lang) && !VOICE_AVOID.test(v.name))
      || null;
    return picked;
  }

  // Every English voice this device has, for the settings picker.
  function listVoices() {
    const all = window.speechSynthesis?.getVoices?.() ?? [];
    return all.filter(v => /^en/i.test(v.lang)).sort((a, b) => a.name.localeCompare(b.name));
  }

  function setVoiceByName(name) {
    try { name ? localStorage.setItem('jv-voice', name) : localStorage.removeItem('jv-voice'); } catch (_) {}
    pickedOnce = false; picked = null;
    pickVoice();
  }

  if (window.speechSynthesis) {
    speechSynthesis.onvoiceschanged = () => { pickedOnce = false; pickVoice(); };
  }

  async function speak(text) {
    if (!voice || !text) return;
    return speakForce(text);
  }

  // Same, minus the "are replies muted" check - used by the settings preview,
  // where the whole point is to hear it.
  async function speakForce(text) {
    if (!text) return;
    hush();

    if (!window.speechSynthesis) return;

    const u = new SpeechSynthesisUtterance(text);
    const v = pickVoice();
    if (v) { u.voice = v; u.lang = v.lang; }
    // Measured, a little lower than default. Clipped speech reads as urgency,
    // which is the opposite of the character.
    u.rate = 1.0; u.pitch = 0.85;
    // The HUD core lights up while he talks and kicks on every word.
    u.onstart = () => { document.body.dataset.jvSpeaking = '1'; HUD_FX.pulse(); };
    u.onboundary = () => HUD_FX.pulse();
    u.onend = u.onerror = () => { delete document.body.dataset.jvSpeaking; };
    speechSynthesis.speak(u);
  }

  function initMic() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) return null;
    const r = new SR();
    r.continuous = false; r.interimResults = false; r.lang = 'en-AU';

    // Say when it is actually listening. Without this the only signal is a CSS
    // class on a small button, so a mic that never started and a mic that heard
    // nothing look identical - which reads as "he cannot hear me".
    r.onstart = () => status('Listening…', 'busy');

    // ask() already echoes what was said, which is what matters here: when
    // speech recognition mangles a company name, seeing the mangled version is
    // the difference between "he is broken" and "it misheard me".
    r.onresult = (e) => ask(e.results[0][0].transcript);

    r.onend = () => {
      recRunning = false;
      micOn = false; $$('jv-mic').classList.remove('on');
      // status() is what tells the HUD which state to draw, so it has to run
      // on the way down too - otherwise the reactor stays amber, still
      // claiming to be listening, long after the microphone has stopped.
      if (!busy) status('Ready', 'ready');
    };

    // Errors were swallowed entirely, so every failure looked like silence.
    // These are the ones that actually happen, and each has a different fix.
    r.onerror = (e) => {
      micOn = false;
      $$('jv-mic').classList.remove('on');
      const why = {
        'not-allowed': 'Microphone blocked. Allow it for this site in your browser settings, then try again.',
        'service-not-allowed': 'Microphone blocked by the browser or the OS.',
        'no-speech': 'I did not hear anything. Try again, a little closer to the mic.',
        'audio-capture': 'No microphone found.',
        'network': 'Speech recognition could not reach its service. Type it instead.',
        'aborted': '',
      }[e?.error] ?? `Microphone error: ${e?.error || 'unknown'}.`;
      if (why) line('sys', why);
      status('Ready', 'ready');
    };
    return r;
  }

  function paintVoice() {
    const b = $$('jv-speak');
    if (!b) return;
    b.innerHTML = voice ? '<svg viewBox="0 0 24 24"><path d="M11 5L6 9H2v6h4l5 4zM15.5 8.5a5 5 0 010 7M19 5a10 10 0 010 14"/></svg><span>Voice on</span>' : '<svg viewBox="0 0 24 24"><path d="M11 5L6 9H2v6h4l5 4zM23 9l-6 6M17 9l6 6"/></svg><span>Voice off</span>';
    b.title = voice ? 'Replies are read aloud. Click to mute.' : 'Replies are text only. Click to have them read aloud.';
  }

  function paintWrites() {
    const b = $$('jv-writes');
    if (!b) return;
    b.innerHTML = writes ? '<svg viewBox="0 0 24 24"><path d="M5 11h14v10H5zM8 11V7a4 4 0 017.8-1.2"/></svg><span>Can act</span>' : '<svg viewBox="0 0 24 24"><path d="M5 11h14v10H5zM8 11V7a4 4 0 018 0v4"/></svg><span>Read-only</span>';
    b.title = writes ? 'Can send and change things. Click to make him read-only.' : 'Read-only: cannot send or change anything. Click to let him act.';
    b.classList.toggle('on', writes);
  }

  async function callChat(payload) {
    if (typeof db === 'undefined' || !db) throw new Error('Sign in first.');
    const { data: { session } } = await db.auth.getSession();
    if (!session) throw new Error('Your session has expired — sign in again.');
    const res = await fetch(_ep + '/functions/v1/quoteleadsai-chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: _ak, Authorization: 'Bearer ' + session.access_token },
      body: JSON.stringify(payload),
    });
    const out = await res.json();
    if (!res.ok || out.error) throw new Error(out.error || ('Request failed: ' + res.status));
    return out;
  }

  // Put the saved conversation back on screen. Best effort: if it fails the
  // panel still works, it just starts blank.
  async function restore() {
    if (restored) return;
    restored = true;
    try {
      const { lines } = await callChat({ action: 'history' });
      if (!Array.isArray(lines) || !lines.length) return;
      body().innerHTML = '';
      lines.forEach((l) => line(l.role === 'you' ? 'you' : 'quoteleadsai', l.text));
    } catch (_) { /* start blank */ }
  }

  return {
    // The settings modal needs these; everything else about the voice stays
    // private to this module.
    listVoices, setVoiceByName,
    currentVoice() { return pickVoice()?.name || null; },
    sampleVoice() { speakForce('Good evening. All systems are live.'); },
    toggle() { const p = $$('jv-panel'); p.classList.contains('open') ? this.close() : this.open(); },
    open() {
      if (typeof IS_REP !== 'undefined' && IS_REP) return;
      $$('jv-panel').classList.add('open');
      if (typeof loadQuoteLeadsAIInbox === 'function') loadQuoteLeadsAIInbox();
      if (!body().children.length) {
        line('sys', 'Ask about leads, closes, revenue, spend, a client or your tasks.<br>Tell him to remember something and he will, everywhere.');
      }
      restore();
      if (!window.SpeechRecognition && !window.webkitSpeechRecognition) $$('jv-mic').disabled = true;
      paintVoice();
      paintWrites();
      status('Ready', 'ready');
      $$('jv-input').focus();
    },
    // Start over. Clears the conversation, not what he remembers - facts saved
    // with "remember" survive this on purpose.
    async reset() {
      if (busy) return;
      try { await callChat({ action: 'reset' }); } catch (e) { line('sys', esc(e.message)); return; }
      hush();
      body().innerHTML = '';
      line('sys', 'New conversation.');
    },
    close() {
      const p = $$('jv-panel');
      p.classList.remove('open', 'hud');
      document.body.dataset.jv = 'idle';
      HUD_FX.stop();
      hush();
    },

    // Full screen. A skin over this same panel, not a second assistant: the
    // conversation, the microphone and every tool carry over untouched, so
    // anything he learns tomorrow works here the day it ships.
    toggleHud() {
      const p = $$('jv-panel');
      if (!p.classList.contains('open')) this.open();
      const on = p.classList.toggle('hud');
      $$('jv-hud-btn').title = on ? 'Exit full screen' : 'Full screen';
      $$('jv-hud-btn').querySelector('span').textContent = on ? 'Exit full screen' : 'Full screen';
      if (on) { HUD_FX.start(); loadHudStats(); $$('jv-input').focus(); }
      else HUD_FX.stop();
    },
    key(e) {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); ask(e.target.value); e.target.value = ''; }
    },
    // The More menu (admin screens). Closes on any click outside it.
    toggleMore(e) {
      const m = $$('jv-menu'), open = !m.classList.contains('open');
      if (e) e.stopPropagation();
      m.classList.toggle('open', open);
      $$('jv-more-btn').setAttribute('aria-expanded', open);
      if (open) document.addEventListener('click', function off(ev) {
        if (!m.contains(ev.target)) { m.classList.remove('open'); $$('jv-more-btn').setAttribute('aria-expanded', false); }
        document.removeEventListener('click', off);
      });
    },
    toggleVoice() {
      voice = !voice;
      localStorage.setItem('ql_quoteleadsai_voice', voice ? '1' : '0');
      paintVoice();
      if (!voice) hush();
    },
    toggleWrites() {
      // Per-browser, and on by default. With it OFF the edge function is not
      // even told the sending tools exist, so the switch is a real lock rather
      // than a prompt asking him nicely.
      writes = !writes;
      localStorage.setItem('ql_quoteleadsai_writes', writes ? '1' : '0');
      paintWrites();
      line('sys', writes
        ? 'Sending and changes are <b>on</b>. He will confirm before anything irreversible.'
        : 'Read-only. He can look at anything and change nothing.');
    },
    toggleMic() {
      if (!rec) rec = initMic();
      if (!rec) return;
      if (micOn) { rec.stop(); return; }
      // Still winding down from the last attempt (typically after an error):
      // cut it off, and let the next tap start clean.
      if (recRunning) { try { rec.abort(); } catch (_) {} return; }
      hush();
      // start() throws if it is already running or the page has no gesture
      // behind it. Swallowing that was the other half of the mic looking dead.
      try {
        rec.start(); recRunning = true; micOn = true; $$('jv-mic').classList.add('on');
      } catch (err) {
        micOn = false;
        $$('jv-mic').classList.remove('on');
        line('sys', 'Could not start the microphone: ' + (err?.message || err));
      }
    },
    ask
  };
})();
