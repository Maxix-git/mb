/* MAXBROWSER — DOM bootstrap
 *
 * This file is NOT a Node module. It is read from disk and evaluated inside
 * the QuickJS sandbox, where it builds window/document on top of the parsed
 * tree the host injects.
 *
 * Host functions available here:
 *   __mb_parse(html)        -> JSON string of a fragment tree
 *   __mb_resolve(href)      -> absolute URL string
 *   __mb_fetch(url, method, body) -> Promise
 *   __mb_log(level, text)
 */

(function () {
  'use strict';

  var nodes = [];
  var listeners = new Map();
  var timers = [];
  var nextTimerId = 1;
  var BASE = '';

  var ELEMENT_NODE = 1;
  var TEXT_NODE = 3;
  var COMMENT_NODE = 8;
  var DOCUMENT_NODE = 9;

  var BLOCK = new Set([
    'html', 'body', 'div', 'p', 'section', 'article', 'header', 'footer',
    'main', 'nav', 'aside', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol',
    'li', 'table', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th', 'form',
    'fieldset', 'blockquote', 'pre', 'hr', 'br', 'figure', 'figcaption',
    'dl', 'dt', 'dd', 'address', 'details', 'summary'
  ]);

  function register(node) {
    node.__id = nodes.length;
    nodes.push(node);
    return node;
  }

  function listenerBag(id) {
    var bag = listeners.get(id);
    if (!bag) {
      bag = Object.create(null);
      listeners.set(id, bag);
    }
    return bag;
  }

  // ---------------------------------------------------------------- nodes

  function Node(type) {
    register(this);
    this.nodeType = type;
    this.parentNode = null;
    this.childNodes = [];
  }

  Node.prototype.__getChildren = function () { return this.childNodes; };

  Object.defineProperty(Node.prototype, 'children', {
    get: function () {
      return this.childNodes.filter(function (n) { return n.nodeType === ELEMENT_NODE; });
    }
  });

  function Text(data) {
    Node.call(this, TEXT_NODE);
    this.data = data == null ? '' : String(data);
  }
  Text.prototype = Object.create(Node.prototype);
  Text.prototype.constructor = Text;
  Object.defineProperty(Text.prototype, 'nodeValue', {
    get: function () { return this.data; },
    set: function (v) { this.data = v == null ? '' : String(v); }
  });
  Object.defineProperty(Text.prototype, 'textContent', {
    get: function () { return this.data; },
    set: function (v) { this.data = v == null ? '' : String(v); }
  });

  function Comment(data) {
    Node.call(this, COMMENT_NODE);
    this.data = data == null ? '' : String(data);
  }
  Comment.prototype = Object.create(Node.prototype);
  Comment.prototype.constructor = Comment;

  function Element(tag, attrs) {
    Node.call(this, ELEMENT_NODE);
    this.tagName = String(tag || 'div').toUpperCase();
    this.localName = String(tag || 'div').toLowerCase();
    this._attrs = attrs || {};
    this.style = new Style(this);
    this.classList = new ClassList(this);
    this.dataset = new Dataset(this);
  }
  Element.prototype = Object.create(Node.prototype);
  Element.prototype.constructor = Element;

  // ------------------------------------------------------------- classList

  function ClassList(el) {
    this.__el = el;
  }
  ClassList.prototype._list = function () {
    return String(this.__el._attrs['class'] || '').split(/\s+/).filter(Boolean);
  };
  ClassList.prototype._save = function (list) {
    this.__el._attrs['class'] = list.join(' ');
  };
  ClassList.prototype.add = function () {
    var list = this._list();
    for (var i = 0; i < arguments.length; i++) {
      if (list.indexOf(arguments[i]) === -1) list.push(arguments[i]);
    }
    this._save(list);
  };
  ClassList.prototype.remove = function () {
    var list = this._list();
    for (var i = 0; i < arguments.length; i++) {
      var at = list.indexOf(arguments[i]);
      if (at !== -1) list.splice(at, 1);
    }
    this._save(list);
  };
  ClassList.prototype.contains = function (name) {
    return this._list().indexOf(name) !== -1;
  };
  ClassList.prototype.toggle = function (name, force) {
    var has = this.contains(name);
    var want = force === undefined ? !has : !!force;
    if (want && !has) this.add(name);
    if (!want && has) this.remove(name);
    return want;
  };
  Object.defineProperty(ClassList.prototype, 'value', {
    get: function () { return this._list().join(' '); }
  });

  // ----------------------------------------------------------------- style

  function Style(el) {
    this.__el = el;
    this.__props = Object.create(null);
  }
  Style.prototype.setProperty = function (name, value) {
    this.__props[String(name).toLowerCase()] = String(value);
    this.__sync();
  };
  Style.prototype.getPropertyValue = function (name) {
    return this.__props[String(name).toLowerCase()] || '';
  };
  Style.prototype.removeProperty = function (name) {
    delete this.__props[String(name).toLowerCase()];
    this.__sync();
  };
  Style.prototype.__sync = function () {
    var parts = [];
    for (var key in this.__props) parts.push(key + ':' + this.__props[key]);
    this.__el._attrs.style = parts.join(';');
  };
  Style.prototype.toString = function () { return this.__el._attrs.style || ''; };

  // --------------------------------------------------------------- dataset

  function Dataset(el) { this.__el = el; }
  Object.defineProperty(Dataset.prototype, 'get', {
    value: function (name) {
      return this.__el._attrs['data-' + String(name).toLowerCase()] || '';
    }
  });

  // ------------------------------------------------------ element behaviour

  Element.prototype.getAttribute = function (name) {
    var key = String(name).toLowerCase();
    return key in this._attrs ? this._attrs[key] : null;
  };
  Element.prototype.setAttribute = function (name, value) {
    this._attrs[String(name).toLowerCase()] = String(value);
  };
  Element.prototype.hasAttribute = function (name) {
    return String(name).toLowerCase() in this._attrs;
  };
  Element.prototype.removeAttribute = function (name) {
    delete this._attrs[String(name).toLowerCase()];
  };
  Element.prototype.getAttributeNames = function () {
    return Object.keys(this._attrs);
  };

  Object.defineProperty(Element.prototype, 'id', {
    get: function () { return this._attrs.id || ''; },
    set: function (v) { this._attrs.id = String(v); }
  });
  Object.defineProperty(Element.prototype, 'className', {
    get: function () { return this._attrs['class'] || ''; },
    set: function (v) { this._attrs['class'] = String(v); }
  });
  Object.defineProperty(Element.prototype, 'children', {
    get: function () {
      return this.childNodes.filter(function (n) { return n.nodeType === ELEMENT_NODE; });
    }
  });
  Object.defineProperty(Element.prototype, 'firstChild', {
    get: function () { return this.childNodes[0] || null; }
  });
  Object.defineProperty(Element.prototype, 'lastChild', {
    get: function () { return this.childNodes[this.childNodes.length - 1] || null; }
  });
  Object.defineProperty(Element.prototype, 'firstElementChild', {
    get: function () { return this.children[0] || null; }
  });
  Object.defineProperty(Element.prototype, 'nextSibling', {
    get: function () {
      if (!this.parentNode) return null;
      var list = this.parentNode.childNodes;
      var at = list.indexOf(this);
      return at === -1 ? null : list[at + 1] || null;
    }
  });

  Object.defineProperty(Element.prototype, 'textContent', {
    get: function () { return textOf(this); },
    set: function (value) {
      this.childNodes.forEach(function (child) { child.parentNode = null; });
      this.childNodes = [];
      var text = value == null ? '' : String(value);
      if (text) this.appendChild(new Text(text));
    }
  });

  Object.defineProperty(Element.prototype, 'innerText', {
    get: function () { return textOf(this); },
    set: function (value) { this.textContent = value; }
  });

  Object.defineProperty(Element.prototype, 'innerHTML', {
    get: function () { return htmlOf(this); },
    set: function (value) {
      this.childNodes.forEach(function (child) { child.parentNode = null; });
      this.childNodes = [];
      var tree = parseFragment(value == null ? '' : String(value));
      var self = this;
      (tree.children || []).forEach(function (child) { self.appendChild(buildNode(child)); });
    }
  });

  Object.defineProperty(Element.prototype, 'outerHTML', {
    get: function () { return htmlOf(this); }
  });

  Element.prototype.appendChild = function (child) {
    if (!child) return child;
    if (child.parentNode) child.parentNode.removeChild(child);
    child.parentNode = this;
    this.childNodes.push(child);
    return child;
  };

  Element.prototype.insertBefore = function (child, reference) {
    if (!reference) return this.appendChild(child);
    if (child.parentNode) child.parentNode.removeChild(child);
    var at = this.childNodes.indexOf(reference);
    child.parentNode = this;
    if (at === -1) this.childNodes.push(child);
    else this.childNodes.splice(at, 0, child);
    return child;
  };

  Element.prototype.removeChild = function (child) {
    var at = this.childNodes.indexOf(child);
    if (at !== -1) {
      this.childNodes.splice(at, 1);
      child.parentNode = null;
    }
    return child;
  };

  Element.prototype.replaceChild = function (fresh, stale) {
    var at = this.childNodes.indexOf(stale);
    if (at === -1) return stale;
    if (fresh.parentNode) fresh.parentNode.removeChild(fresh);
    fresh.parentNode = this;
    this.childNodes[at] = fresh;
    stale.parentNode = null;
    return stale;
  };

  Element.prototype.remove = function () {
    if (this.parentNode) this.parentNode.removeChild(this);
  };

  Element.prototype.hasChildNodes = function () { return this.childNodes.length > 0; };

  Element.prototype.cloneNode = function (deep) {
    var copy = new Element(this.localName, Object.assign({}, this._attrs));
    if (deep) {
      this.childNodes.forEach(function (child) {
        if (child.nodeType === TEXT_NODE) copy.appendChild(new Text(child.data));
        else if (child.nodeType === ELEMENT_NODE) copy.appendChild(child.cloneNode(true));
      });
    }
    return copy;
  };

  Element.prototype.matches = function (selector) {
    return matchAny(this, selector);
  };

  Element.prototype.closest = function (selector) {
    var node = this;
    while (node && node.nodeType === ELEMENT_NODE) {
      if (matchAny(node, selector)) return node;
      node = node.parentNode;
    }
    return null;
  };

  Element.prototype.querySelector = function (selector) {
    return query(this, selector, true)[0] || null;
  };
  Element.prototype.querySelectorAll = function (selector) {
    return query(this, selector, false);
  };
  Element.prototype.getElementsByTagName = function (tag) {
    return query(this, String(tag), false);
  };
  Element.prototype.getElementsByClassName = function (name) {
    return query(this, '.' + String(name), false);
  };

  // ---------------------------------------------------------------- events

  function addListener(target, type, fn, options) {
    if (typeof fn !== 'function') return;
    var bag = listenerBag(target.__id);
    var key = String(type);
    if (!bag[key]) bag[key] = [];
    bag[key].push({ fn: fn, once: !!(options && options.once) });
  }

  function removeListener(target, type, fn) {
    var bag = listeners.get(target.__id);
    if (!bag || !bag[type]) return;
    bag[type] = bag[type].filter(function (entry) { return entry.fn !== fn; });
  }

  function fire(target, type, detail) {
    var bag = listeners.get(target.__id);
    var event = {
      type: type,
      target: target,
      currentTarget: target,
      detail: detail === undefined ? null : detail,
      defaultPrevented: false,
      propagationStopped: false,
      preventDefault: function () { this.defaultPrevented = true; },
      stopPropagation: function () { this.propagationStopped = true; }
    };

    if (bag && bag[type]) {
      bag[type] = bag[type].filter(function (entry) {
        try {
          entry.fn.call(target, event);
        } catch (error) {
          reportError('event handler for "' + type + '" threw: ' + error);
        }
        return !entry.once;
      });
    }

    // Inline handlers, e.g. onclick="..."
    var inline = target._attrs && target._attrs['on' + type];
    if (inline) {
      try {
        /* eslint-disable no-new-func */
        new Function('event', inline).call(target, event);
      } catch (error) {
        reportError('inline handler for "' + type + '" threw: ' + error);
      }
    }

    // Simple bubbling
    if (!event.propagationStopped && type !== 'click') {
      var parent = target.parentNode;
      while (parent) {
        var parentBag = listeners.get(parent.__id);
        if (parentBag && parentBag[type]) {
          parentBag[type].forEach(function (entry) {
            try { entry.fn.call(parent, event); } catch (e) { reportError(String(e)); }
          });
        }
        if (event.propagationStopped) break;
        parent = parent.parentNode;
      }
    }

    return !event.defaultPrevented;
  }

  Node.prototype.addEventListener = function (type, fn, options) {
    addListener(this, type, fn, options);
  };
  Node.prototype.removeEventListener = function (type, fn) {
    removeListener(this, type, fn);
  };
  Node.prototype.dispatchEvent = function (event) {
    return fire(this, event && event.type ? event.type : 'event', event && event.detail);
  };

  Element.prototype.click = function () {
    fire(this, 'click', null);
  };

  // ------------------------------------------------------------ text / html

  function textOf(node) {
    if (node.nodeType === TEXT_NODE) return node.data;
    var out = '';
    var kids = node.childNodes || [];
    for (var i = 0; i < kids.length; i++) {
      var child = kids[i];
      if (child.nodeType === COMMENT_NODE) continue;
      if (child.nodeType === ELEMENT_NODE) {
        var tag = child.localName;
        if (tag === 'script' || tag === 'style' || tag === 'template') continue;
        if (tag === 'br') { out += '\n'; continue; }
        var inner = textOf(child);
        out += BLOCK.has(tag) ? '\n' + inner + '\n' : inner;
      } else {
        out += textOf(child);
      }
    }
    return out;
  }

  function escapeText(value) {
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  function htmlOf(node) {
    if (node.nodeType === TEXT_NODE) return escapeText(node.data);
    if (node.nodeType === COMMENT_NODE) return '<!--' + node.data + '-->';
    if (node.nodeType === DOCUMENT_NODE) {
      return (node.childNodes || []).map(htmlOf).join('');
    }
    var attrs = '';
    for (var key in node._attrs) {
      attrs += ' ' + key + '="' + escapeText(node._attrs[key]).replace(/"/g, '&quot;') + '"';
    }
    var tag = node.localName;
    var inner = node.childNodes.map(htmlOf).join('');
    return '<' + tag + attrs + '>' + inner + '</' + tag + '>';
  }

  // -------------------------------------------------------------- selectors

  function parseCompound(part) {
    var out = { tag: null, id: null, classes: [], attrs: [] };
    var rest = part;
    var tagMatch = rest.match(/^([a-zA-Z*][a-zA-Z0-9-]*|\*)/);
    if (tagMatch) {
      if (tagMatch[1] !== '*') out.tag = tagMatch[1].toLowerCase();
      rest = rest.slice(tagMatch[1].length);
    }

    var pattern = /([.#][\w-]+|\[[^\]]+\])/g;
    var match;
    while ((match = pattern.exec(rest)) !== null) {
      var token = match[1];
      if (token.charAt(0) === '.') out.classes.push(token.slice(1));
      else if (token.charAt(0) === '#') out.id = token.slice(1);
      else {
        var body = token.slice(1, -1);
        var eq = body.indexOf('=');
        if (eq === -1) out.attrs.push({ name: body.trim().toLowerCase(), value: null });
        else {
          out.attrs.push({
            name: body.slice(0, eq).trim().toLowerCase(),
            value: body.slice(eq + 1).trim().replace(/^["']|["']$/g, '')
          });
        }
      }
    }
    return out;
  }

  function matchCompound(el, compound) {
    if (el.nodeType !== ELEMENT_NODE) return false;
    if (compound.tag && el.localName !== compound.tag) return false;
    if (compound.id && el._attrs.id !== compound.id) return false;

    for (var i = 0; i < compound.classes.length; i++) {
      var cls = String(el._attrs['class'] || '').split(/\s+/);
      if (cls.indexOf(compound.classes[i]) === -1) return false;
    }

    for (var j = 0; j < compound.attrs.length; j++) {
      var spec = compound.attrs[j];
      if (!(spec.name in el._attrs)) return false;
      if (spec.value !== null && el._attrs[spec.name] !== spec.value) return false;
    }

    return true;
  }

  function parseChain(selector) {
    var tokens = selector.trim().replace(/\s*>\s*/g, ' > ').split(/\s+/);
    var chain = [];
    var combinator = ' ';

    for (var i = 0; i < tokens.length; i++) {
      var token = tokens[i];
      if (token === '>') { combinator = '>'; continue; }
      chain.push({ combinator: chain.length === 0 ? null : combinator, compound: parseCompound(token) });
      combinator = ' ';
    }

    return chain;
  }

  function matchChain(el, chain) {
    var index = chain.length - 1;
    if (!matchCompound(el, chain[index].compound)) return false;

    var node = el;
    index--;

    while (index >= 0) {
      var step = chain[index];
      if (step.combinator === '>') {
        node = node.parentNode;
        if (!node || node.nodeType !== ELEMENT_NODE) return false;
        if (!matchCompound(node, step.compound)) return false;
      } else {
        var found = false;
        var parent = node.parentNode;
        while (parent && parent.nodeType === ELEMENT_NODE) {
          if (matchCompound(parent, step.compound)) { found = true; node = parent; break; }
          parent = parent.parentNode;
        }
        if (!found) return false;
      }
      index--;
    }

    return true;
  }

  function matchAny(el, selector) {
    var groups = String(selector).split(',');
    for (var i = 0; i < groups.length; i++) {
      var text = groups[i].trim();
      if (!text) continue;
      if (matchChain(el, parseChain(text))) return true;
    }
    return false;
  }

  function query(root, selector, firstOnly) {
    var groups = String(selector).split(',').map(function (s) { return s.trim(); }).filter(Boolean);
    var chains = groups.map(parseChain);
    var results = [];

    (function visit(node) {
      var kids = node.childNodes || [];
      for (var i = 0; i < kids.length; i++) {
        var child = kids[i];
        if (child.nodeType !== ELEMENT_NODE) continue;
        for (var c = 0; c < chains.length; c++) {
          if (matchChain(child, chains[c])) { results.push(child); break; }
        }
        if (firstOnly && results.length) return;
        visit(child);
        if (firstOnly && results.length) return;
      }
    })(root);

    return results;
  }

  // -------------------------------------------------------------- building

  function buildNode(spec) {
    if (!spec) return null;

    if (spec.type === 'text') return new Text(spec.data || '');
    if (spec.type === 'comment') return new Comment(spec.data || '');

    if (spec.type === 'document') {
      var doc = new Document(spec.url || BASE);
      (spec.children || []).forEach(function (child) {
        var built = buildNode(child);
        if (built) { built.parentNode = doc; doc.childNodes.push(built); }
      });
      return doc;
    }

    var el = new Element(spec.tag, spec.attrs || {});
    (spec.children || []).forEach(function (child) {
      var built = buildNode(child);
      if (built) { built.parentNode = el; el.childNodes.push(built); }
    });
    return el;
  }

  function parseFragment(html) {
    try {
      var raw = __mb_parse(String(html));
      return JSON.parse(raw);
    } catch (error) {
      reportError('fragment parse failed: ' + error);
      return { type: 'document', children: [] };
    }
  }

  // ------------------------------------------------------------- document

  function Document(url) {
    Node.call(this, DOCUMENT_NODE);
    this.URL = url || BASE;
    this.readyState = 'loading';
    this.title = '';
  }
  Document.prototype = Object.create(Node.prototype);
  Document.prototype.constructor = Document;

  Object.defineProperty(Document.prototype, 'documentElement', {
    get: function () {
      return this.children.find(function (n) { return n.localName === 'html'; }) || null;
    }
  });
  Object.defineProperty(Document.prototype, 'head', {
    get: function () {
      var html = this.documentElement;
      if (!html) return null;
      return html.children.find(function (n) { return n.localName === 'head'; }) || null;
    }
  });
  Object.defineProperty(Document.prototype, 'body', {
    get: function () {
      var html = this.documentElement;
      if (!html) return null;
      return html.children.find(function (n) { return n.localName === 'body'; }) || null;
    }
  });

  Document.prototype.createElement = function (tag) { return new Element(tag, {}); };
  Document.prototype.createTextNode = function (text) { return new Text(text); };
  Document.prototype.createComment = function (text) { return new Comment(text); };
  Document.prototype.getElementById = function (id) {
    var found = null;
    query(this, '#' + String(id), true).some(function (el) { found = el; return true; });
    return found;
  };
  Document.prototype.querySelector = function (selector) {
    return query(this, selector, true)[0] || null;
  };
  Document.prototype.querySelectorAll = function (selector) {
    return query(this, selector, false);
  };
  Document.prototype.getElementsByTagName = function (tag) {
    return query(this, String(tag), false);
  };
  Document.prototype.getElementsByClassName = function (name) {
    return query(this, '.' + String(name), false);
  };
  Document.prototype.addEventListener = function (type, fn, options) {
    addListener(this, type, fn, options);
  };
  Document.prototype.removeEventListener = function (type, fn) {
    removeListener(this, type, fn);
  };
  Document.prototype.dispatchEvent = function (event) {
    return fire(this, event && event.type ? event.type : 'event', event && event.detail);
  };
  Document.prototype.write = function () {
    var body = this.body;
    if (!body) return;
    for (var i = 0; i < arguments.length; i++) {
      var tree = parseFragment(arguments[i]);
      var self = body;
      (tree.children || []).forEach(function (child) { self.appendChild(buildNode(child)); });
    }
  };

  // ---------------------------------------------------------------- timers

  function setTimeoutImpl(fn, delay) {
    var id = nextTimerId++;
    timers.push({ id: id, fn: fn, due: Date.now() + (Number(delay) || 0), repeat: 0 });
    return id;
  }

  function setIntervalImpl(fn, delay) {
    var id = nextTimerId++;
    timers.push({ id: id, fn: fn, due: Date.now() + (Number(delay) || 0), repeat: Number(delay) || 1 });
    return id;
  }

  function clearTimer(id) {
    timers = timers.filter(function (entry) { return entry.id !== id; });
  }

  // Called from the host after the main script has run.
  // grace: treat timers due within this many ms as due now. requestAnimationFrame
  // is a 16ms timer and React's scheduler defers, so an exact-now pump runs
  // nothing at all on a real app.
  function runTimers(graceMs) {
    var ran = 0;
    var guard = 0;
    var grace = Number(graceMs) || 0;

    while (guard++ < 400) {
      var now = Date.now() + grace;
      var due = timers.filter(function (entry) { return entry.due <= now; });
      if (!due.length) break;

      due.forEach(function (entry) {
        ran++;
        if (entry.repeat) entry.due = now + entry.repeat;
        else timers = timers.filter(function (other) { return other.id !== entry.id; });

        try {
          entry.fn();
        } catch (error) {
          reportError('timer threw: ' + error);
        }
      });
    }

    return ran;
  }

  // ----------------------------------------------------------------- fetch

  function fetchImpl(url, options) {
    var target = String(url);
    var absolute = __mb_resolve(target);
    var method = (options && options.method) || 'GET';
    var body = options && options.body ? String(options.body) : '';

    return __mb_fetch(absolute, String(method).toUpperCase(), body).then(function (raw) {
      var payload = JSON.parse(raw);
      return new Response(payload);
    });
  }

  function Response(payload) {
    this.url = payload.url;
    this.status = payload.status;
    this.statusText = payload.statusText || '';
    this.ok = payload.status >= 200 && payload.status < 300;
    this.redirected = !!payload.redirected;
    this._body = payload.body || '';
    this._headers = payload.headers || {};
  }

  Response.prototype.text = function () {
    return Promise.resolve(this._body);
  };
  Response.prototype.json = function () {
    try {
      return Promise.resolve(JSON.parse(this._body));
    } catch (error) {
      return Promise.reject(error);
    }
  };
  Response.prototype.headers = function () { return null; };
  Response.prototype.header = function (name) {
    var key = String(name).toLowerCase();
    for (var k in this._headers) {
      if (k.toLowerCase() === key) return this._headers[k];
    }
    return null;
  };

  // ------------------------------------------------------------- reporting

  function reportError(message) {
    try {
      __mb_log('error', String(message));
    } catch (error) {
      // logging must never throw
    }
  }

  // ------------------------------------------------------------ serializing

  function collectLinks(root) {
    var out = [];
    var anchors = query(root, 'a[href]', false);
    for (var i = 0; i < anchors.length; i++) {
      var anchor = anchors[i];
      var text = textOf(anchor).replace(/\s+/g, ' ').trim();
      var href = anchor._attrs.href || '';
      if (!href) continue;
      if (/^(javascript:|#|mailto:|tel:)/i.test(href)) continue;
      var absolute;
      try { absolute = __mb_resolve(href); } catch (error) { absolute = href; }
      if (!/^https?:/i.test(absolute)) continue;
      out.push({ text: text || absolute, url: absolute });
    }
    return out;
  }

  function tidy(text) {
    return String(text)
      .replace(/\r/g, '')
      .split('\n')
      .map(function (line) { return line.replace(/[ \t]+/g, ' ').trim(); })
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  function serialize(limit) {
    var doc = globalThis.document;

    var styleNodes = query(doc, 'style', false);
    var styles = [];
    for (var si = 0; si < styleNodes.length; si++) {
      styles.push(styleNodes[si].textContent || '');
    }

    var body = doc.body || doc.documentElement || doc;
    var text = tidy(textOf(body));
    var html = htmlOf(body);

    var maxText = limit || 20000;
    if (text.length > maxText) text = text.slice(0, maxText) + '\n[truncated]';
    if (html.length > 40000) html = html.slice(0, 40000);

    return JSON.stringify({
      styles: styles.slice(0, 20),
      title: doc.title || '',
      url: doc.URL,
      text: text,
      html: html,
      links: collectLinks(doc),
      scripts: (globalThis.__mb_scriptCount || 0),
      errors: (globalThis.__mb_errors || []).slice(0, 20)
    });
  }

  // ----------------------------------------------------------------- setup

  var document = new Document(BASE);
  var windowListeners = [];

  var globalObject = globalThis;
  globalObject.window = globalObject;
  globalObject.self = globalObject;
  globalObject.document = document;
  globalObject.Node = Node;
  globalObject.Element = Element;
  globalObject.Text = Text;

  globalObject.setTimeout = setTimeoutImpl;
  globalObject.setInterval = setIntervalImpl;
  globalObject.clearTimeout = clearTimer;
  globalObject.clearInterval = clearTimer;
  globalObject.requestAnimationFrame = function (fn) {
    return setTimeoutImpl(function () { fn(Date.now()); }, 16);
  };
  globalObject.cancelAnimationFrame = clearTimer;

  globalObject.fetch = fetchImpl;
  globalObject.Headers = function () {};

  globalObject.addEventListener = function (type, fn, options) {
    windowListeners.push({ type: type, fn: fn, once: !!(options && options.once) });
  };
  globalObject.removeEventListener = function (type, fn) {
    windowListeners = windowListeners.filter(function (e) { return e.fn !== fn || e.type !== type; });
  };
  globalObject.dispatchEvent = function (event) {
    var type = event && event.type ? event.type : 'event';
    windowListeners = windowListeners.filter(function (entry) {
      if (entry.type !== type) return true;
      try { entry.fn.call(globalObject, event); } catch (error) { reportError(String(error)); }
      return !entry.once;
    });
    return true;
  };

  globalObject.location = {
    get href() { return document.URL; },
    get protocol() { var m = document.URL.match(/^([a-z]+:)/i); return m ? m[1] : 'https:'; },
    get hostname() { var m = document.URL.match(/^[a-z]+:\/\/([^/:?#]+)/i); return m ? m[1] : ''; },
    get host() { return this.hostname; },
    get pathname() { var m = document.URL.match(/^[a-z]+:\/\/[^/?#]*([^?#]*)/i); return m ? m[1] || '/' : '/'; },
    get search() { var m = document.URL.match(/\?[^#]*/); return m ? m[0] : ''; },
    get hash() { var m = document.URL.match(/#.*$/); return m ? m[0] : ''; },
    assign: function (href) { reportError('navigation blocked in sandbox: ' + href); },
    replace: function (href) { reportError('navigation blocked in sandbox: ' + href); },
    reload: function () { reportError('reload blocked in sandbox'); }
  };

  globalObject.navigator = {
    userAgent: 'Mozilla/5.0 (Linux; Android 15) MAXBROWSER/0.4',
    platform: 'Linux armv8l',
    language: 'en-US',
    languages: ['en-US'],
    onLine: true,
    cookieEnabled: false
  };

  function makeStorage() {
    var data = Object.create(null);
    return {
      getItem: function (k) { return k in data ? data[k] : null; },
      setItem: function (k, v) { data[String(k)] = String(v); },
      removeItem: function (k) { delete data[k]; },
      clear: function () { data = Object.create(null); },
      key: function (i) { return Object.keys(data)[i] || null; },
      get length() { return Object.keys(data).length; }
    };
  }

  globalObject.localStorage = makeStorage();
  globalObject.sessionStorage = makeStorage();

  globalObject.URL = function (href, base) {
    var resolved = __mb_resolve(base ? String(base) + ' ' + String(href) : String(href));
    this.href = resolved;
  };

  globalObject.getComputedStyle = function (el) {
    var style = { getPropertyValue: function (name) {
      if (!el || !el._attrs) return '';
      var inline = (el._attrs.style || '').split(';');
      for (var i = 0; i < inline.length; i++) {
        var bits = inline[i].split(':');
        if (bits.length === 2 && bits[0].trim() === String(name)) return bits[1].trim();
      }
      return '';
    } };
    return style;
  };

  globalObject.alert = function (message) { reportError('alert: ' + message); };
  globalObject.confirm = function (message) { reportError('confirm: ' + message); return false; };
  globalObject.prompt = function (message) { reportError('prompt: ' + message); return null; };


  // ------------------------------------------------------- compatibility
  // Surface that jQuery, React, Vue and similar libraries probe for.

  Object.defineProperty(Element.prototype, 'nodeName', {
    get: function () { return this.tagName; }
  });
  Object.defineProperty(Element.prototype, 'ownerDocument', {
    get: function () { return globalThis.document; }
  });
  Object.defineProperty(Element.prototype, 'attributes', {
    get: function () {
      var list = [];
      var keys = Object.keys(this._attrs);

      for (var i = 0; i < keys.length; i++) {
        var name = keys[i];
        var entry = {
          name: name,
          nodeName: name,
          value: this._attrs[name],
          nodeValue: this._attrs[name],
          expando: undefined
        };
        list.push(entry);
        list[name] = entry;
      }

      list.getNamedItem = function (wanted) {
        for (var j = 0; j < list.length; j++) {
          if (list[j].name === wanted) return list[j];
        }
        return null;
      };
      list.item = function (index) { return list[index] || null; };

      return list;
    }
  });

  Object.defineProperty(Element.prototype, 'nextElementSibling', {
    get: function () {
      if (!this.parentNode) return null;
      var kids = this.parentNode.children;
      var at = kids.indexOf(this);
      return at === -1 ? null : kids[at + 1] || null;
    }
  });
  Object.defineProperty(Element.prototype, 'previousElementSibling', {
    get: function () {
      if (!this.parentNode) return null;
      var kids = this.parentNode.children;
      var at = kids.indexOf(this);
      return at <= 0 ? null : kids[at - 1] || null;
    }
  });

  Element.prototype.contains = function (other) {
    var node = other;
    while (node) { if (node === this) return true; node = node.parentNode; }
    return false;
  };
  Element.prototype.getBoundingClientRect = function () {
    return { top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0 };
  };
  Element.prototype.getClientRects = function () { return []; };
  var focusedNode = null;

  Element.prototype.focus = function () {
    if (focusedNode && focusedNode !== this) {
      fire(focusedNode, 'blur', null);
    }
    focusedNode = this;
    fire(this, 'focus', null);
  };

  Element.prototype.blur = function () {
    if (focusedNode === this) {
      focusedNode = null;
      fire(this, 'blur', null);
    }
  };

  Element.prototype.requestSubmit = function () {
    fire(this, 'submit', null);
  };

  Object.defineProperty(document, 'activeElement', {
    configurable: true,
    get: function () {
      return focusedNode || document.body || null;
    }
  });
  Element.prototype.scrollIntoView = function () {};
  Element.prototype.getAttributeNS = function (ns, name) { return this.getAttribute(name); };
  Element.prototype.setAttributeNS = function (ns, name, value) { this.setAttribute(name, value); };
  Element.prototype.insertAdjacentHTML = function (position, html) {
    var tree = parseFragment(html);
    var self = this;
    var built = (tree.children || []).map(buildNode);

    if (position === 'beforeend') {
      built.forEach(function (n) { self.appendChild(n); });
    } else if (position === 'afterbegin') {
      built.reverse().forEach(function (n) { self.insertBefore(n, self.firstChild); });
    } else {
      built.forEach(function (n) { self.appendChild(n); });
    }
  };

  ['offsetWidth', 'offsetHeight', 'offsetTop', 'offsetLeft', 'clientWidth', 'clientHeight',
   'clientTop', 'clientLeft', 'scrollWidth', 'scrollHeight', 'scrollTop', 'scrollLeft'
  ].forEach(function (name) {
    Object.defineProperty(Element.prototype, name, {
      get: function () { return 0; },
      set: function () {}
    });
  });

  Document.prototype.createElementNS = function (ns, tag) { return new Element(tag, {}); };
  Document.prototype.getElementsByName = function (name) {
    return query(this, '[name="' + String(name) + '"]', false);
  };
  Document.prototype.elementFromPoint = function () { return null; };
  Document.prototype.hasFocus = function () { return true; };

  Object.defineProperty(Document.prototype, 'defaultView', {
    get: function () { return globalThis; }
  });
  Object.defineProperty(Document.prototype, 'characterSet', {
    get: function () { return 'UTF-8'; }
  });
  Object.defineProperty(Document.prototype, 'compatMode', {
    get: function () { return 'CSS1Compat'; }
  });
  Object.defineProperty(Document.prototype, 'implementation', {
    get: function () {
      var self = this;
      return {
        createHTMLDocument: function (title) {
          var doc = new Document(self.URL);
          var html = new Element('html', {});
          var head = new Element('head', {});
          var body = new Element('body', {});

          if (title) {
            var titleEl = new Element('title', {});
            titleEl.appendChild(new Text(title));
            head.appendChild(titleEl);
          }

          html.appendChild(head);
          html.appendChild(body);
          html.parentNode = doc;
          doc.childNodes.push(html);

          return doc;
        },
        hasFeature: function () { return true; }
      };
    }
  });

  globalObject.innerWidth = 80;
  globalObject.innerHeight = 24;
  globalObject.outerWidth = 80;
  globalObject.outerHeight = 24;
  globalObject.pageXOffset = 0;
  globalObject.pageYOffset = 0;
  globalObject.scrollX = 0;
  globalObject.scrollY = 0;
  globalObject.devicePixelRatio = 1;
  globalObject.screen = { width: 80, height: 24, availWidth: 80, availHeight: 24 };

  globalObject.scrollTo = function () {};
  globalObject.scrollBy = function () {};
  globalObject.focus = function () {};
  globalObject.print = function () {};
  globalObject.open = function () { reportError('window.open blocked in sandbox'); return null; };
  globalObject.close = function () {};

  globalObject.history = {
    length: 1,
    state: null,
    pushState: function () {},
    replaceState: function () {},
    back: function () {},
    forward: function () {},
    go: function () {}
  };

  globalObject.matchMedia = function (query) {
    return {
      matches: false,
      media: String(query),
      addListener: function () {},
      removeListener: function () {},
      addEventListener: function () {},
      removeEventListener: function () {}
    };
  };

  globalObject.Headers = function (init) {
    var store = Object.create(null);
    this.get = function (name) { return store[String(name).toLowerCase()] || null; };
    this.set = function (name, value) { store[String(name).toLowerCase()] = String(value); };
    this.has = function (name) { return String(name).toLowerCase() in store; };
    this.append = function (name, value) { store[String(name).toLowerCase()] = String(value); };
    this.forEach = function (fn) { for (var key in store) fn(store[key], key); };
  };

  globalObject.XMLHttpRequest = function () {
    var self = this;
    this.readyState = 0;
    this.status = 0;
    this.responseText = '';
    this.response = '';
    this.onreadystatechange = null;
    this.onerror = null;
    this.open = function () { self.readyState = 1; };
    this.setRequestHeader = function () {};
    this.getAllResponseHeaders = function () { return ''; };
    this.abort = function () {};
    this.send = function () {
      self.readyState = 4;
      reportError('XMLHttpRequest is not supported yet; use fetch');
      if (typeof self.onerror === 'function') self.onerror({ type: 'error' });
      if (typeof self.onreadystatechange === 'function') self.onreadystatechange({ type: 'readystatechange' });
    };
  };

  if (typeof Promise.prototype.finally !== 'function') {
    Promise.prototype.finally = function (handler) {
      var Ctor = this.constructor;
      return this.then(
        function (value) { return Ctor.resolve(handler()).then(function () { return value; }); },
        function (reason) { return Ctor.resolve(handler()).then(function () { throw reason; }); }
      );
    };
  }

  if (typeof Array.prototype.includes !== 'function') {
    Array.prototype.includes = function (needle) { return this.indexOf(needle) !== -1; };
  }

  if (typeof Object.entries !== 'function') {
    Object.entries = function (obj) { return Object.keys(obj).map(function (k) { return [k, obj[k]]; }); };
  }

  if (typeof Object.values !== 'function') {
    Object.values = function (obj) { return Object.keys(obj).map(function (k) { return obj[k]; }); };
  }

  if (typeof String.prototype.includes !== 'function') {
    String.prototype.includes = function (needle) { return this.indexOf(needle) !== -1; };
  }



  // Structural methods must live on Node so DocumentFragment and Text have them.
  ['appendChild', 'insertBefore', 'removeChild', 'replaceChild', 'remove', 'hasChildNodes'
  ].forEach(function (name) {
    if (!Node.prototype[name]) Node.prototype[name] = Element.prototype[name];
  });

  Object.defineProperty(Node.prototype, 'ownerDocument', {
    get: function () {
      return this.nodeType === DOCUMENT_NODE ? null : globalThis.document;
    }
  });

  // DOM nodes have no JSON form; keep JSON.stringify from probing them.
  Node.prototype.toJSON = function () {
    return { nodeType: this.nodeType, nodeName: this.nodeName || '#text' };
  };


  // ------------------------------------------------- observers and crypto

  globalObject.MutationObserver = function (callback) {
    this.observe = function () {};
    this.disconnect = function () {};
    this.takeRecords = function () { return []; };
  };

  globalObject.IntersectionObserver = function (callback) {
    this.observe = function () {};
    this.unobserve = function () {};
    this.disconnect = function () {};
    this.takeRecords = function () { return []; };
  };

  globalObject.ResizeObserver = function (callback) {
    this.observe = function () {};
    this.unobserve = function () {};
    this.disconnect = function () {};
  };

  globalObject.queueMicrotask = function (fn) {
    Promise.resolve().then(fn);
  };

  globalObject.crypto = {
    getRandomValues: function (array) {
      var raw = __mb_random(array.length);
      for (var i = 0; i < array.length; i++) array[i] = raw.charCodeAt(i) & 255;
      return array;
    },
    randomUUID: function () {
      var bytes = [];
      var raw = __mb_random(16);
      for (var i = 0; i < 16; i++) bytes.push(raw.charCodeAt(i) & 255);

      bytes[6] = (bytes[6] & 0x0f) | 0x40;
      bytes[8] = (bytes[8] & 0x3f) | 0x80;

      var hex = bytes.map(function (b) {
        var part = b.toString(16);
        return part.length === 1 ? '0' + part : part;
      });

      return hex.slice(0, 4).join('') + '-' + hex.slice(4, 6).join('') + '-' +
             hex.slice(6, 8).join('') + '-' + hex.slice(8, 10).join('') + '-' +
             hex.slice(10, 16).join('');
    }
  };

  globalObject.performance = {
    now: function () { return Date.now(); },
    mark: function () {},
    measure: function () {},
    getEntriesByName: function () { return []; },
    getEntriesByType: function () { return []; },
    timeOrigin: Date.now()
  };

  globalObject.requestIdleCallback = function (fn) {
    return setTimeoutImpl(function () {
      fn({ didTimeout: false, timeRemaining: function () { return 16; } });
    }, 1);
  };
  globalObject.cancelIdleCallback = clearTimer;

  // ------------------------------------------------------ fragments/events

  function DocumentFragment() {
    Node.call(this, 11);
  }
  DocumentFragment.prototype = Object.create(Node.prototype);
  DocumentFragment.prototype.constructor = DocumentFragment;

  Document.prototype.createDocumentFragment = function () { return new DocumentFragment(); };
  Document.prototype.createEvent = function (type) {
    return {
      type: String(type || 'event'),
      initEvent: function (name) { this.type = String(name); },
      initCustomEvent: function (name) { this.type = String(name); },
      preventDefault: function () {},
      stopPropagation: function () {}
    };
  };
  Document.prototype.createRange = function () {
    return {
      selectNodeContents: function () {},
      setStart: function () {},
      setEnd: function () {},
      cloneContents: function () { return new DocumentFragment(); },
      createContextualFragment: function (html) {
        var frag = new DocumentFragment();
        var tree = parseFragment(html);
        (tree.children || []).forEach(function (child) { frag.appendChild(buildNode(child)); });
        return frag;
      }
    };
  };

  Object.defineProperty(Style.prototype, 'cssText', {
    get: function () { return this.__el._attrs.style || ''; },
    set: function (value) {
      this.__props = Object.create(null);
      String(value || '').split(';').forEach(function (part) {
        var bits = part.split(':');
        if (bits.length >= 2) {
          this.__props[bits[0].trim().toLowerCase()] = bits.slice(1).join(':').trim();
        }
      }, this);
      this.__el._attrs.style = String(value || '');
    }
  });

  Object.defineProperty(Node.prototype, 'isConnected', {
    get: function () {
      var node = this;
      while (node.parentNode) node = node.parentNode;
      return node.nodeType === DOCUMENT_NODE;
    }
  });

  globalObject.DocumentFragment = DocumentFragment;

  globalObject.__mb_errors = [];
  globalObject.__mb_scriptCount = 0;

  // Host entry points
  globalObject.__mb_build = function (json) {
    var tree = JSON.parse(json);
    BASE = tree.url || '';
    document.URL = BASE;

    var built = buildNode(tree);
    document.childNodes = [];
    (built.childNodes || []).forEach(function (child) {
      child.parentNode = document;
      document.childNodes.push(child);
    });

    var titleEl = query(document, 'title', true)[0];
    document.title = titleEl ? textOf(titleEl).replace(/\s+/g, ' ').trim() : '';
    document.readyState = 'interactive';
    return true;
  };

  // Script context: Cloudflare's beacon reads document.currentScript and
  // document.location, both of which were missing and threw on .href.
  document.currentScript = null;
  document.location = globalObject.location;
  document.referrer = '';
  try {
    Object.defineProperty(document, 'baseURI', {
      configurable: true,
      get: function () { return document.URL; }
    });
  } catch (e) { /* non-configurable in this engine */ }

  globalObject.__mb_set_current_script = function (src) {
    if (!src) {
      document.currentScript = null;
      return true;
    }
    var el = null;
    try {
      el = document.querySelector('script[src="' + String(src) + '"]');
    } catch (e) {
      el = null;
    }
    document.currentScript = el || null;
    return true;
  };

  globalObject.__mb_run_timers = runTimers;
  globalObject.__mb_serialize = serialize;

  globalObject.__mb_ready = function () {
    document.readyState = 'complete';
    fire(document, 'DOMContentLoaded', null);
    globalObject.dispatchEvent({ type: 'DOMContentLoaded' });
    globalObject.dispatchEvent({ type: 'load' });
    return true;
  };

  globalObject.__mb_click = function (id) {
    var el = nodes[Number(id)];
    if (!el || el.nodeType !== ELEMENT_NODE) return false;
    fire(el, 'click', null);
    return true;
  };

  // Resolve a selector or node id, click it, and submit its form if it is a
  // submit control. Returns a short status string for the terminal.
  globalObject.__mb_click_selector = function (selector) {
    var raw = String(selector);
    var el = null;

    if (/^\d+$/.test(raw)) {
      el = nodes[Number(raw)];
    } else {
      el = globalThis.document.getElementById(raw);
      if (!el) {
        var found = query(globalThis.document, raw, true);
        el = found[0] || null;
      }
    }

    if (!el || el.nodeType !== ELEMENT_NODE) return 'not-found';

    fire(el, 'click', null);

    var tag = (el.localName || '').toLowerCase();
    var type = (el.getAttribute('type') || '').toLowerCase();
    var isSubmit = (tag === 'button' && type !== 'button' && type !== 'reset') ||
                   (tag === 'input' && (type === 'submit' || type === 'image'));

    if (isSubmit) {
      var form = null;
      try {
        form = el.closest('form');
      } catch (e) {
        form = null;
      }
      if (form) {
        fire(form, 'submit', null);
        return 'clicked+submitted';
      }
    }

    return 'clicked';
  };


  // ------------------------------------------------------------- encoding
  // Pages assume these exist. Google's sign-in page calls atob() while booting,
  // and a missing atob aborts the entire inline script.

  function atobImpl(input) {
    var raw = String(input).replace(/[\t\n\f\r ]/g, '');
    var table = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    var body = raw.replace(/=+$/, '');
    var out = '';
    var acc = 0;
    var bits = 0;
    for (var i = 0; i < body.length; i++) {
      var idx = table.indexOf(body.charAt(i));
      if (idx === -1) {
        throw new Error("Failed to execute 'atob': The string to be decoded is not correctly encoded.");
      }
      acc = (acc << 6) | idx;
      bits += 6;
      if (bits >= 8) {
        bits -= 8;
        out += String.fromCharCode((acc >> bits) & 0xff);
      }
    }
    return out;
  }

  function btoaImpl(input) {
    var str = String(input);
    var table = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    var out = '';
    for (var i = 0; i < str.length; i += 3) {
      var b1 = str.charCodeAt(i);
      var b2 = str.charCodeAt(i + 1);
      var b3 = str.charCodeAt(i + 2);
      if (b1 > 255 || b2 > 255 || b3 > 255) {
        throw new Error("Failed to execute 'btoa': The string to be encoded contains characters outside of the Latin1 range.");
      }
      var has2 = !isNaN(b2);
      var has3 = !isNaN(b3);
      out += table.charAt(b1 >> 2);
      out += table.charAt(((b1 & 3) << 4) | (has2 ? b2 >> 4 : 0));
      out += has2 ? table.charAt(((b2 & 15) << 2) | (has3 ? b3 >> 6 : 0)) : '=';
      out += has3 ? table.charAt(b3 & 63) : '=';
    }
    return out;
  }

  function TextEncoderShim() {}
  TextEncoderShim.prototype.encoding = 'utf-8';
  TextEncoderShim.prototype.encode = function (value) {
    var str = String(value === undefined ? '' : value);
    var bytes = [];
    for (var i = 0; i < str.length; i++) {
      var c = str.charCodeAt(i);
      if (c < 0x80) {
        bytes.push(c);
      } else if (c < 0x800) {
        bytes.push(0xc0 | (c >> 6), 0x80 | (c & 63));
      } else if (c >= 0xd800 && c <= 0xdbff && i + 1 < str.length) {
        var low = str.charCodeAt(++i);
        var cp = 0x10000 + ((c - 0xd800) << 10) + (low - 0xdc00);
        bytes.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 63), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
      } else {
        bytes.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
      }
    }
    return new Uint8Array(bytes);
  };

  function TextDecoderShim(label) {
    this.encoding = String(label || 'utf-8').toLowerCase();
  }
  TextDecoderShim.prototype.decode = function (buffer) {
    var bytes = buffer && buffer.length !== undefined ? Array.prototype.slice.call(buffer) : [];
    var out = '';
    for (var i = 0; i < bytes.length; ) {
      var b = bytes[i++];
      if (b < 0x80) {
        out += String.fromCharCode(b);
      } else if (b >= 0xc0 && b < 0xe0) {
        out += String.fromCharCode(((b & 31) << 6) | (bytes[i++] & 63));
      } else if (b >= 0xe0 && b < 0xf0) {
        out += String.fromCharCode(((b & 15) << 12) | ((bytes[i++] & 63) << 6) | (bytes[i++] & 63));
      } else {
        var cp = ((b & 7) << 18) | ((bytes[i++] & 63) << 12) | ((bytes[i++] & 63) << 6) | (bytes[i++] & 63);
        cp -= 0x10000;
        out += String.fromCharCode(0xd800 + (cp >> 10), 0xdc00 + (cp & 1023));
      }
    }
    return out;
  };

  function URLSearchParamsShim(init) {
    this._pairs = [];
    var self = this;
    if (typeof init === 'string') {
      String(init).replace(/^\?/, '').split('&').forEach(function (pair) {
        if (!pair) return;
        var cut = pair.indexOf('=');
        var key = cut < 0 ? pair : pair.slice(0, cut);
        var val = cut < 0 ? '' : pair.slice(cut + 1);
        self._pairs.push([decodeURIComponent(key.replace(/\+/g, ' ')), decodeURIComponent(val.replace(/\+/g, ' '))]);
      });
    } else if (init && typeof init === 'object') {
      Object.keys(init).forEach(function (key) {
        self._pairs.push([String(key), String(init[key])]);
      });
    }
  }
  URLSearchParamsShim.prototype.append = function (k, v) { this._pairs.push([String(k), String(v)]); };
  URLSearchParamsShim.prototype.get = function (k) {
    for (var i = 0; i < this._pairs.length; i++) if (this._pairs[i][0] === String(k)) return this._pairs[i][1];
    return null;
  };
  URLSearchParamsShim.prototype.getAll = function (k) {
    return this._pairs.filter(function (p) { return p[0] === String(k); }).map(function (p) { return p[1]; });
  };
  URLSearchParamsShim.prototype.has = function (k) { return this.get(k) !== null; };
  URLSearchParamsShim.prototype.set = function (k, v) {
    var seen = false;
    this._pairs = this._pairs.filter(function (p) {
      if (p[0] !== String(k)) return true;
      if (!seen) { seen = true; p[1] = String(v); return true; }
      return false;
    });
    if (!seen) this._pairs.push([String(k), String(v)]);
  };
  URLSearchParamsShim.prototype.toString = function () {
    return this._pairs.map(function (p) {
      return encodeURIComponent(p[0]) + '=' + encodeURIComponent(p[1]);
    }).join('&');
  };

  globalObject.atob = atobImpl;
  globalObject.btoa = btoaImpl;
  globalObject.TextEncoder = TextEncoderShim;
  globalObject.TextDecoder = TextDecoderShim;
  globalObject.URLSearchParams = URLSearchParamsShim;

  // ---------------------------------------------------------- constructors
  // React and friends test nodes with instanceof. The real prototype chain
  // already covers Node/Element/Text, but the named HTML types were absent, so
  // "x instanceof HTMLElement" threw. These predicates make the names real
  // without touching the object model.
  function defineConstructor(name, test) {
    if (globalObject[name]) return;
    var C = function () {};
    try {
      Object.defineProperty(C, Symbol.hasInstance, {
        value: function (obj) {
          try {
            return Boolean(test(obj));
          } catch (e) {
            return false;
          }
        }
      });
    } catch (e) {
      // engine without Symbol.hasInstance: leave the name as a plain function
    }
    globalObject[name] = C;
  }

  var isElementNode = function (o) { return Boolean(o) && o.nodeType === ELEMENT_NODE && Boolean(o.tagName); };
  var isEventLike = function (o) {
    return Boolean(o) && typeof o.type === 'string' && typeof o.preventDefault === 'function';
  };

  defineConstructor('HTMLElement', isElementNode);
  defineConstructor('HTMLDivElement', function (o) { return isElementNode(o) && o.tagName === 'DIV'; });
  defineConstructor('HTMLSpanElement', function (o) { return isElementNode(o) && o.tagName === 'SPAN'; });
  defineConstructor('HTMLInputElement', function (o) { return isElementNode(o) && o.tagName === 'INPUT'; });
  defineConstructor('HTMLTextAreaElement', function (o) { return isElementNode(o) && o.tagName === 'TEXTAREA'; });
  defineConstructor('HTMLSelectElement', function (o) { return isElementNode(o) && o.tagName === 'SELECT'; });
  defineConstructor('HTMLButtonElement', function (o) { return isElementNode(o) && o.tagName === 'BUTTON'; });
  defineConstructor('HTMLAnchorElement', function (o) { return isElementNode(o) && o.tagName === 'A'; });
  defineConstructor('HTMLFormElement', function (o) { return isElementNode(o) && o.tagName === 'FORM'; });
  defineConstructor('HTMLBodyElement', function (o) { return isElementNode(o) && o.tagName === 'BODY'; });
  defineConstructor('HTMLHeadElement', function (o) { return isElementNode(o) && o.tagName === 'HEAD'; });
  defineConstructor('HTMLHtmlElement', function (o) { return isElementNode(o) && o.tagName === 'HTML'; });
  defineConstructor('HTMLIFrameElement', function (o) { return isElementNode(o) && o.tagName === 'IFRAME'; });
  defineConstructor('HTMLImageElement', function (o) { return isElementNode(o) && o.tagName === 'IMG'; });
  defineConstructor('HTMLParagraphElement', function (o) { return isElementNode(o) && o.tagName === 'P'; });
  defineConstructor('HTMLHeadingElement', function (o) {
    return isElementNode(o) && ['H1', 'H2', 'H3', 'H4', 'H5', 'H6'].indexOf(o.tagName) !== -1;
  });
  defineConstructor('HTMLUListElement', function (o) { return isElementNode(o) && o.tagName === 'UL'; });
  defineConstructor('HTMLOListElement', function (o) { return isElementNode(o) && o.tagName === 'OL'; });
  defineConstructor('HTMLLIElement', function (o) { return isElementNode(o) && o.tagName === 'LI'; });
  defineConstructor('HTMLLabelElement', function (o) { return isElementNode(o) && o.tagName === 'LABEL'; });
  defineConstructor('HTMLOptionElement', function (o) { return isElementNode(o) && o.tagName === 'OPTION'; });
  defineConstructor('HTMLTableElement', function (o) { return isElementNode(o) && o.tagName === 'TABLE'; });
  defineConstructor('HTMLTemplateElement', function (o) { return isElementNode(o) && o.tagName === 'TEMPLATE'; });
  defineConstructor('HTMLCanvasElement', function (o) { return isElementNode(o) && o.tagName === 'CANVAS'; });
  defineConstructor('HTMLLinkElement', function (o) { return isElementNode(o) && o.tagName === 'LINK'; });
  defineConstructor('HTMLMetaElement', function (o) { return isElementNode(o) && o.tagName === 'META'; });
  defineConstructor('HTMLScriptElement', function (o) { return isElementNode(o) && o.tagName === 'SCRIPT'; });
  defineConstructor('HTMLStyleElement', function (o) { return isElementNode(o) && o.tagName === 'STYLE'; });
  defineConstructor('SVGElement', function (o) { return isElementNode(o) && /^svg/i.test(String(o.namespaceURI || '')); });
  defineConstructor('Comment', function (o) { return Boolean(o) && o.nodeType === 8; });
  defineConstructor('DocumentType', function (o) { return Boolean(o) && o.nodeType === 10; });
  defineConstructor('Attr', function (o) { return Boolean(o) && o.nodeType === 2; });
  defineConstructor('NodeList', function (o) { return Array.isArray(o) || (Boolean(o) && typeof o.length === 'number' && typeof o.item === 'function'); });
  defineConstructor('HTMLCollection', function (o) { return Array.isArray(o) || (Boolean(o) && typeof o.length === 'number'); });
  defineConstructor('Document', function (o) { return Boolean(o) && o.nodeType === 9; });
  defineConstructor('Window', function (o) { return o === globalObject; });
  defineConstructor('Location', function (o) { return Boolean(o) && o === globalObject.location; });
  defineConstructor('History', function (o) { return Boolean(o) && o === globalObject.history; });
  defineConstructor('Navigator', function (o) { return Boolean(o) && o === globalObject.navigator; });
  defineConstructor('Event', isEventLike);
  defineConstructor('MouseEvent', isEventLike);
  defineConstructor('CustomEvent', function (o) { return isEventLike(o) && 'detail' in o; });
  defineConstructor('CSSStyleDeclaration', function (o) {
    return Boolean(o) && typeof o === 'object' &&
      (typeof o.setProperty === 'function' || typeof o.getPropertyValue === 'function' || typeof o.cssText === 'string');
  });

  // ---------------------------------------------------------------- fields
  // Tappable form fields. The renderer numbers fields in document order, so
  // these must enumerate the same way: node creation order is DOM order.
  var NON_TEXT_INPUT = ['hidden', 'submit', 'button', 'reset', 'image', 'checkbox', 'radio', 'file'];

  function focusableFields() {
    var found = [];
    var seen = {};

    function add(el) {
      if (!el || seen[el.__id]) return;
      seen[el.__id] = true;
      found.push(el);
    }

    ['input', 'textarea', 'select'].forEach(function (tag) {
      Array.prototype.slice.call(document.querySelectorAll(tag)).forEach(function (el) {
        if (tag === 'input') {
          var type = String(el.getAttribute('type') || 'text').toLowerCase();
          if (['hidden', 'submit', 'button', 'reset', 'image', 'file'].indexOf(type) !== -1) return;
        }
        if (isHiddenField(el)) return;
        add(el);
      });
    });

    // contenteditable is how modern chat boxes and editors are built
    Array.prototype.slice.call(document.querySelectorAll('[contenteditable]')).forEach(function (el) {
      var mode = String(el.getAttribute('contenteditable') || '').toLowerCase();
      if (mode === 'false') return;
      if (isHiddenField(el)) return;
      add(el);
    });

    found.sort(function (a, b) { return (a.__id || 0) - (b.__id || 0); });
    return found;
  }

  function isHiddenField(el) {
    if (!el) return true;
    if (el.getAttribute && el.getAttribute('hidden') !== null && el.getAttribute('hidden') !== undefined) return true;
    var style = el.style;
    if (style) {
      var display = String(style.display || '').toLowerCase();
      var visibility = String(style.visibility || '').toLowerCase();
      if (display === 'none' || visibility === 'hidden') return true;
    }
    return false;
  }

  // Readable label: aria-label, then an associated <label>, then placeholder,
  // then name, then the control type. This is what turns [hiddenPassword]
  // into something a person can recognise.
  function fieldLabel(el, tag) {
    var aria = el.getAttribute && el.getAttribute('aria-label');
    if (aria) return String(aria);

    try {
      var id = el.getAttribute && el.getAttribute('id');
      if (id) {
        var labelled = document.querySelector('label[for="' + id + '"]');
        if (labelled) {
          var t = String(labelled.textContent || '').replace(/\s+/g, ' ').trim();
          if (t) return t;
        }
      }
      var parent = el.parentNode;
      for (var depth = 0; parent && depth < 3; depth++) {
        if (parent.tagName === 'LABEL') {
          var lt = String(parent.textContent || '').replace(/\s+/g, ' ').trim();
          if (lt) return lt;
        }
        parent = parent.parentNode;
      }
    } catch (e) { /* label lookup is best effort */ }

    var placeholder = el.getAttribute && el.getAttribute('placeholder');
    if (placeholder) return String(placeholder);
    var name = el.getAttribute && el.getAttribute('name');
    if (name) return String(name);
    if (el.getAttribute && el.getAttribute('contenteditable') !== null && el.getAttribute('contenteditable') !== undefined) {
      return 'editable text';
    }
    return tag === 'select' ? 'select' : 'text';
  }

  function fieldInfo(el, index) {
    var tag = String(el.tagName || '').toLowerCase();
    var type = String(el.getAttribute('type') || (tag === 'textarea' ? 'textarea' : 'text')).toLowerCase();
    var editable = el.getAttribute && el.getAttribute('contenteditable') !== null &&
      el.getAttribute('contenteditable') !== undefined;
    if (editable) type = 'contenteditable';

    var value;
    if (editable) value = String(el.textContent || '');
    else if (type === 'checkbox' || type === 'radio') value = el.checked ? 'checked' : 'unchecked';
    else if (tag === 'select') value = String(el.value || '');
    else value = el.value === undefined || el.value === null ? '' : String(el.value);

    var options = [];
    if (tag === 'select') {
      Array.prototype.slice.call(document.querySelectorAll('option')).forEach(function () {});
      try {
        var kids = el.childNodes || [];
        for (var i = 0; i < kids.length; i++) {
          var kid = kids[i];
          if (kid && String(kid.tagName || '').toLowerCase() === 'option') {
            options.push(String(kid.textContent || '').replace(/\s+/g, ' ').trim());
          }
        }
      } catch (e) { /* options are best effort */ }
    }

    return {
      index: index,
      tag: tag,
      type: type,
      name: String(el.getAttribute('name') || el.getAttribute('id') || ''),
      label: fieldLabel(el, tag),
      placeholder: String(el.getAttribute('placeholder') || ''),
      value: value,
      checked: Boolean(el.checked),
      options: options
    };
  }

  function setFieldValue(el, next) {
    var tag = String(el.tagName || '').toLowerCase();
    var type = String(el.getAttribute('type') || '').toLowerCase();
    var editable = el.getAttribute && el.getAttribute('contenteditable') !== null &&
      el.getAttribute('contenteditable') !== undefined;

    if (editable) {
      el.textContent = String(next);
      fire(el, 'input', null);
      fire(el, 'change', null);
      return;
    }

    if (tag === 'select') {
      var kids = el.childNodes || [];
      var wanted = String(next);
      for (var i = 0; i < kids.length; i++) {
        var kid = kids[i];
        if (kid && String(kid.tagName || '').toLowerCase() === 'option') {
          var label = String(kid.textContent || '').replace(/\s+/g, ' ').trim();
          if (label === wanted || String(kid.getAttribute('value') || '') === wanted) {
            el.value = String(kid.getAttribute('value') || label);
            if (kid.setAttribute) kid.setAttribute('selected', 'selected');
          }
        }
      }
      fire(el, 'input', null);
      fire(el, 'change', null);
      return;
    }

    el.value = String(next);
    el.setAttribute('value', String(next));
    fire(el, 'input', null);
    fire(el, 'change', null);
  }

  globalObject.__mb_fields = function () {
    var list = focusableFields().map(fieldInfo);
    return JSON.stringify(list);
  };

  globalObject.__mb_focus_field = function (index) {
    var el = focusableFields()[Number(index)];
    if (!el) return JSON.stringify({ ok: false });
    el.focus();
    return JSON.stringify({ ok: true, field: fieldInfo(el, Number(index)) });
  };

  globalObject.__mb_active_field = function () {
    var fields = focusableFields();
    var at = fields.indexOf(focusedNode);
    return at === -1 ? 'null' : String(at);
  };

  globalObject.__mb_field_append = function (index, text) {
    var el = focusableFields()[Number(index)];
    if (!el) return JSON.stringify({ ok: false });
    setFieldValue(el, String(el.value || '') + String(text));
    return JSON.stringify({ ok: true, value: String(el.value) });
  };

  globalObject.__mb_field_backspace = function (index) {
    var el = focusableFields()[Number(index)];
    if (!el) return JSON.stringify({ ok: false });
    var current = String(el.value || '');
    setFieldValue(el, current.slice(0, -1));
    return JSON.stringify({ ok: true, value: String(el.value) });
  };

  globalObject.__mb_field_set = function (index, text) {
    var el = focusableFields()[Number(index)];
    if (!el) return JSON.stringify({ ok: false });
    setFieldValue(el, String(text));
    return JSON.stringify({ ok: true, value: String(el.value) });
  };

  globalObject.__mb_field_toggle = function (index) {
    var el = focusableFields()[Number(index)];
    if (!el) return JSON.stringify({ ok: false });
    el.checked = !el.checked;
    if (el.checked && String(el.getAttribute('type') || '').toLowerCase() === 'radio') {
      var name = el.getAttribute('name');
      if (name) {
        Array.prototype.slice.call(document.querySelectorAll('input')).forEach(function (other) {
          if (other !== el && String(other.getAttribute('type') || '').toLowerCase() === 'radio' &&
              other.getAttribute('name') === name) {
            other.checked = false;
          }
        });
      }
    }
    fire(el, 'input', null);
    fire(el, 'change', null);
    return JSON.stringify({ ok: true, checked: Boolean(el.checked) });
  };

  globalObject.__mb_field_cycle = function (index, direction) {
    var el = focusableFields()[Number(index)];
    if (!el) return JSON.stringify({ ok: false });
    if (String(el.tagName || '').toLowerCase() !== 'select') return JSON.stringify({ ok: false, reason: 'not a select' });

    var labels = [];
    var kids = el.childNodes || [];
    for (var i = 0; i < kids.length; i++) {
      if (kids[i] && String(kids[i].tagName || '').toLowerCase() === 'option') {
        labels.push(String(kids[i].textContent || '').replace(/\s+/g, ' ').trim());
      }
    }
    if (!labels.length) return JSON.stringify({ ok: false, reason: 'no options' });

    var current = labels.indexOf(String(el.value || ''));
    if (current === -1) current = 0;
    var step = Number(direction) < 0 ? -1 : 1;
    var next = (current + step + labels.length) % labels.length;
    setFieldValue(el, labels[next]);
    return JSON.stringify({ ok: true, value: labels[next], index: next, total: labels.length });
  };

  globalObject.__mb_field_submit = function (index) {
    var el = focusableFields()[Number(index)];
    if (!el) return JSON.stringify({ ok: false, reason: 'no such field' });

    var form = null;
    try {
      form = el.closest('form');
    } catch (e) {
      form = null;
    }

    if (form) {
      if (typeof form.requestSubmit === 'function') form.requestSubmit();
      else fire(form, 'submit', null);
      return JSON.stringify({ ok: true, via: 'form' });
    }

    // No form: click the nearest submit control, which is what a user would do.
    var buttons = query(document, 'button', true).concat(query(document, 'input', true));
    for (var i = 0; i < buttons.length; i++) {
      var type = String(buttons[i].getAttribute('type') || '').toLowerCase();
      var tag = String(buttons[i].tagName || '').toLowerCase();
      var isSubmit = (tag === 'button' && type !== 'button' && type !== 'reset') ||
        (tag === 'input' && (type === 'submit' || type === 'image'));
      if (isSubmit) {
        fire(buttons[i], 'click', null);
        return JSON.stringify({ ok: true, via: 'button' });
      }
    }

    return JSON.stringify({ ok: false, reason: 'no form or submit button' });
  };

  globalObject.__mb_record_error = function (message) {
    globalObject.__mb_errors.push(String(message));
  };
})();
