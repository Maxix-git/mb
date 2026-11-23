'use strict';

// MAXBROWSER — tree-based HTML parser
// Replaces the old regex extractor. Produces a real node tree that the DOM
// layer can load into QuickJS. Handles void elements, raw-text elements,
// implicit closes, comments, quoted attributes and malformed input.

const VOID_ELEMENTS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
  'link', 'meta', 'param', 'source', 'track', 'wbr'
]);

const RAW_TEXT_ELEMENTS = new Set(['script', 'style', 'textarea', 'title']);

const AUTO_CLOSE_BLOCK = new Set([
  'address', 'article', 'aside', 'blockquote', 'details', 'div', 'dl',
  'fieldset', 'figcaption', 'figure', 'footer', 'form', 'h1', 'h2', 'h3',
  'h4', 'h5', 'h6', 'header', 'hr', 'main', 'menu', 'nav', 'ol', 'p',
  'pre', 'section', 'table', 'ul'
]);

const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0',
  copy: '\u00a9', reg: '\u00ae', trade: '\u2122', hellip: '\u2026',
  mdash: '\u2014', ndash: '\u2013', lsquo: '\u2018', rsquo: '\u2019',
  ldquo: '\u201c', rdquo: '\u201d', bull: '\u2022', middot: '\u00b7',
  laquo: '\u00ab', raquo: '\u00bb', times: '\u00d7', divide: '\u00f7',
  deg: '\u00b0', plusmn: '\u00b1', frac12: '\u00bd', frac14: '\u00bc',
  frac34: '\u00be', sup2: '\u00b2', sup3: '\u00b3', micro: '\u00b5',
  para: '\u00b6', sect: '\u00a7', euro: '\u20ac', pound: '\u00a3',
  yen: '\u00a5', cent: '\u00a2', larr: '\u2190', rarr: '\u2192',
  uarr: '\u2191', darr: '\u2193', harr: '\u2194', hearts: '\u2665',
  star: '\u2606', check: '\u2713', shy: '\u00ad', ensp: '\u2002',
  emsp: '\u2003', thinsp: '\u2009', zwnj: '\u200c', zwj: '\u200d'
};

function decodeEntities(text) {
  if (!text || text.indexOf('&') === -1) return text;

  return text.replace(/&(#[xX][0-9a-fA-F]+|#[0-9]+|[a-zA-Z][a-zA-Z0-9]*);?/g, (full, body) => {
    if (body.charAt(0) === '#') {
      const hex = body.charAt(1) === 'x' || body.charAt(1) === 'X';
      const code = hex ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);

      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return full;
      if (code >= 0xd800 && code <= 0xdfff) return '\ufffd';

      try {
        return String.fromCodePoint(code);
      } catch {
        return full;
      }
    }

    const named = ENTITIES[body.toLowerCase()];
    return named === undefined ? full : named;
  });
}

function parseAttributes(raw) {
  const attrs = {};
  const pattern = /([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'`=<>]+)))?/g;

  let match;
  while ((match = pattern.exec(raw)) !== null) {
    const name = match[1].toLowerCase();
    if (name === '/' || name === '') continue;

    let value = '';
    if (match[2] !== undefined) value = match[2];
    else if (match[3] !== undefined) value = match[3];
    else if (match[4] !== undefined) value = match[4];

    if (!(name in attrs)) attrs[name] = decodeEntities(value);
  }

  return attrs;
}

function findTagEnd(html, start) {
  let quote = null;

  for (let i = start + 1; i < html.length; i++) {
    const ch = html.charAt(i);

    if (quote) {
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === '>') {
      return i;
    }
  }

  return -1;
}

function makeDocument(url) {
  return { type: 'document', tag: '#document', attrs: {}, children: [], parent: null, url: url || '' };
}

function makeElement(tag, attrs) {
  return { type: 'element', tag, attrs: attrs || {}, children: [], parent: null };
}

function makeText(data) {
  return { type: 'text', data, parent: null };
}

function makeComment(data) {
  return { type: 'comment', data, parent: null };
}

function parseHTML(html, pageURL = '') {
  const source = typeof html === 'string' ? html : '';
  const document = makeDocument(pageURL);
  const stack = [document];
  const length = source.length;

  let i = 0;

  const top = () => stack[stack.length - 1];

  function attach(node) {
    const parent = top();
    node.parent = parent;
    parent.children.push(node);
    return node;
  }

  function appendText(raw) {
    if (!raw) return;
    attach(makeText(decodeEntities(raw)));
  }

  function closeTag(tag) {
    for (let depth = stack.length - 1; depth > 0; depth--) {
      if (stack[depth].tag === tag) {
        stack.length = depth;
        return true;
      }
    }
    return false;
  }

  function implicitClose(incomingTag) {
    const open = top();
    if (open.type !== 'element') return;

    if (open.tag === 'p' && AUTO_CLOSE_BLOCK.has(incomingTag)) {
      stack.pop();
      return;
    }

    const pairs = { li: 'li', dt: 'dt', dd: 'dd', td: 'td', th: 'th', tr: 'tr', option: 'option', optgroup: 'optgroup' };
    if (pairs[incomingTag] === open.tag) stack.pop();
  }

  while (i < length) {
    const lt = source.indexOf('<', i);

    if (lt === -1) {
      appendText(source.slice(i));
      break;
    }

    if (lt > i) appendText(source.slice(i, lt));

    // Comment
    if (source.startsWith('<!--', lt)) {
      const end = source.indexOf('-->', lt + 4);
      const data = source.slice(lt + 4, end === -1 ? length : end);
      attach(makeComment(data));
      i = end === -1 ? length : end + 3;
      continue;
    }

    // Doctype or processing instruction
    if (source.charAt(lt + 1) === '!' || source.charAt(lt + 1) === '?') {
      const end = source.indexOf('>', lt);
      i = end === -1 ? length : end + 1;
      continue;
    }

    // Closing tag
    if (source.charAt(lt + 1) === '/') {
      const end = source.indexOf('>', lt);

      if (end === -1) {
        appendText(source.slice(lt));
        break;
      }

      const name = source.slice(lt + 2, end).trim().toLowerCase().split(/\s+/)[0];
      i = end + 1;

      if (name) closeTag(name);
      continue;
    }

    // Opening tag
    const end = findTagEnd(source, lt);

    if (end === -1) {
      appendText(source.slice(lt));
      break;
    }

    const raw = source.slice(lt + 1, end);
    const selfClosing = /\/\s*$/.test(raw);

    const match = raw.match(/^([a-zA-Z][^\s/>]*)([\s\S]*)$/);

    if (!match) {
      appendText(source.slice(lt, end + 1));
      i = end + 1;
      continue;
    }

    const tag = match[1].toLowerCase();
    const attrs = parseAttributes(match[2]);
    i = end + 1;

    implicitClose(tag);

    const element = attach(makeElement(tag, attrs));

    if (VOID_ELEMENTS.has(tag) || selfClosing) continue;

    stack.push(element);

    // Raw text: consume verbatim up to the matching close tag
    if (RAW_TEXT_ELEMENTS.has(tag)) {
      const closer = new RegExp('</' + tag + '\\s*>', 'i');
      const rest = source.slice(i);
      const found = rest.search(closer);

      if (found === -1) {
        element.children.push(Object.assign(makeText(tag === 'script' || tag === 'style' ? rest : decodeEntities(rest)), { parent: element }));
        i = length;
      } else {
        const body = rest.slice(0, found);
        if (body) {
          element.children.push(Object.assign(
            makeText(tag === 'script' || tag === 'style' ? body : decodeEntities(body)),
            { parent: element }
          ));
        }
        i += found + rest.slice(found).indexOf('>') + 1;
      }

      stack.pop();
    }
  }

  return document;
}

// Depth-first walk over the tree.

// Strip parent back-references so the tree can cross into QuickJS as JSON.
function toPlain(node) {
  const out = { type: node.type };

  if (node.tag) out.tag = node.tag;
  if (node.attrs) out.attrs = node.attrs;
  if (node.data !== undefined) out.data = node.data;
  if (node.url) out.url = node.url;
  if (node.children) out.children = node.children.map(toPlain);

  return out;
}

function walk(node, visit) {
  if (visit(node) === false) return;
  if (!node.children) return;

  for (const child of node.children) walk(child, visit);
}

function findFirst(node, predicate) {
  let found = null;

  walk(node, current => {
    if (found) return false;
    if (predicate(current)) {
      found = current;
      return false;
    }
    return undefined;
  });

  return found;
}

function findAll(node, predicate) {
  const out = [];
  walk(node, current => { if (predicate(current)) out.push(current); });
  return out;
}

function textContent(node) {
  if (node.type === 'text') return node.data;
  if (!node.children) return '';
  return node.children.map(textContent).join('');
}

module.exports = {
  parseHTML,
  parseAttributes,
  decodeEntities,
  textContent,
  toPlain,
  walk,
  findFirst,
  findAll,
  VOID_ELEMENTS,
  RAW_TEXT_ELEMENTS
};
