'use strict';

const VERSION = require('../package.json').version;

// ' + 'mb v' + VERSION + ' — full-screen terminal interface.
// Uses the alternate screen buffer so it occupies the entire terminal,
// with a fixed header, scrollable page body and a pinned input line.

const Browser = require('../engine/browser');
const { render } = require('../renderer/text');

const ESC = '\x1b';
const ALT_ON = ESC + '[?1049h';
const ALT_OFF = ESC + '[?1049l';
const CURSOR_HIDE = ESC + '[?25l';
const CURSOR_SHOW = ESC + '[?25h';
const MOUSE_ON = ESC + '[?1000h' + ESC + '[?1006h';
const MOUSE_OFF = ESC + '[?1000l' + ESC + '[?1006l';
const CLEAR = ESC + '[2J';

const RESET = ESC + '[0m';
const DIM = ESC + '[90m';
const CYAN = ESC + '[96m';
const GREEN = ESC + '[92m';
const RED = ESC + '[91m';
const YELLOW = ESC + '[93m';
const BOLD = ESC + '[1m';
const UNDER = ESC + '[4m';

const browser = new Browser();
browser.newTab();

let input = '';
let scroll = 0;
let busy = false;
let cssOn = true;
let view = { lines: [], links: [] };
let hint = 'Enter a URL, :help for commands, :q to quit';
let pending = '';
let running = true;

function cols() { return process.stdout.columns || 80; }
function rows() { return process.stdout.rows || 24; }
function bodyTop() { return 5; }
function bodyHeight() { return Math.max(1, rows() - bodyTop() - 1); }

function colour(seg) {
  let prefix = '';
  if (seg.linkIndex) prefix += CYAN + UNDER;
  else if (seg.color) prefix += ESC + '[38;2;' + seg.color.join(';') + 'm';
  if (seg.bold) prefix += BOLD;
  if (seg.italic) prefix += ESC + '[3m';
  if (seg.underline && !seg.linkIndex) prefix += UNDER;
  return prefix;
}

function at(row, col) { return ESC + '[' + row + ';' + (col || 1) + 'H'; }

function fit(text, width) {
  if (text.length <= width) return text;
  return text.slice(0, Math.max(0, width - 1)) + '…';
}

function draw() {
  const width = cols();
  const height = rows();
  const tab = browser.currentTab;
  const page = tab.page;
  const doc = page && page.document;

  let out = at(1, 1);

  // Row 1 — identity and location
  const tabInfo = 'Tab ' + tab.id + ' | ' + tab.history.length + ' history | ' + (doc ? doc.url : 'about:blank');
  out += BOLD + CYAN + 'mb v' + VERSION + RESET + '  ' + DIM + fit(tabInfo, width - 16) + RESET + ESC + '[K\n';

  // Row 2 — page title
  const title = doc && doc.title ? doc.title : (busy ? 'Loading…' : 'No page loaded');
  out += BOLD + GREEN + fit(title, width) + RESET + ESC + '[K\n';

  // Row 3 — status
  let meta = '';
  if (doc) {
    meta = 'HTTP ' + (page.status || '?') + ' | scripts ' + (doc.scriptsRun || 0);
    if (doc.errors && doc.errors.length) meta += ' | errors ' + doc.errors.length;
    if (doc.styles && doc.styles.length) meta += ' | css ' + doc.styles.length;
    meta += cssOn ? ' | css-render on' : ' | css-render off';
  }
  out += DIM + fit(meta, width) + RESET + ESC + '[K\n';

  // Row 4 — rule
  out += DIM + '─'.repeat(width) + RESET + ESC + '[K\n';

  // Body
  const visible = bodyHeight();
  const maxScroll = Math.max(0, view.lines.length - visible);
  if (scroll > maxScroll) scroll = maxScroll;
  if (scroll < 0) scroll = 0;

  for (let i = 0; i < visible; i++) {
    const row = view.lines[scroll + i];
    out += at(bodyTop() + i, 1);

    if (!row) { out += ESC + '[K'; continue; }

    let line = '';
    for (const seg of row.segments) {
      line += colour(seg) + seg.text + RESET;
    }
    if (row.linkIndex) {
      const tag = ' ⟨' + row.linkIndex + '⟩';
      line += DIM + tag + RESET;
    }
    out += line + ESC + '[K';
  }

  // Input line
  const prompt = focusedField === null
    ? 'MAXBROWSER > '
    : 'FIELD ' + (focusedField + 1) + ' > ';
  out += at(height - 1, 1) + ESC + '[K';
  out += (busy ? YELLOW : CYAN) + prompt + RESET + (focusedField === null ? input : fieldValue);

  // Hint line
  out += at(height, 1) + DIM + ESC + '[K' + fit(hint, width) + RESET;

  // Cursor
  const cursorCol = Math.min(width, prompt.length + input.length + 1);
  out += at(height - 1, cursorCol) + CURSOR_SHOW;

  process.stdout.write(out);
}

function rebuild() {
  const tab = browser.currentTab;
  const doc = tab.page && tab.page.document;

  if (!doc) {
    view = { lines: [], links: [] };
    return;
  }

  if (!cssOn) {
    const lines = String(doc.text || '').split('\n').map(text => ({
      segments: [{ text, linkIndex: null }],
      linkIndex: null
    }));
    view = { lines, links: doc.links || [] };
    return;
  }

  try {
    view = render(doc.html || '', doc.styles || [], doc.url, Math.max(20, cols() - 1));
    if (!view.lines.length && doc.text) {
      view = {
        lines: String(doc.text).split('\n').map(text => ({ segments: [{ text }], linkIndex: null })),
        links: doc.links || []
      };
    }
  } catch (error) {
    hint = 'CSS render failed: ' + error.message + ' — showing plain text';
    view = {
      lines: String(doc.text || '').split('\n').map(text => ({ segments: [{ text }], linkIndex: null })),
      links: doc.links || []
    };
  }
}

async function loadUrl(raw) {
  let url = String(raw).trim();
  if (!url) return;

  if (!/^[a-z]+:\/\//i.test(url)) url = 'https://' + url;

  busy = true;
  hint = 'Loading ' + url + ' …';
  draw();

  try {
    await browser.load(url);
    scroll = 0;
    rebuild();
    const doc = browser.currentTab.page.document;
    hint = 'Loaded ' + (doc.title || url) + ' — ' + view.lines.length + ' lines, ' + (view.links || []).length + ' links';
  } catch (error) {
    hint = RED + 'Load failed: ' + error.message + RESET;
  }

  busy = false;
  draw();
}

function clickLink(index) {
  const list = view.links || [];
  const entry = list[index - 1];

  if (!entry) {
    hint = RED + 'No link ' + index + '. ' + list.length + ' available — try :links' + RESET;
    draw();
    return;
  }

  loadUrl(entry.url);
}

function handleCommand(raw) {
  const text = raw.trim();

  if (/^:\d+$/.test(text)) { clickLink(Number(text.slice(1))); return; }

  const space = text.indexOf(' ');
  const name = (space === -1 ? text : text.slice(0, space)).toLowerCase();
  const rest = space === -1 ? '' : text.slice(space + 1).trim();

  switch (name) {
    case ':q':
    case ':quit':
      quit();
      return;

    case ':help':
      hint = ':open :new :tabs :switch :back :forward :reload :history :links :click N :type SEL TEXT :js :dom :css :errors :q';
      draw();
      return;

    case ':open':
      if (rest) loadUrl(rest);
      return;

    case ':new':
      browser.newTab(browser.currentTab.id);
      scroll = 0;
      rebuild();
      hint = 'New tab';
      draw();
      return;

    case ':tabs':
      hint = browser.getTabs().map(t => '#' + t.id + (t.id === browser.currentTab.id ? '*' : '') + ' ' + (t.title || 'blank')).join('  |  ');
      draw();
      return;

    case ':switch':
      browser.switchTab(Number(rest));
      scroll = 0;
      rebuild();
      draw();
      return;

    case ':back':
      browser.back();
      scroll = 0;
      rebuild();
      draw();
      return;

    case ':forward':
      browser.forward();
      scroll = 0;
      rebuild();
      draw();
      return;

    case ':reload':
      if (browser.currentTab.page) loadUrl(browser.currentTab.page.url);
      return;

    case ':history':
      hint = browser.getHistory().map((h, i) => (i + 1) + '. ' + h).join('  ');
      draw();
      return;

    case ':links': {
      const list = view.links || [];
      hint = list.length
        ? list.slice(0, 8).map(l => l.index + '=' + l.url.slice(0, 40)).join('  ')
        : 'No links on this page';
      draw();
      return;
    }

    case ':click':
      clickLink(Number(rest));
      return;

    case ':f':
    case ':field': {
      const which = Number(rest.trim());
      if (!Number.isInteger(which) || which < 1) {
        const list = fieldBridge('__mb_fields()') || [];
        hint = list.length
          ? CYAN + 'Fields: ' + list.map((f) => 'f' + (f.index + 1) + '=' + (f.placeholder || f.name || f.type)).join(', ') + RESET
          : YELLOW + 'No fillable fields on this page' + RESET;
        draw();
        return;
      }
      focusField(which - 1);
      draw();
      return;
    }

    case ':type': {
      const at2 = rest.indexOf(' ');
      if (at2 === -1) { hint = 'Usage: :type <selector> <text>'; draw(); return; }
      const selector = rest.slice(0, at2);
      const value = rest.slice(at2 + 1);
      const result = browser.runJS(
        'var el=document.querySelector(' + JSON.stringify(selector) + ');' +
        'if(!el){"not-found"}else{el.value=' + JSON.stringify(value) + ';el.setAttribute("value",' + JSON.stringify(value) + ');"ok"}'
      );
      hint = result && result.ok ? 'Typed into ' + selector : 'Type failed: ' + (result && result.error);
      draw();
      return;
    }

    case ':js': {
      const result = browser.runJS(rest);
      hint = result && result.ok ? String(result.value).slice(0, 200) : 'JS error: ' + (result && result.error);
      rebuild();
      draw();
      return;
    }

    case ':dom':
      hint = (browser.currentTab.page && browser.currentTab.page.document.html || '').slice(0, 200);
      draw();
      return;

    case ':css':
      cssOn = !cssOn;
      rebuild();
      hint = cssOn ? 'CSS text rendering on' : 'CSS text rendering off (plain text)';
      draw();
      return;

    case ':errors': {
      const doc = browser.currentTab.page && browser.currentTab.page.document;
      const errs = (doc && doc.errors) || [];
      hint = errs.length ? errs.slice(0, 3).join('  ||  ').slice(0, 220) : 'No page script errors';
      draw();
      return;
    }

    default:
      hint = RED + 'Unknown command: ' + name + RESET;
      draw();
  }
}

function submit() {
  const text = input;
  input = '';
  if (!text.trim()) { draw(); return; }
  if (text.startsWith(':')) handleCommand(text);
  else loadUrl(text);
}

const SEQUENCES = [ESC + '[A', ESC + '[B', ESC + '[C', ESC + '[D', ESC + '[5~', ESC + '[6~', ESC + '[H', ESC + '[F'];

// Which form field has focus, as the 0-based index the shim enumerates.
let focusedField = null;
let fieldValue = '';
let fieldType = '';

function fieldBridge(code) {
  const result = browser.runJS(code);
  if (!result || !result.ok) return null;
  try {
    return JSON.parse(result.value);
  } catch {
    return null;
  }
}

function focusField(index) {
  const out = fieldBridge('__mb_focus_field(' + Number(index) + ')');
  if (!out || !out.ok) { hint = RED + 'No field ' + (Number(index) + 1) + ' on this page' + RESET; return; }
  focusedField = Number(index);
  fieldValue = out.field.value || '';
  fieldType = out.field.type || '';
  const extra = (fieldType === 'checkbox' || fieldType === 'radio') ? 'Space toggles'
    : fieldType === 'select' ? 'Left/Right choose'
    : 'Type to fill';
  hint = CYAN + 'Field ' + (focusedField + 1) + ' (' + (fieldType || 'text') + '). ' + extra + ', Enter submits, Esc releases.' + RESET;
}

function fieldEdit(action, text) {
  if (focusedField === null) return;
  const payload = JSON.stringify(String(text));
  const call = action === 'append'
    ? '__mb_field_append(' + focusedField + ', ' + payload + ')'
    : '__mb_field_backspace(' + focusedField + ')';
  const out = fieldBridge(call);
  if (out && out.ok) fieldValue = out.value;
}

function fieldToggle() {
  if (focusedField === null) return;
  const out = fieldBridge('__mb_field_toggle(' + focusedField + ')');
  if (out && out.ok) fieldValue = out.checked ? 'checked' : 'unchecked';
}

function fieldCycle(direction) {
  if (focusedField === null) return;
  const out = fieldBridge('__mb_field_cycle(' + focusedField + ', ' + Number(direction) + ')');
  if (out && out.ok) {
    fieldValue = out.value;
    hint = CYAN + 'Option ' + (out.index + 1) + '/' + out.total + ': ' + out.value + RESET;
  }
}

function submitField() {
  if (focusedField === null) return;
  const out = fieldBridge('__mb_field_submit(' + focusedField + ')');
  if (out && out.ok) {
    hint = GREEN + 'Submitted (' + out.via + ')' + RESET;
    focusedField = null;
    fieldValue = '';
  } else {
    hint = YELLOW + 'Nothing to submit: ' + ((out && out.reason) || 'no form') + RESET;
  }
}

function onKey(key) {
  if (key === '\u0003') { quit(); return; }

  // A focused field captures keys before the global scroll bindings.
  if (focusedField !== null) {
    if (key === '\u001b') { focusedField = null; fieldValue = ''; fieldType = ''; hint = ''; draw(); return; }
    if (key === '\r' || key === '\n') { submitField(); draw(); return; }

    if (fieldType === 'checkbox' || fieldType === 'radio') {
      if (key === ' ') { fieldToggle(); draw(); return; }
    }
    if (fieldType === 'select') {
      if (key === ESC + '[C') { fieldCycle(1); draw(); return; }
      if (key === ESC + '[D') { fieldCycle(-1); draw(); return; }
    }
    if (key === '\u007f' || key === '\b') { fieldEdit('backspace', ''); draw(); return; }
    if (key.length === 1 && key >= ' ') { fieldEdit('append', key); draw(); return; }
    return;
  }

  if (key === ESC + '[A') { scroll--; draw(); return; }
  if (key === ESC + '[B') { scroll++; draw(); return; }
  if (key === ESC + '[5~') { scroll -= bodyHeight(); draw(); return; }
  if (key === ESC + '[6~') { scroll += bodyHeight(); draw(); return; }
  if (key === ESC + '[H') { scroll = 0; draw(); return; }
  if (key === ESC + '[F') { scroll = 1e9; draw(); return; }

  if (key.startsWith(ESC + '[<')) {
    const m = key.match(/^\x1b\[<(\d+);(\d+);(\d+)([Mm])$/);
    if (m && m[4] === 'M') {
      const button = Number(m[1]);
      const col = Number(m[2]);
      const row = Number(m[3]);
      if (button === 64) { scroll--; draw(); return; }
      if (button === 65) { scroll++; draw(); return; }
      if (button === 0 && row >= bodyTop() && row < bodyTop() + bodyHeight()) {
        const line = view.lines[scroll + (row - bodyTop())];
        if (line && line.linkIndex) { clickLink(line.linkIndex); return; }
        if (line) {
          const text = (line.segments || []).map((seg) => seg.text).join('');
          const field = /⟨f(\d+)⟩/.exec(text);
          if (field) { focusField(Number(field[1]) - 1); draw(); return; }
        }
      }
    }
    return;
  }

  if (key === '\r' || key === '\n') { submit(); return; }

  if (key === '\u007f' || key === '\b') {
    if (input.length) { input = input.slice(0, -1); draw(); }
    return;
  }

  if (key.length === 1 && key >= ' ') { input += key; draw(); }
}

function feed(chunk) {
  let buffer = pending + chunk;

  while (buffer.length) {
    if (buffer[0] !== ESC) {
      onKey(buffer[0]);
      buffer = buffer.slice(1);
      continue;
    }

    // Escape sequence: wait for more bytes if it may be incomplete.
    if (buffer.length === 1) { pending = buffer; return; }

    if (buffer[1] === '[') {
      const mouse = buffer.match(/^\x1b\[<[\d;]+[Mm]/);
      if (mouse) { onKey(mouse[0]); buffer = buffer.slice(mouse[0].length); continue; }

      const known = SEQUENCES.find(s => buffer.startsWith(s));
      if (known) { onKey(known); buffer = buffer.slice(known.length); continue; }

      const generic = buffer.match(/^\x1b\[[\d;]*[A-Za-z~]/);
      if (generic) { buffer = buffer.slice(generic[0].length); continue; }

      if (buffer.length < 4) { pending = buffer; return; }
      buffer = buffer.slice(1);
      continue;
    }

    onKey(ESC);
    buffer = buffer.slice(1);
  }

  pending = '';
}

function quit() {
  if (!running) return;
  running = false;
  process.stdout.write(MOUSE_OFF + CURSOR_SHOW + ALT_OFF + RESET);
  if (process.stdin.isTTY && process.stdin.setRawMode) process.stdin.setRawMode(false);
  process.exit(0);
}

function start() {
  process.stdout.write(ALT_ON + CLEAR + CURSOR_HIDE + MOUSE_ON);

  if (process.stdin.isTTY && process.stdin.setRawMode) process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', feed);

  process.stdout.on('resize', () => { rebuild(); draw(); });

  const initial = process.argv.slice(2).find(a => !a.startsWith('-'));
  draw();

  if (initial) loadUrl(initial);
  else { rebuild(); draw(); }
}

start();
