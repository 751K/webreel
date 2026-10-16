#!/usr/bin/env node
// Animated HTML page → video without per-frame screenshots.
// The host starts Chrome, serves the page read-only, and writes the MP4 the page
// encodes with WebCodecs, or encodes the page's raw frames with ffmpeg (10-bit,
// ProRes). Screenshots are only used as a fallback and for checks.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PAGE_MODULES = ['export.mjs', 'gpu.mjs', 'media.mjs', 'mp4.mjs', 'ssim.mjs'];
const CLOCK_SOURCE = fs.readFileSync(path.join(HERE, 'page', 'clock.js'), 'utf8');
const PRORES = { proxy: '422 Proxy', lt: '422 LT', standard: '422', hq: '422 HQ', '4444': '4444', xq: '4444 XQ' };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// Every failure has a stable code, a message and, where there is one, the next step.
// --json prints them as { ok: false, error: { code, message, hint } }; the exit
// code groups them: 2 usage, 3 the page, 4 fidelity (frames would not match the
// browser), 5 environment, 1 anything else.
const EXIT = { USAGE: 2, OUTPUT_EXISTS: 2, NEEDS_DURATION: 3, INTERVAL: 3, NO_FRAME_SOURCE: 3, PAGE: 3, PAGE_LOAD: 3,
  CHECK_FAILED: 4, HIC_REFUSED: 4, UNSUPPORTED_STYLE: 4, CHROME_NOT_FOUND: 5, FFMPEG: 5, SOFTWARE_GL: 5, HIC_UNAVAILABLE: 5, ENCODER: 5 };
class WebreelError extends Error {
  constructor(code, message, hint = null) { super(message); this.code = code; this.hint = hint; }
}
const usage = (message, hint = 'see webreel --help') => new WebreelError('USAGE', message, hint);
let say = console.log; // progress and logs; stderr with --json, so stdout holds only the result

// Stopped with Ctrl-C or kill: stop Chrome, ffmpeg and batch jobs and remove the
// partial output, instead of leaving them running (as happened to a killed batch).
const onStop = new Set();
for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143], ['SIGHUP', 129]]) process.on(signal, () => {
  for (const stop of onStop) try { stop(); } catch {}
  process.exit(code);
});

// Frame pacing is what makes headless capture slow: without these flags every
// paint waits for a 60 Hz vsync. CanvasDrawElement enables html-in-canvas.
const CHROME_FLAGS = ['--headless=new', '--enable-gpu', '--no-first-run', '--no-default-browser-check',
  '--disable-background-networking', '--disable-component-update', '--remote-debugging-pipe', '--no-startup-window',
  '--disable-frame-rate-limit', '--disable-gpu-vsync', '--enable-blink-features=CanvasDrawElement'];

const HELP = `webreel — export an animated HTML page to video without per-frame screenshots

webreel [render] PAGE.html --out movie.mp4 [options]   export the page
webreel batch JOBS.json [--parallel N] [--overwrite]
                        several exports from one file, N at a time (default 2), then
                        optional lossless joins; see "Batch files" below
webreel check PAGE.html [--at T,T,…] [--out DIR] [options]
                        no export: report stage size, length, capture path (and why
                        it would fall back to screenshots), compare frames at --at
                        (default: start, middle, end) with screenshots, and save them
                        as PNG into DIR
(webreel = node webreel/render.mjs)

  --json                print one JSON object on stdout (result, or the error with a
                        code and a hint); logs go to stderr

  --root DIR            directory served to the page (default: the page's folder)
  --start S             first second to render (default 0)
  --duration S          seconds to render (default: to the end of the page's animations)
  --fps N[/D]           frame rate, e.g. 30 or 60000/1001 (default 60)
  --scale 1|2|3         device pixel ratio; 2 gives 4K for a 1920×1080 stage
  --codec h264|hevc|prores
                        (default h264; prores with --alpha)
  --depth 8|10          10: HEVC Main10 .mov/.mp4 via ffmpeg + VideoToolbox on the host
                        (raw frames leave the page; needs ffmpeg). Without --bitrate it
                        encodes at constant quality -q:v 80; --ffmpeg PATH picks ffmpeg
  --prores PROFILE      proxy|lt|standard|hq|4444|xq for --codec prores, a .mov encoded
                        by ffmpeg + VideoToolbox like --depth 10 (default hq; 4444 with --alpha)
  --alpha               keep transparency: where the page has no background the video is
                        transparent (ProRes 4444/XQ, straight alpha)
  --bitrate BPS         (default 24 Mbps at 1080p, scaled with pixel count)
  --capture auto|hic|screenshot
                        auto: html-in-canvas, falling back to screenshots when the
                        page cannot be drawn that way (default auto)
  --check N             compare N frames with screenshots of the unmodified page
                        (default 3, 0 to skip); the export fails below the thresholds
  --check-min X         minimum whole-frame SSIM (default 0.98)
  --check-tile X        minimum SSIM of the worst 128×128 tile (default 0.90)
  --clock auto|virtual|off
                        auto: run the page on the virtual clock unless it sets
                        window.webreel within --wait seconds of loading (default 2);
                        virtual: always; off: require window.webreel
  --scene N             legacy pages exposing renderAt(scene, t) and scenes[]
  --q 'a=1&b=2'         extra query parameters for the page
  --chrome PATH         Chrome executable; --chrome-flag FLAG adds a launch flag
  --queue N             encoder queue depth (default 8)
  --allow-software      allow software WebGL
  --overwrite           replace an existing output (only after a complete export)

Batch files: { "defaults": { "scale": 2, "depth": 10 },
               "jobs": [ { "page": "a.html", "out": "a.mov", "scene": 1 }, … ],
               "concat": [ { "out": "ab.mov", "parts": ["a.mov", "b.mov"] } ] }
Job keys are the options above without "--" (true for flags); paths are relative to
the batch file. Every job is validated before any starts.

Exit codes: 0 ok, 2 usage, 3 page (e.g. NEEDS_DURATION), 4 fidelity (CHECK_FAILED,
HIC_REFUSED, UNSUPPORTED_STYLE), 5 environment (Chrome, ffmpeg, GPU), 1 other.

Any animated page works as is: CSS animations, Web Animations, requestAnimationFrame
loops and timers run on a virtual clock that advances one video frame at a time.
Pass --duration unless the page consists only of finite CSS / Web Animations.
Optionally a page can draw any moment itself: window.webreel = { frame(t), duration,
width?, height?, ready? } (the older name window.film works too). The stage is
width × height from there, else the
<meta name="viewport" content="width=…, height=…">, else 1920 × 1080.`;

// --- batch --------------------------------------------------------------------------

function parseBatch(args) {
  const o = { command: 'batch', parallel: 2, overwrite: false, json: false };
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (flag === '--overwrite') o.overwrite = true;
    else if (flag === '--json') o.json = true;
    else if (flag === '--parallel') o.parallel = Number(args[++i]);
    else if (!flag.startsWith('--') && !o.file) o.file = flag;
    else throw usage(`Unknown batch argument: ${flag}`, 'webreel batch JOBS.json [--parallel N] [--overwrite] [--json]');
  }
  if (!o.file) throw usage('JOBS.json is required', 'webreel batch JOBS.json [--parallel N] [--overwrite] [--json]');
  if (!Number.isInteger(o.parallel) || o.parallel < 1 || o.parallel > 8) throw usage('--parallel must be 1...8');
  let spec;
  try { spec = JSON.parse(fs.readFileSync(o.file, 'utf8')); } catch (error) { throw usage(`Cannot read the batch file ${o.file}: ${error.message}`); }
  const base = path.dirname(path.resolve(o.file)), list = Array.isArray(spec) ? spec : spec?.jobs;
  if (!Array.isArray(list) || !list.length) throw usage('The batch file needs a non-empty "jobs" array');
  const flags = options => Object.entries(options).flatMap(([key, value]) =>
    value === false || value === null ? [] : value === true ? [`--${key}`] : (Array.isArray(value) ? value : [value]).flatMap(v => [`--${key}`, String(v)]));
  const seen = new Set();
  o.jobs = list.map((job, k) => {
    const { page, out, name, ...rest } = { ...spec.defaults, ...job };
    const label = name ?? (out ? path.basename(out) : `job ${k + 1}`);
    if (!page || !out) throw usage(`Batch job ${k + 1} needs "page" and "out"`);
    const target = path.resolve(base, out);
    if (seen.has(target)) throw usage(`Two batch jobs write ${out}`);
    seen.add(target);
    const args = [path.resolve(base, page), '--out', target, ...flags(rest), ...(o.overwrite ? ['--overwrite'] : [])];
    try { const parsed = parse([...args]); return { name: label, args, out: target, codec: parsed.codec, container: parsed.container }; }
    catch (error) { throw new WebreelError(error.code ?? 'USAGE', `Batch job "${label}": ${error.message}`, error.hint); }
  });
  o.concat = (Array.isArray(spec) ? [] : spec.concat ?? []).map((join, k) => {
    if (!join?.out || !Array.isArray(join.parts) || join.parts.length < 2) throw usage(`Concat ${k + 1} needs "out" and at least two "parts"`);
    const out = path.resolve(base, join.out), parts = join.parts.map(part => path.resolve(base, part));
    const jobs = parts.map(part => o.jobs.find(job => job.out === part));
    if (jobs.some(job => !job)) throw usage(`Concat ${join.out}: every part must be the "out" of a job in this file`);
    if (new Set(jobs.map(job => `${job.codec}/${job.container}`)).size > 1 || path.extname(out).toLowerCase().slice(1) !== jobs[0].container)
      throw usage(`Concat ${join.out}: the parts and the result must share one codec and container`);
    if (seen.has(out)) throw usage(`Concat ${join.out} would overwrite a job's output`);
    if (fs.existsSync(out) && !o.overwrite) throw new WebreelError('OUTPUT_EXISTS', `Output already exists: ${out}`, 'pass --overwrite, or choose another "out"');
    seen.add(out);
    return { out, parts, codec: jobs[0].codec, container: jobs[0].container };
  });
  if (o.concat.length) requireFfmpeg({ ffmpeg: 'ffmpeg', codec: null });
  return o;
}

// One job = one child process of this file with --json, so a crash or hang in
// one page cannot take the others down; their logs are prefixed with the name.
function runJob(job) {
  return new Promise(resolve => {
    const began = performance.now();
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), ...job.args, '--json'], { stdio: ['ignore', 'pipe', 'pipe'] });
    const stop = () => child.kill('SIGTERM'); // the job cleans up after itself
    onStop.add(stop); child.once('close', () => onStop.delete(stop));
    let stdout = '', partial = '';
    child.stdout.setEncoding('utf8'); child.stdout.on('data', data => stdout += data);
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', data => {
      const lines = (partial + data).split('\n'); partial = lines.pop();
      for (const line of lines) if (line.trim()) say(`[${job.name}] ${line}`);
    });
    child.on('close', code => {
      let result;
      try { result = JSON.parse(stdout.trim().split('\n').pop()); }
      catch { result = { ok: false, error: { code: 'ERROR', message: `the export exited (${code}) without a result`, hint: null } }; }
      resolve({ ...result, name: job.name, out: job.out, seconds: (performance.now() - began) / 1000 });
    });
  });
}

// Joins parts that the jobs encoded with identical settings, without re-encoding.
function concatParts(join, results, overwrite) {
  const parts = join.parts.map(part => results.find(result => result.out === part));
  if (parts.some(part => !part?.ok)) return { out: join.out, ok: false, error: { code: 'SKIPPED', message: 'a part failed to export', hint: null } };
  const shape = part => [part.width, part.height, part.fpsNum, part.fpsDen, part.alpha, part.prores, part.depth].join('/');
  if (new Set(parts.map(shape)).size > 1) return { out: join.out, ok: false, error: { code: 'USAGE', message: 'the parts differ in size, frame rate, depth or alpha', hint: 'give the joined jobs the same scale, fps, depth and codec options' } };
  const list = path.join(path.dirname(join.out), `.${path.basename(join.out)}.${crypto.randomUUID()}.txt`);
  const staging = path.join(path.dirname(join.out), `.${path.basename(join.out)}.${crypto.randomUUID()}.partial`);
  try {
    fs.writeFileSync(list, join.parts.map(part => `file '${part.replace(/'/g, "'\\''")}'`).join('\n') + '\n');
    const run = spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', list, '-map', '0:v', '-c', 'copy',
      ...(join.codec === 'hevc' ? ['-tag:v', 'hvc1'] : []), '-movflags', '+write_colr', '-f', join.container, staging], { encoding: 'utf8' });
    if (run.status !== 0) return { out: join.out, ok: false, error: { code: 'FFMPEG', message: `ffmpeg concat failed: ${run.stderr || run.error?.message}`, hint: null } };
    const counted = spawnSync('ffprobe', ['-v', 'error', '-count_packets', '-select_streams', 'v:0', '-show_entries', 'stream=nb_read_packets', '-of', 'csv=p=0', staging], { encoding: 'utf8' });
    const frames = Number(counted.stdout.trim()), expected = parts.reduce((sum, part) => sum + part.frames, 0);
    if (frames !== expected) return { out: join.out, ok: false, error: { code: 'ERROR', message: `the joined file has ${frames} frames, expected ${expected}`, hint: null } };
    if (fs.existsSync(join.out) && !overwrite) return { out: join.out, ok: false, error: { code: 'OUTPUT_EXISTS', message: `Output appeared meanwhile: ${join.out}`, hint: 'pass --overwrite' } };
    fs.renameSync(staging, join.out);
    const { width, height, fpsNum, fpsDen, codec, depth, alpha } = parts[0];
    const report = { output: join.out, frames, width, height, fpsNum, fpsDen, codec, depth, alpha, parts: join.parts };
    fs.writeFileSync(join.out + '.json', JSON.stringify(report, null, 2) + '\n');
    return { out: join.out, ok: true, frames, parts: join.parts, report: join.out + '.json' };
  } finally { fs.rmSync(list, { force: true }); fs.rmSync(staging, { force: true }); }
}

async function runBatch(options) {
  const began = performance.now(), results = new Array(options.jobs.length);
  say(`${options.jobs.length} jobs, ${Math.min(options.parallel, options.jobs.length)} at a time`);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(options.parallel, options.jobs.length) }, async () => {
    while (next < options.jobs.length) {
      const k = next++, result = results[k] = await runJob(options.jobs[k]);
      say(result.ok ? `[${result.name}] done: ${result.frames} frames, ${result.capture}, ${result.seconds.toFixed(1)} s → ${result.out}`
        : `[${result.name}] FAILED [${result.error.code}] ${result.error.message}${result.error.hint ? ` (hint: ${result.error.hint})` : ''}`);
    }
  }));
  const joins = options.concat.map(join => concatParts(join, results, options.overwrite));
  for (const join of joins) say(join.ok ? `joined ${join.parts.length} parts, ${join.frames} frames → ${join.out}` : `join ${join.out} FAILED [${join.error.code}] ${join.error.message}`);
  const failures = [...results, ...joins].filter(r => !r.ok);
  if (failures.length) process.exitCode = EXIT[failures[0].error.code] ?? 1;
  say(failures.length ? `${failures.length} of ${results.length + joins.length} failed` : `all ${results.length} jobs done in ${((performance.now() - began) / 1000).toFixed(1)} s`);
  return { ok: !failures.length, command: 'batch', parallel: options.parallel, seconds: (performance.now() - began) / 1000,
    jobs: results.map(r => r.ok ? { name: r.name, ok: true, out: r.out, frames: r.frames, capture: r.capture, fallbackReason: r.fallbackReason, seconds: r.seconds, warnings: r.warnings, report: r.report }
      : { name: r.name, ok: false, out: r.out, error: r.error, seconds: r.seconds }),
    concat: joins };
}

function parse(args) {
  let command = 'render';
  if (args[0] === 'render' || args[0] === 'check') command = args.shift();
  const o = { command, json: false, at: null, start: 0, duration: null, scale: 1, codec: null, depth: 8, prores: null, alpha: false, ffmpeg: 'ffmpeg', bitrate: null, fpsNum: 60, fpsDen: 1, queue: 8,
    capture: 'auto', clock: 'auto', wait: 2, check: 3, checkMin: 0.98, checkTile: 0.90, scene: 0, q: '', software: false, overwrite: false, chromeFlags: [] };
  const strings = { '--root': 'root', '--out': 'out', '--codec': 'codec', '--prores': 'prores', '--ffmpeg': 'ffmpeg', '--capture': 'capture', '--clock': 'clock', '--chrome': 'chrome', '--q': 'q' };
  const numbers = { '--start': 'start', '--duration': 'duration', '--scale': 'scale', '--bitrate': 'bitrate', '--queue': 'queue',
    '--check': 'check', '--check-min': 'checkMin', '--check-tile': 'checkTile', '--scene': 'scene', '--wait': 'wait', '--depth': 'depth' };
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (flag === '--help' || flag === '-h') return null;
    if (flag === '--overwrite') { o.overwrite = true; continue; }
    if (flag === '--allow-software') { o.software = true; continue; }
    if (flag === '--alpha') { o.alpha = true; continue; }
    if (flag === '--json') { o.json = true; continue; }
    if (!flag.startsWith('--')) { if (o.pageFile) throw usage(`Unexpected argument: ${flag}`); o.pageFile = flag; continue; }
    const value = args[++i]; if (value === undefined) throw usage(`Missing value for ${flag}`);
    if (flag === '--chrome-flag') o.chromeFlags.push(value);
    else if (flag === '--at' && command === 'check') o.at = value.split(',').map(Number);
    else if (flag === '--fps') { const [n, d = '1'] = value.split('/'); o.fpsNum = Number(n); o.fpsDen = Number(d); }
    else if (strings[flag]) o[strings[flag]] = value;
    else if (numbers[flag]) o[numbers[flag]] = Number(value);
    else throw usage(`Unknown option: ${flag}`);
  }
  if (!o.pageFile) throw usage('PAGE.html is required');
  if (command === 'render' && !o.out) throw usage('--out FILE is required', 'pass --out movie.mp4 (or .mov for --depth 10 / ProRes)');
  if (!fs.existsSync(o.pageFile)) throw usage(`Page not found: ${o.pageFile}`, 'pass the path of an existing .html file');
  const pageFile = fs.realpathSync(o.pageFile);
  o.root = fs.realpathSync(o.root ?? path.dirname(pageFile));
  if (!within(o.root, pageFile) || !fs.statSync(pageFile).isFile()) throw usage('The page must be a file inside --root');
  o.page = path.relative(o.root, pageFile).split(path.sep).join('/');
  if (o.out) o.out = path.resolve(o.out);
  if (o.at && !(o.at.length && o.at.every(t => Number.isFinite(t) && t >= 0))) throw usage('--at takes seconds separated by commas, e.g. --at 0,1.5,3');
  if (![8, 10].includes(o.depth)) throw usage('--depth must be 8 or 10');
  if (o.depth === 10 && o.codec === 'h264') throw usage('--depth 10 is HEVC Main10; drop --codec h264');
  o.codec ??= o.alpha || o.prores ? 'prores' : o.depth === 10 ? 'hevc' : 'h264';
  if (!['h264', 'hevc', 'prores'].includes(o.codec)) throw usage('--codec must be h264, hevc or prores');
  if (o.codec === 'prores') {
    if (o.depth === 10) throw usage('ProRes is always 10-bit or more; drop --depth 10');
    o.prores ??= o.alpha ? '4444' : 'hq';
    if (!['proxy', 'lt', 'standard', 'hq', '4444', 'xq'].includes(o.prores)) throw usage('--prores must be proxy, lt, standard, hq, 4444 or xq');
    if (o.alpha && !['4444', 'xq'].includes(o.prores)) throw usage('--alpha needs --prores 4444 or xq; 422 profiles have no alpha channel');
    if (o.bitrate !== null) throw usage('ProRes has no --bitrate; pick a quality with --prores');
  } else {
    if (o.prores) throw usage('--prores needs --codec prores');
    if (o.alpha) throw usage('H.264/HEVC have no alpha channel; --alpha exports ProRes 4444 (drop --codec)');
  }
  // Encoded by ffmpeg on the host from raw RGBA frames, instead of WebCodecs in the page.
  o.hostEncode = o.depth === 10 || o.codec === 'prores';
  // HEVC Main10 frames come back as P010 converted on the GPU; WEBREEL_READBACK=rgba forces RGBA.
  o.readback = o.codec === 'hevc' && o.hostEncode && process.env.WEBREEL_READBACK !== 'rgba' ? 'p010' : 'rgba';
  o.container = command === 'render' ? path.extname(o.out).toLowerCase().slice(1) : null;
  if (command === 'render') {
    if (o.codec === 'prores' && o.container !== 'mov') throw usage('ProRes output must be a .mov file');
    if (!o.hostEncode && o.container !== 'mp4') throw usage('--out must be an .mp4 file', 'use .mp4, or .mov with --depth 10 / --codec prores');
    if (o.depth === 10 && !['mp4', 'mov'].includes(o.container)) throw usage('--out must be an .mp4 or .mov file');
    if (fs.existsSync(o.out) && !o.overwrite) throw new WebreelError('OUTPUT_EXISTS', `Output already exists: ${o.out}`, 'pass --overwrite, or choose another --out');
  } else if (o.out && fs.existsSync(o.out) && !fs.statSync(o.out).isDirectory()) throw usage('For check, --out is a directory for the PNG stills');
  if (!Number.isFinite(o.start) || o.start < 0) throw usage('Invalid --start');
  if (o.duration !== null && !(Number.isFinite(o.duration) && o.duration > 0)) throw usage('Invalid --duration');
  if (![1, 2, 3].includes(o.scale)) throw usage('--scale must be 1, 2 or 3');
  if (![o.fpsNum, o.fpsDen].every(n => Number.isInteger(n) && n > 0 && n <= 1000000) || o.fpsNum / o.fpsDen > 240) throw usage('Invalid --fps');
  if (o.bitrate !== null && !(Number.isInteger(o.bitrate) && o.bitrate >= 100000 && o.bitrate <= 500000000)) throw usage('Invalid --bitrate');
  if (!Number.isInteger(o.queue) || o.queue < 1 || o.queue > 32) throw usage('--queue must be 1...32');
  if (!Number.isInteger(o.check) || o.check < 0 || o.check > 50) throw usage('--check must be 0...50');
  if (!(o.checkMin > 0 && o.checkMin <= 1 && o.checkTile > 0 && o.checkTile <= 1)) throw usage('Check thresholds must be in (0, 1]');
  if (!Number.isInteger(o.scene) || o.scene < 0) throw usage('Invalid --scene');
  if (!['auto', 'hic', 'screenshot'].includes(o.capture)) throw usage('--capture must be auto, hic or screenshot');
  if (!['auto', 'virtual', 'off'].includes(o.clock)) throw usage('--clock must be auto, virtual or off');
  if (!(o.wait >= 0 && o.wait <= 60)) throw usage('--wait must be 0...60 seconds');
  const chromeCandidates = [o.chrome, process.env.CHROME_PATH, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome', '/usr/bin/chromium'].filter(Boolean);
  o.chrome = chromeCandidates.find(p => fs.existsSync(p));
  if (!o.chrome) throw new WebreelError('CHROME_NOT_FOUND', 'Chrome not found', 'install Google Chrome, or pass --chrome PATH (or set CHROME_PATH)');
  return o;
}
function within(root, file) { const r = path.relative(root, file); return r === '' || (!r.startsWith('..' + path.sep) && r !== '..' && !path.isAbsolute(r)); }
async function body(req, limit = 128 * 1024 * 1024) {
  const chunks = []; let length = 0;
  for await (const chunk of req) { length += chunk.length; if (length > limit) throw Error('Request body too large'); chunks.push(chunk); }
  return Buffer.concat(chunks);
}

class CDP {
  constructor(chrome) {
    this.chrome = chrome; this.next = 0; this.pending = new Map(); this.buffer = '';
    chrome.stdio[4].setEncoding('utf8');
    chrome.stdio[4].on('data', text => {
      this.buffer += text;
      let at;
      while ((at = this.buffer.indexOf('\0')) >= 0) {
        const record = this.buffer.slice(0, at); this.buffer = this.buffer.slice(at + 1);
        if (!record) continue;
        let message;
        try { message = JSON.parse(record); } catch { continue; }
        const task = this.pending.get(message.id);
        if (!task) continue;
        this.pending.delete(message.id); clearTimeout(task.timer);
        if (message.error) task.reject(Error(JSON.stringify(message.error))); else task.resolve(message.result);
      }
    });
    chrome.once('exit', (code, signal) => this.rejectAll(Error(`Chrome exited (${code ?? signal})`)));
    chrome.once('error', error => this.rejectAll(error));
    chrome.stdio[3].on('error', error => this.rejectAll(error));
    chrome.stdio[4].on('error', error => this.rejectAll(error));
  }
  rejectAll(error) { for (const t of this.pending.values()) { clearTimeout(t.timer); t.reject(error); } this.pending.clear(); }
  send(method, params = {}, sessionId, timeout = 30000) {
    const id = ++this.next;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(Error(`CDP timed out: ${method}`)); }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      this.chrome.stdio[3].write(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }) + '\0');
    });
  }
  async evaluate(expression, session, timeout = 30000) {
    const result = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, session, timeout);
    if (result.exceptionDetails) throw Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    return result.result.value;
  }
}

const checkError = (failed, options) => new WebreelError('CHECK_FAILED',
  `Frame check failed (SSIM mean ≥ ${options.checkMin}, worst tile ≥ ${options.checkTile} required): ` +
  failed.map(c => `t=${c.t.toFixed(3)}s mean ${c.mean.toFixed(4)}, worst tile ${c.worstTile.toFixed(4)} at [${c.worstTileRect}]`).join('; ') +
  '. The html-in-canvas frames differ from the browser\'s own rendering', 'rerun with --capture screenshot');

// The frame times `webreel check` looks at: --at snapped to the frame grid, else the
// first, middle and last frame (only the first when the length is unknown).
function checkTimes(options, info) {
  const fps = options.fpsNum / options.fpsDen, last = info.frameCount === null ? Infinity : info.frameCount - 1;
  const frames = options.at
    ? options.at.map(t => {
      const i = Math.round((t - options.start) * fps);
      if (i < 0 || i > last) throw usage(`--at ${t} is outside the rendered interval (${options.start} s + ${info.duration} s)`);
      return i;
    })
    : info.frameCount === null ? [0] : [0, Math.floor(last / 2), last];
  return [...new Set(frames)].sort((a, b) => a - b).map(i => options.start + i / fps);
}

// Fail early, before Chrome starts, when ffmpeg or its VideoToolbox encoder is missing.
function requireFfmpeg(options) {
  const encoder = options.codec === 'prores' ? 'prores_videotoolbox' : 'hevc_videotoolbox';
  const probe = spawnSync(options.ffmpeg, ['-hide_banner', '-encoders'], { encoding: 'utf8' });
  if (probe.error) throw new WebreelError('FFMPEG', `ffmpeg not found (${options.ffmpeg}): ${probe.error.message}`, 'install ffmpeg (brew install ffmpeg) or pass --ffmpeg PATH');
  if (!probe.stdout.includes(encoder)) throw new WebreelError('FFMPEG', `This ffmpeg has no ${encoder} encoder`, 'use an ffmpeg built with VideoToolbox (macOS), e.g. from Homebrew');
}

async function run(options) {
  const render = options.command === 'render';
  if (render && options.hostEncode) requireFfmpeg(options);
  const outDir = render ? path.dirname(options.out) : options.out;
  if (outDir) fs.mkdirSync(outDir, { recursive: true });
  const staging = render ? path.join(outDir, `.${path.basename(options.out)}.${crypto.randomUUID()}.partial`) : null;
  const warnings = [], stills = [];
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'webreel-chrome-'));
  const endpoint = `/__webreel/${crypto.randomBytes(20).toString('hex')}`;
  let fd = null, position = 0, finalized = false, serverFailure = null;
  let cdp, session, stage = { width: 1920, height: 1080 };
  const samples = []; // raw RGBA check frames of virtual-clock pages
  let encoder = null, frameBytes = 0;  // ffmpeg for --depth 10 and ProRes
  const startEncoder = (width, height) => {
    const p010 = options.readback === 'p010';
    frameBytes = width * height * (p010 ? 3 : 4);
    // BT.709 matrix, limited range; then
    // P010 for HEVC Main10, 4:2:2 or 4:4:4 (with alpha) 16-bit for ProRes.
    const format = options.codec === 'hevc' ? 'p010le' : options.alpha ? 'ayuv64le' : ['4444', 'xq'].includes(options.prores) ? 'p416le' : 'p216le';
    const codec = options.codec === 'hevc'
      ? ['-c:v', 'hevc_videotoolbox', '-profile:v', 'main10', ...(options.bitrate ? ['-b:v', String(options.bitrate)] : ['-q:v', '80']),
        '-bf', '0', '-g', String(Math.max(1, Math.round(2 * options.fpsNum / options.fpsDen))), '-tag:v', 'hvc1']
      : ['-c:v', 'prores_videotoolbox', '-profile:v', options.prores];
    const args = ['-v', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', p010 ? 'p010le' : 'rgba', '-s', `${width}x${height}`, '-framerate', `${options.fpsNum}/${options.fpsDen}`, '-i', '-',
      '-vf', `${p010 ? '' : `scale=out_color_matrix=bt709:out_range=tv:flags=accurate_rnd+full_chroma_int,format=${format},`}setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv`,
      ...codec, '-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709', '-color_range', 'tv', '-movflags', '+write_colr',
      '-f', options.container, staging];
    const child = spawn(options.ffmpeg, args, { stdio: ['pipe', 'ignore', 'pipe'] });
    let stderr = '', failed = null;
    child.stderr.setEncoding('utf8'); child.stderr.on('data', d => stderr = (stderr + d).slice(-8192));
    child.on('error', e => failed = e); child.stdin.on('error', e => failed ??= e);
    const exited = new Promise(resolve => child.once('close', code => resolve(code)));
    const check = () => { if (failed || child.exitCode !== null) throw failed ?? Error(`ffmpeg exited: ${stderr}`); };
    let pending = 0, tail = Promise.resolve();
    const room = [];
    encoder = {
      child,
      // Takes a whole frame and writes it in the background, at most two frames
      // ahead: the page sends the next frame while ffmpeg reads this one. Writing
      // the request's 64 KB chunks one by one, each waiting for the pipe, held
      // 4K 10-bit exports to ~31 fps on a trivial page (now ~33; ffmpeg alone: 57).
      async queue(chunks) {
        check();
        while (pending >= 2) await new Promise(resolve => room.push(resolve));
        pending++;
        tail = tail.then(async () => {
          let open = true;
          for (const chunk of chunks) open = child.stdin.write(chunk);
          if (!open) await Promise.race([once(child.stdin, 'drain'), exited]);
          check();
        }).catch(error => { failed ??= error; }).finally(() => { pending--; room.shift()?.(); });
      },
      async end() {
        await tail; check();
        child.stdin.end();
        const code = await exited;
        if (failed || code !== 0) throw failed ?? Error(`ffmpeg failed (${code}): ${stderr}`);
      }
    };
  };
  const screenshot = async () => {
    const { data } = await cdp.send('Page.captureScreenshot', { format: 'png', optimizeForSpeed: true, fromSurface: true, captureBeyondViewport: false,
      clip: { x: 0, y: 0, width: stage.width, height: stage.height, scale: 1 } }, session, 60000);
    return Buffer.from(data, 'base64');
  };
  const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json',
    '.css': 'text/css', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif',
    '.svg': 'image/svg+xml', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf',
    '.mp4': 'video/mp4', '.webm': 'video/webm', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.glb': 'model/gltf-binary', '.gltf': 'model/gltf+json' };
  const server = http.createServer(async (req, res) => {
    try {
      const pathname = decodeURIComponent(new URL(req.url, 'http://127.0.0.1').pathname);
      if (pathname.startsWith(endpoint + '/')) {
        if (req.method !== 'POST') { res.writeHead(405).end(); return; }
        const action = pathname.slice(endpoint.length + 1);
        if (action === 'shot') {
          await body(req, 0);
          const png = await screenshot();
          res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' }).end(png); return;
        }
        if (action === 'still') {
          const still = stills[Number(new URL(req.url, 'http://127.0.0.1').searchParams.get('k'))];
          if (!still) { res.writeHead(404).end(); return; }
          fs.writeFileSync(still.path, await body(req));
          res.writeHead(200).end('ok'); return;
        }
        if (action === 'warn') {
          const text = (await body(req, 65536)).toString();
          warnings.push(text); say(`Warning: ${text}`);
          res.writeHead(200).end('ok'); return;
        }
        if (action === 'sample-put') {
          samples[Number(new URL(req.url, 'http://127.0.0.1').searchParams.get('k'))] = await body(req);
          res.writeHead(200).end('ok'); return;
        }
        if (action === 'sample-get') {
          await body(req, 0);
          const sample = samples[Number(new URL(req.url, 'http://127.0.0.1').searchParams.get('k'))];
          if (!sample) { res.writeHead(404).end(); return; }
          res.writeHead(200, { 'Content-Type': 'application/octet-stream' }).end(sample); return;
        }
        if (action === 'raw') {
          if (!encoder || finalized) throw Error('Raw frames are only accepted with --depth 10 or ProRes');
          // The page sends frames one after another; each is handed to ffmpeg whole.
          const chunks = []; let length = 0;
          for await (const chunk of req) { length += chunk.length; if (length > frameBytes) throw Error(`Raw frame exceeds ${frameBytes} bytes`); chunks.push(chunk); }
          if (length !== frameBytes) throw Error(`Raw frame has ${length} bytes, expected ${frameBytes}`);
          await encoder.queue(chunks);
          res.writeHead(200).end('ok'); return;
        }
        if (action === 'raw-end') {
          await body(req, 0);
          await encoder.end(); finalized = true;
          res.writeHead(200).end('ok'); return;
        }
        if (action === 'bytes') {
          if (finalized) throw Error('Output already finalized');
          const bytes = await body(req);
          if (fd === null) fd = fs.openSync(staging, 'wx');
          let offset = 0;
          while (offset < bytes.length) { const n = fs.writeSync(fd, bytes, offset, bytes.length - offset, position); offset += n; position += n; }
        } else if (action === 'finish') {
          const { mdatOffset, mdatSize } = JSON.parse((await body(req, 4096)).toString());
          if (fd === null || finalized || !Number.isSafeInteger(mdatOffset) || mdatOffset < 8 || mdatOffset > position - 16 || !Number.isSafeInteger(mdatSize) || mdatSize < 16 || mdatOffset + mdatSize > position) throw Error('Invalid MP4 finalization');
          const size = Buffer.alloc(8); size.writeBigUInt64BE(BigInt(mdatSize)); fs.writeSync(fd, size, 0, 8, mdatOffset + 8);
          fs.fsyncSync(fd); fs.closeSync(fd); fd = null; finalized = true;
        } else if (action === 'log') {
          say((await body(req, 65536)).toString());
        } else { res.writeHead(404).end(); return; }
        res.writeHead(200).end('ok'); return;
      }
      if (req.method !== 'GET') { res.writeHead(405).end(); return; }
      let filename;
      if (pathname.startsWith('/__webreel/page/')) {
        const name = pathname.slice('/__webreel/page/'.length);
        if (!PAGE_MODULES.includes(name)) { res.writeHead(404).end(); return; }
        filename = path.join(HERE, 'page', name);
      } else {
        filename = path.resolve(options.root, '.' + pathname);
        if (!within(options.root, filename) || !fs.existsSync(filename) || !within(options.root, fs.realpathSync(filename))) { res.writeHead(404).end(); return; }
        if (fs.statSync(filename).isDirectory()) filename = path.join(filename, 'index.html');
      }
      let content = fs.readFileSync(filename);
      if (filename.endsWith('.html') && pathname !== '/' + options.page) { /* other pages (iframes) are served unmodified */ }
      else if (filename.endsWith('.html')) {
        const tag = '<script type="module" src="/__webreel/page/export.mjs"></script>';
        const text = content.toString();
        content = Buffer.from(/<\/body>/i.test(text) ? text.replace(/<\/body>/i, tag + '</body>') : text + tag);
      }
      res.writeHead(200, { 'Content-Type': mime[path.extname(filename).toLowerCase()] ?? 'application/octet-stream', 'Cache-Control': 'no-store' }); res.end(content);
    } catch (error) {
      if (req.url?.startsWith(endpoint)) serverFailure = error;
      if (!res.headersSent) res.writeHead(500).end(String(error));
    }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  let chrome, logs = '';
  const stop = () => {
    chrome?.kill('SIGKILL'); encoder?.child.kill('SIGKILL');
    if (fd !== null) fs.closeSync(fd);
    if (staging) fs.rmSync(staging, { force: true });
    fs.rmSync(profile, { recursive: true, force: true });
  };
  onStop.add(stop);
  const overallStart = performance.now();
  try {
    chrome = spawn(options.chrome, [...CHROME_FLAGS, `--user-data-dir=${profile}`, ...options.chromeFlags], { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'] });
    chrome.stderr.setEncoding('utf8'); chrome.stderr.on('data', data => logs = (logs + data).slice(-8192));
    cdp = new CDP(chrome);
    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
    ({ sessionId: session } = await cdp.send('Target.attachToTarget', { targetId, flatten: true }));
    await cdp.send('Page.enable', {}, session);
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: "window.webreelHost = window.filmHost = { version: '0.1', name: 'webreel' };" }, session);
    const metrics = () => cdp.send('Emulation.setDeviceMetricsOverride', { width: stage.width, height: stage.height, deviceScaleFactor: options.scale, mobile: false }, session);
    await metrics();
    // --alpha: no white page backdrop, so screenshots (fallback and checks) keep transparency.
    if (options.alpha) await cdp.send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } }, session);
    const url = new URL(`http://127.0.0.1:${server.address().port}/${options.page.split('/').map(encodeURIComponent).join('/')}`);
    url.search = options.q; url.searchParams.set('render', '1');
    const waitFor = async (expression, seconds) => {
      const deadline = performance.now() + seconds * 1000;
      for (;;) {
        if (await cdp.evaluate(expression, session)) return true;
        if (performance.now() > deadline) return false;
        await sleep(50);
      }
    };
    const load = async () => {
      await cdp.send('Page.navigate', { url: url.href }, session);
      if (!await waitFor('document.readyState === "complete" && typeof window.__webreelPrepare === "function"', 60))
        throw new WebreelError('PAGE_LOAD', 'The page did not finish loading within 60 s', 'check that every script, font and image it loads exists under --root and that the page does not block on user input');
    };
    const hasFrames = 'typeof (window.webreel ?? window.film)?.frame === "function" || typeof window.renderAt === "function"';
    let clock = options.clock === 'virtual';
    if (clock) await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: CLOCK_SOURCE }, session);
    await load();
    if (!clock && !await waitFor(hasFrames, options.wait)) {
      if (options.clock === 'off') throw new WebreelError('NO_FRAME_SOURCE', `The page did not set window.webreel = { frame(t), … } within ${options.wait} s of loading`, 'drop --clock off, or raise --wait');
      // No frame(t): load again with the virtual clock installed before any page script.
      say('No window.webreel: reloading the page on a virtual clock');
      await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: CLOCK_SOURCE }, session);
      clock = true; await load();
    }
    // Page entry points; their errors carry a code and a hint (see export.mjs).
    const callPage = async (expression, timeout) => {
      const reply = await cdp.evaluate(`(async () => { try { return { value: await ${expression} }; } catch (e) {
        return { error: { code: e?.code ?? null, message: String(e?.message ?? e), hint: e?.hint ?? null } }; } })()`, session, timeout);
      if (reply.error) { if (serverFailure) throw serverFailure; throw new WebreelError(reply.error.code ?? 'ERROR', reply.error.message, reply.error.hint); }
      return reply.value;
    };
    const config = { ...options, endpoint, chrome: undefined, chromeFlags: undefined };
    let info = await callPage(`window.__webreelPrepare(${JSON.stringify(config)})`, 120000);
    if (info.width !== stage.width || info.height !== stage.height) {
      stage = { width: info.width, height: info.height }; await metrics();
      info = await callPage(`window.__webreelPrepare(${JSON.stringify(config)})`, 120000);
    }
    const software = info.renderer && /swiftshader|llvmpipe|software rasterizer/i.test(info.renderer);
    if (!render) {
      const times = checkTimes(options, info);
      if (outDir) for (const t of times) stills.push({ t, path: path.join(outDir, `${path.basename(options.page, path.extname(options.page))}-${t.toFixed(3)}s.png`) });
      if (info.clock) say(`Virtual clock${info.durationInferred ? `; length ${info.total.toFixed(3)} s inferred from its animations` : ''}`);
      const result = await callPage(`window.__webreelCheck(${JSON.stringify({ ...config, stills: !!outDir })}, ${JSON.stringify(times)})`, 60 * 60 * 1000);
      if (result.pendingChecks.length) { await load(); result.checks = await callPage(`window.__webreelReference(${JSON.stringify(config)}, ${JSON.stringify(result.pendingChecks)})`, 60 * 60 * 1000); }
      const failed = result.checks.filter(c => !c.pass), hints = [];
      if (result.durationError) hints.push(`${result.durationError}: pass --duration SECONDS to render`);
      if (result.fallbackReason) hints.push(`rendering would use screenshots (slower) because: ${result.fallbackReason}`);
      if (failed.length) hints.push(`${checkError(failed, options).message}; render with --capture screenshot`);
      if (software && !options.software) hints.push('WebGL runs in software here; rendering needs GPU access or --allow-software');
      const report = { ok: true, command: 'check', page: options.page, name: result.name, width: result.width, height: result.height, stage: result.stage,
        scale: options.scale, fpsNum: options.fpsNum, fpsDen: options.fpsDen, start: options.start, duration: result.duration, total: result.total,
        durationInferred: result.durationInferred, frameCount: result.frameCount, clock: result.clock, renderer: result.renderer,
        capture: result.capture, fallbackReason: result.fallbackReason,
        checks: result.checks.map(({ t, mean, worstTile, worstTileRect, pass }) => ({ t, mean, worstTile, worstTileRect, pass })), checksPass: !failed.length,
        stills: stills.map(s => ({ t: s.t, path: s.path })), warnings, hints };
      say(`${report.name}: ${report.width}×${report.height}, ${report.duration === null ? 'length unknown' : `${options.start}s + ${report.duration}s, ${report.frameCount} frames`}, capture ${report.capture}`);
      say(`checks (SSIM mean / worst tile): ${report.checks.length ? report.checks.map(c => `${c.t.toFixed(2)}s ${c.mean.toFixed(4)}/${c.worstTile.toFixed(4)}${c.pass ? '' : ' FAIL'}`).join(', ') : 'none (screenshots are the reference)'}`);
      for (const s of report.stills) say(`→ ${s.path}`);
      for (const hint of hints) say(`Hint: ${hint}`);
      return report;
    }
    if (options.readback === 'p010') {
      const unavailable = await callPage(`window.__webreelP010(${info.width * options.scale}, ${info.height * options.scale})`, 60000);
      if (unavailable) { options.readback = config.readback = 'rgba'; say(`P010 readback unavailable (${unavailable}); reading RGBA, ffmpeg converts`); }
    }
    if (options.hostEncode) startEncoder(info.width * options.scale, info.height * options.scale);
    const bitrate = options.hostEncode && !options.bitrate ? null : options.bitrate ?? Math.round(24e6 * ((info.width * info.height * options.scale ** 2) / (1920 * 1080)) ** 0.66 / 1e6) * 1e6;
    if (info.clock) say(`Virtual clock${info.durationInferred ? `; length ${info.total.toFixed(3)} s inferred from its animations` : ''}`);
    say(`${info.name}: ${options.start}s + ${info.duration}s, ${info.frameCount} frames, ${info.width * options.scale}×${info.height * options.scale}, ${options.codec === 'prores' ? `ProRes ${PRORES[options.prores]}${options.alpha ? ' with alpha' : ''}` : options.depth === 10 ? `HEVC Main10, ${bitrate ? bitrate / 1e6 + ' Mbps' : 'constant quality 80'}` : `${bitrate / 1e6} Mbps`}`);
    say(`WebGL: ${info.renderer ?? 'unavailable'}`);
    if (software && !options.software) throw new WebreelError('SOFTWARE_GL', 'WebGL fell back to software', 'run where Chrome can use the GPU (not in a sandbox), or pass --allow-software');
    const result = await callPage(`window.__webreelExport(${JSON.stringify({ ...config, bitrate })})`, 12 * 60 * 60 * 1000);
    if (serverFailure) throw serverFailure;
    if (!finalized) throw Error('MP4 output did not finalize');
    if (result.pendingChecks.length) {
      // A virtual clock only runs forward: replay a fresh load up to each sample and
      // compare with the frames kept during the export. The MP4 stays staged until then.
      const began = performance.now();
      await load();
      result.checks = await callPage(`window.__webreelReference(${JSON.stringify(config)}, ${JSON.stringify(result.pendingChecks)})`, 12 * 60 * 60 * 1000);
      result.checkSeconds += (performance.now() - began) / 1000;
    }
    delete result.pendingChecks;
    const failed = result.checks.filter(c => !c.pass);
    if (failed.length) throw checkError(failed, options);
    if (result.fallbackReason) warnings.push(`html-in-canvas not used, exported with screenshots: ${result.fallbackReason}`);
    if (!options.overwrite && fs.existsSync(options.out)) throw new WebreelError('OUTPUT_EXISTS', 'Output appeared during rendering; refusing to replace it', 'pass --overwrite, or choose another --out');
    fs.renameSync(staging, options.out);
    const report = { ...result, page: options.page, scene: options.scene, start: options.start, scale: options.scale, codec: options.codec,
      ...(options.codec === 'prores' ? { prores: PRORES[options.prores] } : {}), alpha: options.alpha,
      bitrate, fpsNum: options.fpsNum, fpsDen: options.fpsDen, totalSeconds: (performance.now() - overallStart) / 1000, output: options.out, warnings };
    fs.writeFileSync(options.out + '.json', JSON.stringify(report, null, 2) + '\n');
    const checks = report.checks?.length ? report.checks.map(c => `${c.t.toFixed(2)}s ${c.mean.toFixed(4)}/${c.worstTile.toFixed(4)}`).join(', ') : 'skipped';
    say(`${report.capture}${report.fallbackReason ? ` (fallback: ${report.fallbackReason})` : ''}: ${report.frames} frames in ${report.elapsed.toFixed(2)} s (${report.fps.toFixed(1)} fps), total ${report.totalSeconds.toFixed(2)} s`);
    say(`checks (SSIM mean / worst tile): ${checks}`);
    say(`→ ${options.out}`);
    return { ok: true, command: 'render', ...report, report: options.out + '.json' };
  } catch (error) {
    if (chrome?.exitCode !== null && logs) console.error(logs);
    throw error;
  } finally {
    if (fd !== null) fs.closeSync(fd);
    if (encoder && encoder.child.exitCode === null) { encoder.child.kill('SIGKILL'); await Promise.race([once(encoder.child, 'close'), sleep(2000)]); }
    if (chrome) {
      try { await cdp?.send('Browser.close', {}, undefined, 3000); } catch {}
      if (chrome.exitCode === null) { chrome.kill('SIGKILL'); await Promise.race([once(chrome, 'close'), sleep(2000)]); }
      // Chrome's crash handler and updater inherit its stderr and can outlive it;
      // close our ends so they do not keep this process alive.
      for (const stream of chrome.stdio) stream?.destroy();
    }
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    fs.rmSync(profile, { recursive: true, force: true, maxRetries: 3 });
    if (staging) fs.rmSync(staging, { force: true });
    onStop.delete(stop);
  }
}

const args = process.argv.slice(2), json = args.includes('--json');
if (json) say = (...parts) => console.error(...parts);
try {
  const options = args[0] === 'batch' ? parseBatch(args.slice(1)) : parse(args);
  if (!options) console.log(HELP);
  else {
    const result = options.command === 'batch' ? await runBatch(options) : await run(options);
    if (json) process.stdout.write(JSON.stringify(result) + '\n');
  }
} catch (caught) {
  const error = caught instanceof WebreelError ? caught : new WebreelError('ERROR', caught?.message ?? String(caught));
  if (json) process.stdout.write(JSON.stringify({ ok: false, error: { code: error.code, message: error.message, hint: error.hint } }) + '\n');
  else console.error(error.code === 'ERROR' ? (caught?.stack ?? caught) : `Error [${error.code}]: ${error.message}${error.hint ? `\nHint: ${error.hint}` : ''}`);
  process.exitCode = EXIT[error.code] ?? 1;
}
