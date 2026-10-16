// Virtual clock for pages that animate on their own time instead of exposing
// window.webreel.frame(t). render.mjs installs it before any page script runs (only
// on a second load, once the page turned out not to set window.webreel).
//
// Page time stands still until the exporter seeks: performance.now(), Date,
// requestAnimationFrame and timers are replaced, and CSS / Web Animations are
// paused and positioned from the same clock. Seeking only moves forward, one video
// frame at a time, so stateful animation loops replay the same way every run.
(() => {
  if (window.__webreelClock || window !== window.top) return;
  const RealDate = Date;
  const real = { now: performance.now.bind(performance), setTimeout: setTimeout.bind(window), clearTimeout: clearTimeout.bind(window) };
  const origin = real.now(), epoch = RealDate.now();
  let now = origin, started = false;

  const fail = error => real.setTimeout(() => { throw error; });
  const call = (fn, args) => { try { typeof fn === 'function' ? fn(...args) : Function(String(fn))(); } catch (error) { fail(error); } };

  // Timers fire in due order, each at its own due time.
  const timers = new Map();
  let timerId = 0, pumping = false;
  function nextDue(limit) {
    let due = null;
    for (const timer of timers.values()) if (timer.at <= limit && (!due || timer.at < due.at || (timer.at === due.at && timer.id < due.id))) due = timer;
    return due;
  }
  function runTimers(limit, budget) {
    for (let n = 0; ; n++) {
      const due = nextDue(limit);
      if (!due) return true;
      if (n >= budget) return false;
      if (due.at > now) now = due.at;
      if (due.every) due.at += due.every; else timers.delete(due.id);
      call(due.fn, due.args);
    }
  }
  // Zero-delay timers still run while time stands still (page start-up code
  // often defers work that way); they yield to the real event loop in batches.
  function pump() { pumping = false; if (!runTimers(now, 1000)) schedulePump(); }
  function schedulePump() { if (!pumping) { pumping = true; real.setTimeout(pump, 0); } }
  window.setTimeout = (fn, delay = 0, ...args) => {
    const id = ++timerId, at = now + Math.max(0, Number(delay) || 0);
    timers.set(id, { id, fn, args, at });
    if (at <= now) schedulePump();
    return id;
  };
  window.setInterval = (fn, delay = 0, ...args) => {
    const id = ++timerId, every = Math.max(1, Number(delay) || 0);
    timers.set(id, { id, fn, args, every, at: now + every });
    return id;
  };
  window.clearTimeout = window.clearInterval = id => { timers.delete(id); };

  const frames = new Map();
  let frameId = 0;
  window.requestAnimationFrame = callback => { const id = ++frameId; frames.set(id, callback); return id; };
  window.cancelAnimationFrame = id => { frames.delete(id); };

  performance.now = () => now;
  function VirtualDate(...args) {
    if (!new.target) return new RealDate(VirtualDate.now()).toString();
    return args.length ? new RealDate(...args) : new RealDate(VirtualDate.now());
  }
  VirtualDate.prototype = RealDate.prototype;
  VirtualDate.now = () => epoch + (now - origin);
  VirtualDate.parse = RealDate.parse; VirtualDate.UTC = RealDate.UTC;
  window.Date = VirtualDate;

  // CSS / Web Animations run on the real document timeline, so each one is
  // paused and positioned at (virtual now − the virtual time it started).
  const starts = new WeakMap(), byElement = new WeakMap(), heldByPage = new WeakSet();
  let carried = null;
  const keyOf = a => a.animationName ? `a:${a.animationName}` : a.transitionProperty ? `t:${a.transitionProperty}` : null;
  function register() {
    for (const a of document.getAnimations()) {
      if (starts.has(a)) continue;
      const el = a.effect?.target, key = keyOf(a) && `${keyOf(a)}${a.effect?.pseudoElement ?? ''}`;
      const start = (carried && el && key && carried.get(el)?.get(key)) ?? now;
      starts.set(a, start);
      if (a.playState === 'paused') heldByPage.add(a);
      if (el && key) { if (!byElement.has(el)) byElement.set(el, new Map()); byElement.get(el).set(key, start); }
    }
  }
  function apply() {
    for (const a of document.getAnimations()) {
      const start = starts.get(a);
      if (start === undefined || heldByPage.has(a) || a.playState === 'finished') continue;
      const rate = a.playbackRate, position = (now - start) * rate;
      const end = a.effect?.getComputedTiming().endTime ?? Infinity;
      // finish() rather than parking a paused animation at its end, so
      // animationend / finish handlers still run.
      if (rate > 0 && Number.isFinite(end) && position >= end) { a.finish(); continue; }
      if (a.playState !== 'paused') a.pause();
      a.currentTime = position;
    }
  }

  const settle = () => new Promise(resolve => real.setTimeout(resolve, 0));
  function step(target) {
    if (!runTimers(target, 100000)) throw Error('Timers keep rescheduling themselves without letting time advance');
    now = target;
    const callbacks = [...frames.values()]; frames.clear();
    for (const callback of callbacks) call(callback, [now]);
    register();
  }

  window.__webreelClock = {
    real,
    get time() { return (now - origin) / 1000; },
    // Advance to t seconds after page start, running one animation frame per
    // 1/fps. The first seek also runs the frame the page has been waiting for.
    async seek(t, fps) {
      const target = origin + t * 1000, dt = 1000 / fps;
      if (target < now - 1e-6) throw Error(`The virtual clock cannot go back (at ${((now - origin) / 1000).toFixed(3)} s, asked for ${t.toFixed(3)} s)`);
      if (!started) { started = true; await settle(); step(now); }
      while (now + dt < target - 1e-6) { step(now + dt); await settle(); }
      if (target > now + 1e-6) step(target);
      await settle();
      register(); apply();
    },
    // Moving elements in the DOM restarts their CSS animations; keep their start.
    preserve(fn) {
      register(); carried = byElement;
      try { return fn(); } finally { register(); carried = null; apply(); }
    },
    // Length of a page made only of finite CSS / Web Animations.
    inferDuration() {
      register();
      if (frames.size) return { error: 'it runs requestAnimationFrame callbacks' };
      if (timers.size) return { error: 'it has pending timers' };
      let end = 0, count = 0;
      for (const a of document.getAnimations()) {
        const finish = a.effect?.getComputedTiming().endTime;
        if (!Number.isFinite(finish)) return { error: 'an animation repeats forever' };
        end = Math.max(end, starts.get(a) - origin + finish / Math.abs(a.playbackRate || 1)); count++;
      }
      return count ? { duration: end / 1000 } : { error: 'no animation was found' };
    }
  };
})();
