'use strict';

// MAXBROWSER — page session
// Loads a parsed tree into the QuickJS sandbox, executes the page's scripts,
// drains timers/promises, then reads the resulting document back out.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const { JsRuntime } = require('./quickjs');
const { parseHTML, walk, toPlain } = require('../parser/html');
const { safeFetch } = require('../network/safe-fetch');

const BOOTSTRAP_PATH = path.join(__dirname, 'dom-bootstrap.js');

const JS_TYPES = new Set([
  '', 'text/javascript', 'application/javascript', 'application/x-javascript',
  'text/ecmascript', 'application/ecmascript', 'module'
]);


// A production bundle is often shipped as type="module" while being a single
// self-contained script. Only reject code that really needs an ESM loader.
function hasEsmSyntax(code) {
  if (/\bimport\s*\.\s*meta\b/.test(code)) return true;
  if (/(^|[;{}])\s*import\s*\(/.test(code)) return true;
  if (/(^|[;{}])\s*import\s+[\w{*'"]/.test(code)) return true;
  if (/(^|[;{}])\s*export\s+(default|const|let|var|function|class|\{|\*)/.test(code)) return true;
  return false;
}

class PageSession {
  constructor(options = {}) {
    this.options = {
      timeoutMs: options.timeoutMs || 4000,
      scriptTimeoutMs: options.scriptTimeoutMs || 3000,
      maxRounds: options.maxRounds || 25,
      maxScripts: options.maxScripts || 80,
      runScripts: options.runScripts !== false,
      loadExternalScripts: options.loadExternalScripts !== false,
      memoryLimit: options.memoryLimit || 64 * 1024 * 1024
    };

    this.runtime = null;
    this.baseUrl = '';
    this.pending = [];
    this.logs = [];
    this.scriptErrors = [];
    this.scriptsRun = 0;
    this.scriptsSkipped = 0;
    this.bootstrap = null;
  }

  async open(html, url) {
    this.baseUrl = url || '';

    this.runtime = new JsRuntime({
      memoryLimit: this.options.memoryLimit,
      timeoutMs: this.options.timeoutMs
    });

    await this.runtime.init();
    this._installBridges();
    await this._loadBootstrap();

    const tree = parseHTML(html, this.baseUrl);
    this._injectTree(tree);

    if (this.options.runScripts) await this._runScripts(tree);

    await this._drain();
    await this.runtime.eval('__mb_ready()');
    await this._drain();

    return this.serialize();
  }

  // ------------------------------------------------------------- bridges

  _installBridges() {
    const rt = this.runtime;

    rt.defineHostFunction('__mb_parse', html => {
      return JSON.stringify(toPlain(parseHTML(String(html), this.baseUrl)));
    });

    rt.defineHostFunction('__mb_resolve', input => {
      const raw = String(input);
      const at = raw.indexOf(' ');

      try {
        if (at > 0) {
          return new URL(raw.slice(at + 1), raw.slice(0, at)).href;
        }
        return new URL(raw, this.baseUrl || undefined).href;
      } catch {
        return raw;
      }
    });

    rt.defineHostRaw('__mb_log', (vm, args) => {
      const level = args.length ? vm.dump(args[0]) : 'log';
      const text = args.slice(1).map(a => vm.dump(a)).join(' ');
      this.logs.push({ level: String(level), text: String(text) });
      if (this.logs.length > 400) this.logs.shift();
      return undefined;
    });

    rt.defineHostFunction('__mb_random', length => {
      const size = Math.max(0, Math.min(1024, Number(length) || 0));
      return crypto.randomBytes(size).toString('latin1');
    });

    rt.defineHostRaw('__mb_fetch', (vm, args) => {
      const url = vm.dump(args[0]);
      const method = vm.dump(args[1]);
      const body = vm.dump(args[2]);

      const deferred = vm.newPromise();
      this.pending.push({ url: String(url), method: String(method || 'GET'), body: String(body || ''), deferred });

      return deferred.handle;
    });
  }

  async _loadBootstrap() {
    if (!this.bootstrap) this.bootstrap = fs.readFileSync(BOOTSTRAP_PATH, 'utf8');

    const result = await this.runtime.eval(this.bootstrap, {
      filename: 'maxbrowser:dom-bootstrap.js',
      timeoutMs: 8000
    });

    if (!result.ok) {
      throw new Error('DOM bootstrap failed: ' + result.error);
    }
  }

  _injectTree(tree) {
    const json = JSON.stringify(toPlain(tree));
    const result = this._evalSync('__mb_build(' + JSON.stringify(json) + ')');

    if (!result.ok) {
      throw new Error('DOM build failed: ' + result.error);
    }
  }

  // Small synchronous helper for internal calls.
  _evalSync(code, timeoutMs = 5000) {
    const vm = this.runtime.vm;
    if (!vm) return { ok: false, error: 'runtime not ready' };

    const deadline = Date.now() + timeoutMs;
    this.runtime.runtime.setInterruptHandler(() => Date.now() > deadline);

    try {
      const res = vm.evalCode(code, 'maxbrowser:internal');
      if (res.error) {
        const message = this.runtime._dumpError(res.error);
        res.error.dispose();
        return { ok: false, error: message };
      }
      const value = this.runtime._safeDump(res.value);
      res.value.dispose();
      return { ok: true, value };
    } catch (error) {
      return { ok: false, error: error.message };
    } finally {
      try { this.runtime.runtime.setInterruptHandler(() => false); } catch { /* dead */ }
    }
  }

  // ------------------------------------------------------------- scripts

  _collectScripts(tree) {
    const found = [];

    walk(tree, node => {
      if (node.type !== 'element' || node.tag !== 'script') return;

      const type = String(node.attrs.type || '').trim().toLowerCase();
      const src = node.attrs.src || '';
      const inline = (node.children || [])
        .map(child => (child.type === 'text' ? child.data : ''))
        .join('');

      found.push({ type, src, inline, isModule: type === 'module' });
    });

    return found;
  }

  async _runScripts(tree) {
    const scripts = this._collectScripts(tree).slice(0, this.options.maxScripts);

    for (const script of scripts) {
      let code = '';

      if (script.src) {
        if (!this.options.loadExternalScripts) {
          this.scriptsSkipped++;
          continue;
        }

        let absolute;
        try {
          absolute = new URL(script.src, this.baseUrl).href;
        } catch {
          this.scriptsSkipped++;
          continue;
        }

        try {
          const response = await safeFetch(absolute, { timeoutMs: 10000, maxBytes: 4 * 1024 * 1024 });
          if (response.status < 200 || response.status >= 300) {
            this.scriptErrors.push(script.src + ' -> HTTP ' + response.status);
            continue;
          }
          code = response.body;
        } catch (error) {
          this.scriptErrors.push(script.src + ' -> ' + error.message);
          continue;
        }
      } else {
        code = script.inline;
      }

      if (!code || !code.trim()) {
        this.scriptsSkipped++;
        continue;
      }

      if (script.isModule && hasEsmSyntax(code)) {
        // Needs a real module loader (import/export). Not implemented yet.
        this.scriptErrors.push((script.src || 'inline module') + ' -> ES module imports not supported yet');
        this.scriptsSkipped++;
        continue;
      }

      if (!JS_TYPES.has(script.type) && script.type !== 'module') {
        this.scriptsSkipped++;
        continue;
      }

      const label = script.src || 'inline-script-' + (this.scriptsRun + 1);
      const result = await this.runtime.eval(code, {
        filename: 'maxbrowser:' + label,
        timeoutMs: this.options.scriptTimeoutMs
      });

      this.scriptsRun++;

      // A page's own render is usually scheduled, not synchronous. Drain the
      // timers before moving on, otherwise a React app queues its first render
      // and never runs it during load.
      this._pumpTimers();

      if (!result.ok) {
        this.scriptErrors.push(label + ' -> ' + String(result.error).split('\n')[0]);
        if (this.scriptErrors.length > 40) break;
      }

      // Let promise chains and zero-delay timers settle between scripts.
      await this._drain(3);
    }
  }

  // --------------------------------------------------------------- drain

  _pumpTimers() {
    for (let round = 0; round < 3; round++) {
      try {
        const outcome = this._evalSync('typeof __mb_run_timers === "function" ? __mb_run_timers(150) : 0', 6000);
        if (outcome && outcome.ok === false) return String(outcome.error || 'timer failed');
      } catch (error) {
        return error.message;
      }
    }
    return null;
  }

  async _drain(maxRounds = this.options.maxRounds) {
    for (let round = 0; round < maxRounds; round++) {
      let progressed = false;

      const timers = await this.runtime.eval('__mb_run_timers()', { timeoutMs: 2000 });
      if (timers.ok && Number(timers.value) > 0) progressed = true;

      if (this.pending.length) {
        progressed = true;
        const batch = this.pending.splice(0);

        await Promise.all(batch.map(async item => {
          let payload;
          try {
            const response = await safeFetch(item.url, { method: item.method, body: item.body });
            payload = response;
          } catch (error) {
            payload = {
              url: item.url,
              status: 0,
              statusText: 'blocked',
              headers: {},
              body: '',
              error: error.message
            };
          }

          try {
            item.deferred.resolve(this.runtime.vm.newString(JSON.stringify(payload)));
          } catch {
            // promise already settled or runtime torn down
          }
        }));
      }

      const jobs = this.runtime.runJobs();
      if (jobs > 0) progressed = true;
      if (jobs < 0) break;

      if (!progressed) break;
    }
  }

  // ------------------------------------------------------------ read back

  serialize() {
    const result = this._evalSync('__mb_serialize(20000)', 6000);

    if (!result.ok) {
      return {
        title: '',
        url: this.baseUrl,
        text: '',
        html: '',
        links: [],
        errors: [result.error],
        logs: this.logs
      };
    }

    let payload;
    try {
      payload = JSON.parse(result.value);
    } catch {
      payload = { title: '', url: this.baseUrl, text: String(result.value), html: '', links: [] };
    }

    payload.errors = [...(payload.errors || []), ...this.scriptErrors].slice(0, 30);
    payload.logs = this.logs.slice(-60);
    payload.scriptsRun = this.scriptsRun;
    payload.scriptsSkipped = this.scriptsSkipped;

    return payload;
  }

  click(selector) {
    const raw = String(selector).replace(/[\\'\n\r]/g, '');
    return this._evalSync("__mb_click_selector('" + raw + "')");
  }

  // Drain queued timers. React 18 schedules renders through the scheduler,
  // which falls back to setTimeout here because MessageChannel is absent, so
  // without this the render is queued and never runs.
  _pumpTimers() {
    try {
      const outcome = this._evalSync('typeof __mb_run_timers === "function" ? __mb_run_timers(150) : 0', 6000);
      if (outcome && outcome.ok === false) return String(outcome.error || 'timer failed');
      return null;
    } catch (error) {
      // a page that loops in a timer must not take the terminal with it
      return error.message;
    }
  }

  run(code) {
    const result = this._evalSync(String(code), 8000);
    const pumpError = this._pumpTimers();
    if (pumpError) {
      if (!Array.isArray(result.errors)) result.errors = [];
      result.errors.push('timer: ' + pumpError);
    }
    return result;
  }

  dispose() {
    if (this.runtime) this.runtime.dispose();
    this.runtime = null;
  }
}

module.exports = { PageSession };
