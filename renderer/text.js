'use strict';

// MAXBROWSER — basic CSS-aware text renderer.
// Implements a deliberately small CSS subset for terminal output:
//   display, visibility, color, font-weight, font-style, text-decoration
// Selectors: tag, .class, #id, *, and simple descendant chains.
// Anything unsupported is ignored rather than guessed at.

const { parseHTML } = require('../parser/html');

const NAMED = {
  black: '#000000', white: '#ffffff', red: '#ff0000', green: '#008000',
  blue: '#0000ff', gray: '#808080', grey: '#808080', silver: '#c0c0c0',
  orange: '#ffa500', purple: '#800080', yellow: '#ffff00', cyan: '#00ffff',
  magenta: '#ff00ff', maroon: '#800000', navy: '#000080', teal: '#008080',
  lime: '#00ff00', olive: '#808000', aqua: '#00ffff', fuchsia: '#ff00ff',
  pink: '#ffc0cb', brown: '#a52a2a', gold: '#ffd700', crimson: '#dc143c'
};

const BLOCK = new Set([
  'address', 'article', 'aside', 'blockquote', 'div', 'dl', 'dd', 'dt',
  'fieldset', 'figcaption', 'figure', 'footer', 'form', 'h1', 'h2', 'h3',
  'h4', 'h5', 'h6', 'header', 'hr', 'li', 'main', 'nav', 'ol', 'p', 'pre',
  'section', 'table', 'tr', 'ul', 'br'
]);

const SKIP = new Set(['script', 'style', 'noscript', 'template', 'svg', 'head', 'title']);

// Fields are rendered inline with a marker the terminal can make tappable,
// e.g. [Email] ⟨f1⟩. Order must match the DOM order the shim enumerates.
const FIELD_TAGS = new Set(['input', 'textarea', 'select']);
const NON_TEXT_INPUT = new Set(['hidden', 'submit', 'button', 'reset', 'image', 'file']);

// Must mirror the shim exactly or the ⟨fN⟩ numbers stop matching the DOM.
function fieldHidden(attrs) {
  if (attrs.hidden !== undefined) return true;
  const style = String(attrs.style || '').toLowerCase().replace(/\s+/g, '');
  return style.includes('display:none') || style.includes('visibility:hidden');
}

function fieldLabel(attrs, tag) {
  if (attrs['aria-label']) return String(attrs['aria-label']);
  if (attrs.placeholder) return String(attrs.placeholder);
  if (attrs.name) return String(attrs.name);
  if (attrs.contenteditable !== undefined) return 'editable text';
  return tag === 'select' ? 'select' : 'text';
}

function stripAtRules(css) {
  let out = '';
  let i = 0;
  while (i < css.length) {
    const at = css.indexOf('@', i);
    if (at === -1) { out += css.slice(i); break; }
    out += css.slice(i, at);
    const open = css.indexOf('{', at);
    if (open === -1) break;
    let depth = 0;
    let j = open;
    for (; j < css.length; j++) {
      if (css[j] === '{') depth++;
      else if (css[j] === '}') { depth--; if (depth === 0) { j++; break; } }
    }
    i = j;
  }
  return out;
}

function parseRules(css) {
  const rules = [];
  const clean = stripAtRules(String(css || '').replace(/\/\*[\s\S]*?\*\//g, ''));
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m;

  while ((m = re.exec(clean))) {
    const decls = {};
    for (const part of m[2].split(';')) {
      const at = part.indexOf(':');
      if (at === -1) continue;
      const key = part.slice(0, at).trim().toLowerCase();
      const value = part.slice(at + 1).replace(/!important/i, '').trim();
      if (key && value) decls[key] = value;
    }
    if (!Object.keys(decls).length) continue;

    for (const selector of m[1].split(',').map(s => s.trim()).filter(Boolean)) {
      if (/[:>+~]/.test(selector)) continue; // unsupported combinators/pseudos
      rules.push({ parts: selector.toLowerCase().split(/\s+/), decls });
    }
  }

  return rules;
}

function classList(el) {
  return String((el.attrs && el.attrs.class) || '').toLowerCase().split(/\s+/).filter(Boolean);
}

function matchesCompound(el, part) {
  if (!el || el.type !== 'element') return false;
  if (part === '*') return true;

  const tagMatch = part.match(/^[a-z][a-z0-9-]*/);
  if (tagMatch && tagMatch[0] !== el.tag) return false;

  const ids = part.match(/#[a-z0-9_-]+/g) || [];
  for (const id of ids) {
    if ((el.attrs.id || '').toLowerCase() !== id.slice(1)) return false;
  }

  const classes = classList(el);
  const wanted = part.match(/\.[a-z0-9_-]+/g) || [];
  for (const cls of wanted) {
    if (!classes.includes(cls.slice(1))) return false;
  }

  return true;
}

function matchesSelector(el, parts) {
  if (!matchesCompound(el, parts[parts.length - 1])) return false;

  let node = el.parent;
  for (let i = parts.length - 2; i >= 0; i--) {
    let found = false;
    while (node && node.type === 'element') {
      if (matchesCompound(node, parts[i])) { found = true; node = node.parent; break; }
      node = node.parent;
    }
    if (!found) return false;
  }

  return true;
}

function parseInline(style) {
  const decls = {};
  for (const part of String(style || '').split(';')) {
    const at = part.indexOf(':');
    if (at === -1) continue;
    const key = part.slice(0, at).trim().toLowerCase();
    const value = part.slice(at + 1).replace(/!important/i, '').trim();
    if (key && value) decls[key] = value;
  }
  return decls;
}

function toRgb(value) {
  if (!value) return null;
  let v = String(value).trim().toLowerCase();
  if (NAMED[v]) v = NAMED[v];
  if (v === 'inherit' || v === 'initial' || v === 'unset' || v === 'currentcolor') return null;

  let m = v.match(/^#([0-9a-f]{3})$/);
  if (m) {
    const [r, g, b] = m[1].split('').map(c => parseInt(c + c, 16));
    return [r, g, b];
  }

  m = v.match(/^#([0-9a-f]{6})$/);
  if (m) {
    return [0, 2, 4].map(i => parseInt(m[1].slice(i, i + 2), 16));
  }

  m = v.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
  if (m) return [Number(m[1]), Number(m[2]), Number(m[3])];

  return null;
}

function applyDecls(style, decls) {
  if (!decls) return;

  if (decls.display !== undefined) {
    style.display = decls.display === 'none' ? 'none' : 'shown';
  }
  if (decls.visibility !== undefined) {
    style.visibility = decls.visibility === 'hidden' ? 'hidden' : 'visible';
  }
  if (decls.color !== undefined) {
    const rgb = toRgb(decls.color);
    if (rgb) style.color = rgb;
  }
  if (decls['font-weight'] !== undefined) {
    const w = decls['font-weight'];
    style.bold = w === 'bold' || w === 'bolder' || Number(w) >= 600;
  }
  if (decls['font-style'] !== undefined) {
    style.italic = decls['font-style'] === 'italic' || decls['font-style'] === 'oblique';
  }
  if (decls['text-decoration'] !== undefined) {
    style.underline = /underline/i.test(decls['text-decoration']);
  }
}

function render(html, styles, url, width) {
  const doc = parseHTML(String(html || ''), url || '');
  const rules = [];

  for (const block of [].concat(styles || [])) {
    rules.push(...parseRules(block));
  }

  const links = [];
  const tokens = [];
  const rootStyle = { color: null, bold: false, italic: false, underline: false };

  function pushText(text, style, linkIndex) {
    if (!text) return;
    tokens.push({
      text: String(text).replace(/\s+/g, ' '),
      color: style.color,
      bold: style.bold,
      italic: style.italic,
      underline: style.underline,
      linkIndex: linkIndex || null
    });
  }

  let fieldCount = 0;

  function walk(node, inherited, linkIndex) {
    if (!node) return;

    if (node.type === 'text') {
      pushText(node.data, inherited, linkIndex);
      return;
    }

    if (node.type !== 'element' && node.type !== 'document') {
      if (node.children) for (const kid of node.children) walk(kid, inherited, linkIndex);
      return;
    }

    let style = { ...inherited };

    if (node.type === 'element') {
      if (SKIP.has(node.tag)) return;

      const attrs = node.attrs || {};
      const isField = FIELD_TAGS.has(node.tag) || attrs.contenteditable !== undefined;
      if (isField) {
        const kind = String(attrs.type || '').toLowerCase();
        if (node.tag === 'input' && NON_TEXT_INPUT.has(kind)) return;
        if (attrs.contenteditable !== undefined && String(attrs.contenteditable).toLowerCase() === 'false') return;
        if (fieldHidden(attrs)) return;
        fieldCount += 1;
        let shown;
        if (kind === 'checkbox' || kind === 'radio') {
          shown = (attrs.checked !== undefined ? '[x] ' : '[ ] ') + fieldLabel(attrs, node.tag);
        } else if (node.tag === 'select') {
          shown = fieldLabel(attrs, node.tag);
        } else {
          shown = fieldLabel(attrs, node.tag);
        }
        pushText('[' + shown + '] ⟨f' + fieldCount + '⟩', inherited, linkIndex);
        return;
      }

      for (const rule of rules) {
        if (matchesSelector(node, rule.parts)) applyDecls(style, rule.decls);
      }
      if (node.attrs && node.attrs.style) applyDecls(style, parseInline(node.attrs.style));

      if (style.display === 'none' || style.visibility === 'hidden') return;

      if (node.tag === 'a' && node.attrs && node.attrs.href) {
        let href = node.attrs.href;
        try { href = new URL(href, url || undefined).href; } catch { /* keep raw */ }
        const index = links.length + 1;
        links.push({ index, url: href, text: '' });
        linkIndex = index;
      }

      if (BLOCK.has(node.tag)) tokens.push({ block: true });

      if (node.tag === 'img') {
        const alt = (node.attrs && node.attrs.alt) || '';
        pushText(alt ? '[Image: ' + alt + ']' : '[Image]', style, linkIndex);
      }
    }

    if (node.children) {
      for (const kid of node.children) walk(kid, style, linkIndex);
    }

    if (node.type === 'element' && BLOCK.has(node.tag)) tokens.push({ block: true });
  }

  walk(doc, rootStyle, null);

  // Wrap tokens into lines.
  const lines = [];
  let line = { segments: [], length: 0, linkIndex: null };

  function flush() {
    lines.push(line);
    line = { segments: [], length: 0, linkIndex: null };
  }

  for (const token of tokens) {
    if (token.block) { if (line.length) flush(); continue; }

    const words = token.text.split(' ');
    for (let i = 0; i < words.length; i++) {
      const word = words[i];
      if (!word) continue;

      const need = word.length + (line.length ? 1 : 0);
      if (line.length && line.length + need > width) flush();

      if (line.length) {
        line.segments.push({ ...token, text: ' ' });
        line.length += 1;
      }

      line.segments.push({ ...token, text: word });
      line.length += word.length;
      if (token.linkIndex) line.linkIndex = token.linkIndex;
    }
  }

  if (line.length) flush();

  // Record visible link text for the :links command.
  for (const row of lines) {
    if (!row.linkIndex) continue;
    const entry = links[row.linkIndex - 1];
    if (!entry) continue;
    const text = row.segments.map(s => s.text).join('').trim();
    if (text && entry.text.length < 120) entry.text += (entry.text ? ' ' : '') + text;
  }

  return { lines, links };
}

module.exports = { render, parseRules, toRgb };
