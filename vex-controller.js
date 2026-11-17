
/* VEX_BUILD: 2026-11-17.9 */
/* VEX IQ 2nd Gen: universal browser adapter. No Robot Brain. */
(() => {
'use strict';
if (window.VEXMapper) return;

const VERSION = '2026-11-17.9';
const POLL = new Uint8Array([
  0xc9,0x36,0xb8,0x47,0x58,0x60,0x00,0x10,0x53
]);

const BUTTONS = {
  'E ↑':[13,8],'E ↓':[13,2],
  'F ↑':[13,4],'F ↓':[13,1],
  'L ↑':[13,32],'L ↓':[13,16],
  'R ↑':[13,128],'R ↓':[13,64],
  L3:[14,1],R3:[14,2]
};

const INPUTS = [
  'Left ↑','Left ↓','Left ←','Left →',
  'Right ↑','Right ↓','Right ←','Right →',
  ...Object.keys(BUTTONS)
];

const DEFAULT_ASSIGN = {
  w:'Left ↑',s:'Left ↓',a:'Left ←',d:'Left →',
  ArrowUp:'Left ↑',ArrowDown:'Left ↓',
  ArrowLeft:'Left ←',ArrowRight:'Left →',
  j:'E ↑',q:'E ↓',r:'F ↑',f:'F ↓',
  e:'L ↑',c:'L ↓',v:'R ↑',
  '1':'R ↓',p:'L3',k:'none',
  Space:'E ↑',
  Enter:'R3'
};

const STORAGE =
  'vex-auto-map:' + location.origin + location.pathname;

let assigned = {};
let actions = [];
let speed = 1;
let aimEnabled = true;

let port = null;
let reader = null;
let writer = null;
let readJob = null;
let pollJob = null;
let running = false;
let busy = false;

let buffer = [];
let packets = 0;
let polls = 0;
let lastData = 0;
let lastError = '';

let latest = {};
let raw = {};
let held = {};
let nativeKeys = new Set();
let mouseTargets = {};

let aimX = innerWidth / 2;
let aimY = innerHeight / 2;
let panelOpen = false;
let learnKey = null;

let host,shadow,pill,pillText,dot,panel;
let statusEl,rowsEl,hint,warning,warningText;
let connectBtn,disconnectBtn,slider,speedText;
let aimBtn,cursor,conflict = null;

const controls = new Map();

const saved = (() => {
  try {
    return JSON.parse(
      localStorage.getItem(STORAGE) || '{}'
    );
  } catch {
    return {};
  }
})();

if (Number.isFinite(saved.speed)) {
  speed = Math.min(3.5,Math.max(.5,saved.speed));
}

if (typeof saved.aimEnabled === 'boolean') {
  aimEnabled = saved.aimEnabled;
}

function save() {
  try {
    localStorage.setItem(
      STORAGE,
      JSON.stringify({assigned,speed,aimEnabled})
    );
  } catch {}
}

function el(tag,parent,cls,txt) {
  const e = document.createElement(tag);

  if (cls) e.className = cls;
  if (txt != null) e.textContent = txt;
  if (parent) parent.appendChild(e);

  return e;
}

function keyCode(k) {
  if (k === 'Space' || k === ' ') return 'Space';
  if (k === 'Shift') return 'ShiftLeft';
  if (k === 'Control') return 'ControlLeft';
  if (k === 'Enter') return 'Enter';

  if (/^Arrow(Up|Down|Left|Right)$/.test(k)) {
    return k;
  }

  if (/^[a-z]$/i.test(k)) {
    return 'Key' + k.toUpperCase();
  }

  if (/^[0-9]$/.test(k)) {
    return 'Digit' + k;
  }

  return k;
}

function canonical(k) {
  if (k === ' ') return 'Space';

  if (/^Key[A-Z]$/.test(k)) {
    return k[3].toLowerCase();
  }

  if (/^Digit[0-9]$/.test(k)) {
    return k[5];
  }

  if (/^Numpad[0-9]$/.test(k)) {
    return k;
  }

  return /^[A-Z]$/.test(k) ? k.toLowerCase() : k;
}

function display(k) {
  if (k === 'Space') return 'Space';
  if (k === 'mouse-left') return 'Left click';
  if (k === 'mouse-right') return 'Right click';
  return k;
}

function emitKey(k,down) {
  window.dispatchEvent(
    new KeyboardEvent(
      down ? 'keydown' : 'keyup',
      {
        bubbles:true,
        cancelable:true,
        key:k === 'Space' ? ' ' : k,
        code:keyCode(k),
        shiftKey:k === 'Shift',
        ctrlKey:k === 'Control'
      }
    )
  );
}

window.addEventListener('keydown',e => {
  if (e.isTrusted) nativeKeys.add(e.code);
},true);

window.addEventListener('keyup',e => {
  if (!e.isTrusted) return;

  nativeKeys.delete(e.code);

  for (const k of Object.keys(held)) {
    if (held[k] > 0 && keyCode(k) === e.code) {
      queueMicrotask(() => {
        if (held[k] > 0) emitKey(k,true);
      });
    }
  }
},true);

function targetAtAim() {
  const t = document.elementFromPoint(aimX,aimY);
  return !t || t === host ? document.body : t;
}

function mouseEvent(out,down) {
  const n = out === 'mouse-left' ? 0 : 2;

  const t = down
    ? targetAtAim()
    : (mouseTargets[n] || targetAtAim());

  if (down) mouseTargets[n] = t;

  const opts = {
    bubbles:true,
    cancelable:true,
    clientX:aimX,
    clientY:aimY,
    button:n,
    buttons:down ? (n === 0 ? 1 : 2) : 0
  };

  t.dispatchEvent(
    new MouseEvent(
      down ? 'mousedown' : 'mouseup',
      opts
    )
  );

  if (!down) {
    if (n === 0) {
      t.dispatchEvent(
        new MouseEvent('click',opts)
      );
    }

    delete mouseTargets[n];
  }
}

function emit(k,down) {
  const n = held[k] || 0;

  if (down) {
    held[k] = n + 1;
    if (n) return;
  } else {
    if (!n) return;

    held[k] = n - 1;
    if (n !== 1) return;
  }

  if (k === 'mouse-left' || k === 'mouse-right') {
    mouseEvent(k,down);
  } else if (down || !nativeKeys.has(keyCode(k))) {
    emitKey(k,down);
  }
}

function release() {
  for (const k of Object.keys(held)) {
    if (held[k] > 0) {
      held[k] = 1;
      emit(k,false);
    }
  }

  held = {};
  mouseTargets = {};
}

function applyInputs(next) {
  raw = next;

  if (learnKey) {
    for (const input of INPUTS) {
      if (next[input] && !latest[input]) {
        requestAssignment(learnKey,input);
        break;
      }
    }
  }

  latest = {...next};

  if (panelOpen) {
    release();
    return;
  }

  const nextCounts = {};

  for (const a of actions) {
    const input = assigned[a.key];

    if (
      input &&
      input !== 'none' &&
      next[input]
    ) {
      nextCounts[a.key] =
        (nextCounts[a.key] || 0) + 1;
    }
  }

  for (
    const k of new Set([
      ...Object.keys(nextCounts),
      ...Object.keys(held)
    ])
  ) {
    const prev = held[k] || 0;
    const now = nextCounts[k] || 0;

    if (!prev && now) emit(k,true);

    if (prev && !now) {
      held[k] = 1;
      emit(k,false);
    }

    if (now) held[k] = now;
  }
}

function axis(x) {
  const d = x - 127;
  return Math.abs(d) < 24 ? 0 : d;
}

function aim(rx,ry) {
  if (
    panelOpen ||
    !aimEnabled ||
    (!rx && !ry)
  ) return;

  aimX = Math.max(
    0,
    Math.min(innerWidth - 1,aimX + rx * speed)
  );

  aimY = Math.max(
    0,
    Math.min(innerHeight - 1,aimY - ry * speed)
  );

  cursor.style.left = aimX + 'px';
  cursor.style.top = aimY + 'px';
  cursor.hidden = false;

  targetAtAim().dispatchEvent(
    new MouseEvent('mousemove',{
      bubbles:true,
      cancelable:true,
      clientX:aimX,
      clientY:aimY
    })
  );
}

function processPacket(p) {
  packets++;
  lastData = Date.now();

  const rx = axis(p[5]);
  const ry = axis(p[6]);
  const lx = axis(p[7]);
  const ly = axis(p[8]);

  const next = {
    'Left ↑':ly > 0,
    'Left ↓':ly < 0,
    'Left ←':lx < 0,
    'Left →':lx > 0,
    'Right ↑':ry > 0,
    'Right ↓':ry < 0,
    'Right ←':rx < 0,
    'Right →':rx > 0
  };

  for (
    const [name,[b,mask]] of Object.entries(BUTTONS)
  ) {
    next[name] = !!(p[b] & mask);
  }

  applyInputs(next);
  aim(rx,ry);
}

function receive(chunk) {
  for (const b of chunk) buffer.push(b);

  if (buffer.length > 4096) {
    buffer = buffer.slice(-512);
  }

  while (buffer.length >= 4) {
    if (
      buffer[0] !== 170 ||
      buffer[1] !== 85 ||
      buffer[2] !== 88 ||
      buffer[3] !== 19
    ) {
      buffer.shift();
      continue;
    }

    if (buffer.length < 23) break;

    processPacket(buffer.splice(0,23));
  }
}

const sleep = ms =>
  new Promise(resolve => setTimeout(resolve,ms));

async function readLoop() {
  try {
    reader = port.readable.getReader();

    while (running) {
      const r = await reader.read();

      if (r.done) break;
      if (r.value) receive(r.value);
    }
  } catch (e) {
    if (running) fail('Read: ' + e.message);
  } finally {
    if (reader) {
      try {
        reader.releaseLock();
      } catch {}

      reader = null;
    }
  }
}

async function pollLoop() {
  try {
    while (running) {
      await writer.write(POLL);
      polls++;
      await sleep(100);
    }
  } catch (e) {
    if (running) fail('Write: ' + e.message);
  }
}

function status(msg,kind = '') {
  if (statusEl) {
    statusEl.textContent = msg;
    statusEl.dataset.kind = kind;
  }

  if (dot) dot.dataset.kind = kind;

  if (pillText) {
    pillText.textContent = running
      ? 'Controller Connected'
      : '+ Add Controller';
  }
}

function fail(msg) {
  lastError = msg;
  running = false;

  release();
  status(msg,'error');

  setTimeout(disconnect,0);
}

async function connect() {
  if (busy || running) return;

  if (!navigator.serial) {
    status(
      'Web Serial requires Chrome or Edge on HTTPS',
      'error'
    );
    return;
  }

  busy = true;
  connectBtn.disabled = true;

  try {
    port = await navigator.serial.requestPort();

    const i = port.getInfo();

    if (
      i.usbVendorId !== 10376 ||
      i.usbProductId !== 528
    ) {
      throw Error(
        'Choose VEX Robotics IQ Controller — Communications Port'
      );
    }

    await port.open({baudRate:115200});

    writer = port.writable.getWriter();

    buffer = [];
    lastData = 0;
    running = true;
    lastError = '';

    readJob = readLoop();
    pollJob = pollLoop();

    disconnectBtn.disabled = false;

    status('Connected','connected');
    showPanel(false);

  } catch (e) {
    lastError = e.message;

    status(
      'Connection failed: ' + e.message,
      'error'
    );

    if (port) {
      try {
        await port.close();
      } catch {}

      port = null;
    }
  } finally {
    busy = false;
    connectBtn.disabled = running;
  }
}

async function disconnect() {
  if (busy) return;

  busy = true;
  running = false;
  release();

  try {
    if (reader) await reader.cancel();
  } catch {}

  try {
    if (readJob) await readJob;
  } catch {}

  try {
    if (pollJob) await pollJob;
  } catch {}

  readJob = pollJob = null;

  try {
    if (writer) writer.releaseLock();
  } catch {}

  writer = null;

  try {
    if (port) await port.close();
  } catch {}

  port = null;
  busy = false;

  if (connectBtn) connectBtn.disabled = false;
  if (disconnectBtn) disconnectBtn.disabled = true;
  if (cursor) cursor.hidden = true;

  status(
    lastError
      ? 'Disconnected — ' + lastError
      : 'Not connected',
    lastError ? 'error' : ''
  );
}

function showPanel(v) {
  panelOpen = v;
  panel.hidden = !v;

  release();
  learnKey = null;
  conflict = null;
  warning.hidden = true;

  renderRows();
}

function renderRows() {
  for (const a of actions) {
    const row = controls.get(a.key);
    if (!row) continue;

    row.sel.value = assigned[a.key] || 'none';

    row.learn.textContent =
      learnKey === a.key ? 'Press VEX…' : 'Press VEX';
  }

  if (hint) {
    hint.textContent = learnKey
      ? 'Press the physical VEX button for ' +
        display(learnKey)
      : 'Game keys are fixed. Choose a VEX input for each key.';
  }
}

function finishAssignment(key,input) {
  release();

  assigned[key] = input;
  learnKey = null;
  conflict = null;

  warning.hidden = true;

  save();
  renderRows();
}

function requestAssignment(key,input) {
  if (input === 'none') {
    finishAssignment(key,input);
    return;
  }

  const duplicates = actions
    .filter(a =>
      a.key !== key &&
      assigned[a.key] === input
    )
    .map(a => a.key);

  if (!duplicates.length) {
    finishAssignment(key,input);
    return;
  }

  conflict = {key,input,duplicates};
  learnKey = null;
  warning.hidden = false;

  warningText.textContent =
    input + ' already controls ' +
    duplicates.map(display).join(', ') +
    '. Replace the old assignment or keep both actions?';

  renderRows();
}

function resolveConflict(choice) {
  if (!conflict) return;

  const {key,input,duplicates} = conflict;

  if (choice === 'cancel') {
    warning.hidden = true;
    conflict = null;
    renderRows();
    return;
  }

  if (choice === 'replace') {
    for (const k of duplicates) {
      assigned[k] = 'none';
    }
  }

  finishAssignment(key,input);
}

// Search for game keys in accessible JavaScript source.
// This cannot inspect all event handlers or infer every action.

async function findGameKeys() {
  const found = new Set(['Enter']);
  const ownScripts = [...document.scripts];
  const texts = [];

  for (const s of ownScripts) {
    if (s.src) {
      const url = new URL(s.src,location.href);

      if (
        url.origin !== location.origin ||
        /vex-controller|VexIQ-Adapter/i.test(url.pathname)
      ) continue;

      try {
        const r = await fetch(
          url.href,
          {cache:'no-store'}
        );

        if (r.ok) texts.push(await r.text());
      } catch {}

    } else {
      texts.push(s.textContent || '');
    }
  }

  for (const src of texts) {
    const patterns = [
      /\b(?:e|event|ev|evt)\s*\.\s*code\s*(?:===|==|!==|!=)\s*['"]([^'"]+)['"]/g,

      /['"]([^'"]+)['"]\s*(?:===|==|!==|!=)\s*\b(?:e|event|ev|evt)\s*\.\s*code\b/g,

      /\b(?:e|event|ev|evt)\s*\.\s*key\s*(?:===|==|!==|!=)\s*['"]([^'"]+)['"]/g,

      /['"]([^'"]+)['"]\s*(?:===|==|!==|!=)\s*\b(?:e|event|ev|evt)\s*\.\s*key\b/g,

      /\bkeys\s*\[\s*['"]([^'"]+)['"]\s*\]/g,

      /\bkeys\s*\.\s*([a-zA-Z])\b/g,

      ...(
        /\b(?:const|let|var)\s+k\s*=\s*(?:e|event|ev|evt)\.key\.toLowerCase\(\)/.test(src)
        ? [
          /\bk\s*(?:===|==|!==|!=)\s*['"]([^'"]+)['"]/g,
          /['"]([^'"]+)['"]\s*(?:===|==|!==|!=)\s*\bk\b/g
        ]
        : []
      ),

      /\b(?:e|event|ev|evt)\s*\.\s*(?:code|key)\s*\)\s*\{?[^\n]{0,100}['"](Space|Enter|ArrowUp|ArrowDown|ArrowLeft|ArrowRight|Key[A-Z])['"]/g
    ];

    for (const re of patterns) {
      for (const m of src.matchAll(re)) {
        const k = canonical(m[1]);

        if (isGameKey(k)) found.add(k);
      }
    }

    // Find collections such as:
    // ['Space','ArrowUp'].includes(e.code)

    const collectionPattern =
      /(\[[^\]\n]{1,220}\])\s*\.\s*includes\s*\(\s*(?:e|event|ev|evt)\.\s*(?:code|key)\s*\)/g;

    for (const m of src.matchAll(collectionPattern)) {
      for (
        const str of m[1].matchAll(
          /['"]([^'"]+)['"]/g
        )
      ) {
        const k = canonical(str[1]);

        if (isGameKey(k)) found.add(k);
      }
    }
  }

  const sorted = [...found].sort((a,b) => {
    const priority = [
      'w','a','s','d',
      'ArrowUp','ArrowLeft','ArrowDown','ArrowRight',
      'Space','Enter'
    ];

    const i = priority.indexOf(a);
    const j = priority.indexOf(b);

    if (i >= 0 || j >= 0) {
      return (i < 0 ? 100 : i) -
             (j < 0 ? 100 : j);
    }

    return a.localeCompare(b);
  });

  actions = sorted.map(key => ({key}));

  for (const a of actions) {
    assigned[a.key] =
      typeof saved.assigned?.[a.key] === 'string'
        ? saved.assigned[a.key]
        : (DEFAULT_ASSIGN[a.key] || 'none');

    if (!INPUTS.includes(assigned[a.key])) {
      assigned[a.key] = 'none';
    }
  }

  if (
    !saved.assigned ||
    !Object.hasOwn(saved.assigned,'Enter')
  ) {
    assigned.Enter = 'R3';
  }

  buildRows();
  renderRows();

  return sorted;
}

function isGameKey(k) {
  return (
    k === 'Space' ||
    k === 'Enter' ||
    k === 'Shift' ||
    k === 'Control' ||
    /^Arrow(Up|Down|Left|Right)$/.test(k) ||
    /^[a-z0-9]$/.test(k) ||
    /^F(?:[1-9]|1[0-2])$/.test(k)
  );
}

function buildRows() {
  rowsEl.textContent = '';
  controls.clear();

  for (const a of actions) {
    const row = el('div',rowsEl,'row');

    el(
      'span',
      row,
      'keylabel',
      display(a.key)
    );

    const sel = el('select',row,'select');

    for (const inp of ['none',...INPUTS]) {
      const o = el(
        'option',
        sel,
        '',
        inp === 'none'
          ? 'Not assigned'
          : inp
      );

      o.value = inp;
    }

    sel.value = assigned[a.key] || 'none';

    sel.onchange = () => {
      requestAssignment(a.key,sel.value);
    };

    const learn = el(
      'button',
      row,
      'learn',
      'Press VEX'
    );

    learn.onclick = () => {
      if (!running) {
        status(
          'Connect the controller first',
          'error'
        );
        return;
      }

      release();
      learnKey = a.key;
      warning.hidden = true;
      renderRows();
    };

    controls.set(a.key,{sel,learn});
  }
}

function buildUI() {
  host = el('div',document.body);
  host.id = 'vex-adapter';

  shadow = host.attachShadow({mode:'open'});

  el('style',shadow).textContent = `
:host{
  all:initial;
  position:fixed;
  right:16px;
  bottom:16px;
  z-index:2147483646;
  font-family:system-ui,Arial,sans-serif;
  color:#ecf4ff;
}
*,*:before,*:after{box-sizing:border-box}
[hidden]{display:none!important}
button,select,input{font:inherit}
button{cursor:pointer}
.pill{
  display:flex;
  align-items:center;
  gap:9px;
  background:#f5f9ff;
  color:#14253d;
  border:1px solid #d3deec;
  border-radius:99px;
  padding:11px 16px;
  font-size:13px;
  font-weight:700;
  box-shadow:0 9px 30px #0007;
}
.dot{
  height:9px;
  width:9px;
  border-radius:50%;
  background:#9daabd;
}
.dot[data-kind=connected]{background:#24ba80}
.dot[data-kind=error]{background:#ed7777}
.panel{
  position:absolute;
  bottom:58px;
  right:0;
  width:min(415px,calc(100vw - 24px));
  max-height:78vh;
  overflow-y:auto;
  border:1px solid #45617f;
  border-radius:17px;
  background:#14253d;
  box-shadow:0 18px 48px #000a;
  padding:18px;
}
.head,.buttons,.foot{
  display:flex;
  gap:8px;
  justify-content:space-between;
  align-items:center;
}
.title{font-size:19px;font-weight:750}
.small,.help{
  font-size:11px;
  color:#b0c6e2;
  line-height:1.5;
}
.close{
  border:0;
  background:none;
  color:#cbd8eb;
  font-size:23px;
}
.status{
  background:#203954;
  border-radius:9px;
  padding:10px;
  margin:14px 0;
  font-size:12px;
}
.status[data-kind=error]{color:#ffa7a7}
.status[data-kind=connected]{color:#81edbd}
.primary,.secondary,.learn,.mini{
  border:0;
  border-radius:8px;
  padding:9px 10px;
  font-size:12px;
}
.primary{
  flex:1;
  background:#8ab3ff;
  color:#112439;
  font-weight:700;
}
.secondary,.learn,.mini{
  background:#344d6a;
  color:#e9f4ff;
}
.learn{font-size:10px}
.row{
  display:grid;
  grid-template-columns:90px 1fr 83px;
  align-items:center;
  gap:7px;
  padding:7px 0;
  border-bottom:1px solid #2e4158;
}
.keylabel{
  font-size:12px;
  font-weight:700;
  background:#20344e;
  padding:8px;
  border-radius:6px;
  text-align:center;
}
.select{
  width:100%;
  min-width:0;
  color:#e9f4ff;
  background:#253c59;
  border:1px solid #5a7798;
  border-radius:7px;
  padding:8px;
  font-size:12px;
}
.section{
  border-top:1px solid #3d526e;
  margin-top:15px;
  padding-top:13px;
  font-size:13px;
  font-weight:700;
}
.help{margin:10px 0}
.warning{
  border:1px solid #f5bc6b;
  background:#483827;
  border-radius:10px;
  padding:12px;
  margin:12px 0;
  font-size:12px;
  line-height:1.5;
}
.warning-actions{
  display:flex;
  flex-wrap:wrap;
  gap:6px;
  margin-top:10px;
}
.mini{background:#766144}
.slider{
  width:100%;
  accent-color:#8ebaff;
  margin:9px 0;
}
.foot{
  margin-top:12px;
  flex-wrap:wrap;
}
button:disabled{
  opacity:.42;
  cursor:default;
}
`;

  pill = el('button',shadow,'pill');
  dot = el('span',pill,'dot');
  el('span',pill,'','🎮');

  pillText = el(
    'span',
    pill,
    '',
    '+ Add Controller'
  );

  pill.onclick = () => showPanel(!panelOpen);

  panel = el('section',shadow,'panel');
  panel.hidden = true;

  const head = el('div',panel,'head');
  const lhs = el('div',head);

  el(
    'div',lhs,'title',
    'Controller settings'
  );

  el(
    'div',lhs,'small',
    'VEX IQ 2nd Gen · ' + VERSION
  );

  const close = el(
    'button',head,'close','×'
  );

  close.onclick = () => showPanel(false);

  statusEl = el(
    'div',panel,'status',
    'Not connected'
  );

  const bar = el('div',panel,'buttons');

  connectBtn = el(
    'button',bar,'primary',
    'Connect VEX IQ'
  );

  connectBtn.onclick = connect;

  disconnectBtn = el(
    'button',bar,'secondary',
    'Disconnect'
  );

  disconnectBtn.disabled = true;
  disconnectBtn.onclick = disconnect;

  el(
    'div',
    panel,
    'help',
    'Select VEX Robotics IQ Controller — ' +
    'Communications Port. ' +
    'Game keyboard keys stay unchanged.'
  );

  el(
    'div',
    panel,
    'section',
    'Detected game keys → VEX inputs'
  );

  hint = el(
    'div',
    panel,
    'help',
    'Scanning game controls…'
  );

  rowsEl = el('div',panel);

  warning = el(
    'div',
    panel,
    'warning'
  );

  warning.hidden = true;

  warningText = el('div',warning);

  const wButtons = el(
    'div',warning,'warning-actions'
  );

  const replace = el(
    'button',
    wButtons,
    'mini',
    'Replace old'
  );

  replace.onclick = () =>
    resolveConflict('replace');

  const both = el(
    'button',
    wButtons,
    'mini',
    'Keep both'
  );

  both.onclick = () =>
    resolveConflict('both');

  const cancel = el(
    'button',
    wButtons,
    'mini',
    'Cancel'
  );

  cancel.onclick = () =>
    resolveConflict('cancel');

  el(
    'div',
    panel,
    'section',
    'Right joystick mouse sensitivity'
  );

  const speedLine = el(
    'div',panel,'buttons'
  );

  el(
    'span',
    speedLine,
    'small',
    'Mouse speed'
  );

  speedText = el(
    'strong',
    speedLine,
    '',
    speed.toFixed(2) + '×'
  );

  slider = el('input',panel,'slider');
  slider.type = 'range';
  slider.min = '.50';
  slider.max = '3.50';
  slider.step = '.10';
  slider.value = String(speed);

  slider.oninput = () => {
    speed = +slider.value;

    speedText.textContent =
      speed.toFixed(2) + '×';

    save();
  };

  aimBtn = el(
    'button',
    panel,
    'secondary',
    'Mouse aiming: ' +
      (aimEnabled ? 'ON' : 'OFF')
  );

  aimBtn.onclick = () => {
    aimEnabled = !aimEnabled;

    aimBtn.textContent =
      'Mouse aiming: ' +
      (aimEnabled ? 'ON' : 'OFF');

    if (!aimEnabled) cursor.hidden = true;

    save();
  };

  el(
    'div',
    panel,
    'help',
    'Auto-detection is best effort. ' +
    'Unrecognized game controls may not appear. ' +
    'R3 defaults to Enter.'
  );

  const foot = el('div',panel,'foot');

  const reset = el(
    'button',
    foot,
    'secondary',
    'Reset defaults'
  );

  reset.onclick = () => {
    release();

    for (const a of actions) {
      assigned[a.key] =
        DEFAULT_ASSIGN[a.key] || 'none';
    }

    assigned.Enter = 'R3';

    save();
    renderRows();
  };

  const copy = el(
    'button',
    foot,
    'secondary',
    'Copy diagnostic'
  );

  copy.onclick = async () => {
    const t = [
      'VEX IQ Game Adapter',
      'Build Version: ' + VERSION,
      'Status: ' +
        (running ? 'Connected' : 'Disconnected'),
      'Packets: ' + packets,
      'Polls: ' + polls,
      'Last packet age: ' +
        (lastData
          ? Date.now() - lastData + 'ms'
          : 'none'),
      'Detected keys: ' +
        actions.map(a => a.key).join(', '),
      'Mappings: ' + JSON.stringify(assigned),
      'Mouse speed: ' + speed,
      'Error: ' + lastError
    ].join('\n');

    try {
      await navigator.clipboard.writeText(t);
      copy.textContent = 'Copied';
    } catch {
      copy.textContent = 'Copy failed';
    }

    setTimeout(() => {
      copy.textContent = 'Copy diagnostic';
    },1200);
  };

  cursor = el('div',document.body);
  cursor.hidden = true;

  cursor.style.cssText =
    'position:fixed;' +
    'width:16px;' +
    'height:16px;' +
    'border:2px solid #7affc9;' +
    'border-radius:50%;' +
    'transform:translate(-50%,-50%);' +
    'pointer-events:none;' +
    'z-index:2147483645;' +
    'box-shadow:0 0 0 2px #102034';

  status('Not connected');

  findGameKeys().catch(e => {
    hint.textContent =
      'Could not scan the game: ' + e.message;

    actions = [{key:'Enter'}];
    assigned.Enter = 'R3';

    buildRows();
  });

  setInterval(() => {
    if (
      running &&
      lastData &&
      Date.now() - lastData > 1800
    ) {
      release();

      status(
        'No recent controller data',
        'error'
      );
    } else if (running) {
      status('Connected','connected');
    }
  },400);
}

window.addEventListener('blur',() => {
  release();
  nativeKeys.clear();
});

window.addEventListener('beforeunload',() => {
  running = false;
  release();
});

window.VEXMapper = {
  version:VERSION,
  connect,
  disconnect
};

if (document.readyState === 'loading') {
  document.addEventListener(
    'DOMContentLoaded',
    buildUI,
    {once:true}
  );
} else {
  buildUI();
}
})();
