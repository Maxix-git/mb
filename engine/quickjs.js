'use strict';

// MAXBROWSER — sandboxed JavaScript runtime
// QuickJS executes page JavaScript only. It provides no DOM, CSS or rendering.
// Page code gets no access to Node, Termux files, shell or the network.

const { getQuickJS } = require('quickjs-emscripten');

const DEFAULTS = {
  memoryLimit: 64 * 1024 * 1024,
  maxStackSize: 512 * 1024,
  timeoutMs: 4000,
  maxLogs: 400
};

class JsRuntime {
  constructor(options = {}) {
    this.options = { ...DEFAULTS, ...options };
    this.module = null;
    this.runtime = null;
    this.vm = null;
    this.poisoned = false;
    this.logs = [];
  }

  async init() {
    if (!this.module) this.module = await getQuickJS();
    if (!this.vm) this._create();
    return this;
  }

  _create() {
    this._teardown();

    const runtime = this.module.newRuntime();
    runtime.setMemoryLimit(this.options.memoryLimit);
    runtime.setMaxStackSize(this.options.maxStackSize);

    this.runtime = runtime;
    this.vm = runtime.newContext();
    this.poisoned = false;
    this.logs = [];

    this._installConsole();
  }

  _safeDump(handle) {
    try {
      return this.vm.dump(handle);
    } catch {
      return '[unreadable]';
    }
  }


  _dumpError(handle) {
    try {
      const message = this.vm.getProp(handle, 'message');
      const text = this.vm.dump(message);
      message.dispose();
      if (text) return String(text);
    } catch {
      // fall through to generic dump
    }

    const generic = this._safeDump(handle);
    return typeof generic === 'string' ? generic : JSON.stringify(generic);
  }

  _installConsole() {
    const vm = this.vm;
    const global = vm.unwrapResult(vm.evalCode('globalThis'));
    const consoleHandle = vm.newObject();

    const push = (level, args) => {
      const text = args.map(a => this._safeDump(a)).join(' ');
      this.logs.push({ level, text });
      if (this.logs.length > this.options.maxLogs) this.logs.shift();
    };

    for (const level of ['log', 'info', 'warn', 'error', 'debug']) {
      const fn = vm.newFunction(level, (...args) => push(level, args));
      vm.setProp(consoleHandle, level, fn);
      fn.dispose();
    }

    vm.setProp(global, 'console', consoleHandle);
    consoleHandle.dispose();
    global.dispose();
  }

  // Expose a function to page code. Only primitives cross the boundary.
  defineHostFunction(name, impl) {
    const vm = this.vm;
    const global = vm.unwrapResult(vm.evalCode('globalThis'));

    const fn = vm.newFunction(name, (...args) => {
      const nativeArgs = args.map(a => this._safeDump(a));
      let out;
      try {
        out = impl(...nativeArgs);
      } catch (error) {
        return vm.newString(JSON.stringify({ error: error.message }));
      }
      if (out === undefined || out === null) return vm.undefined;
      return vm.newString(String(out));
    });

    vm.setProp(global, name, fn);
    fn.dispose();
    global.dispose();
  }

  // Escape hatch for bridges that must return a QuickJS handle (e.g. promises).
  // impl receives (vm, args) and must return a handle or undefined.
  defineHostRaw(name, impl) {
    const vm = this.vm;
    const global = vm.unwrapResult(vm.evalCode('globalThis'));

    const fn = vm.newFunction(name, (...args) => {
      const result = impl(vm, args);
      return result === undefined ? vm.undefined : result;
    });

    vm.setProp(global, name, fn);
    fn.dispose();
    global.dispose();
  }

  // Run pending promise jobs. Returns how many ran, or -1 if unusable.
  runJobs() {
    if (!this.runtime || this.poisoned) return -1;

    try {
      const outcome = this.runtime.executePendingJobs();
      if (outcome && typeof outcome.value === 'number') return outcome.value;
      return 0;
    } catch {
      this.poisoned = true;
      return -1;
    }
  }

  async eval(code, options = {}) {
    if (!this.vm) await this.init();
    if (this.poisoned) this._create();

    const timeoutMs = options.timeoutMs || this.options.timeoutMs;
    const deadline = Date.now() + timeoutMs;

    this.runtime.setInterruptHandler(() => Date.now() > deadline);

    let result;

    try {
      const res = this.vm.evalCode(code, options.filename || 'page.js');

      if (res.error) {
        const message = this._dumpError(res.error);
        try { res.error.dispose(); } catch { /* handle already released */ }
        if (/interrupt/i.test(message)) this.poisoned = true;
        result = { ok: false, error: message };
      } else {
        // A returned Promise can release its own handle during dump, so never
        // let handle bookkeeping turn a successful evaluation into an error.
        let value;
        try { value = this.vm.dump(res.value); } catch { value = undefined; }
        result = { ok: true, value };
        try { res.value.dispose(); } catch { /* handle already released */ }
      }
    } catch (error) {
      this.poisoned = true;
      result = { ok: false, error: error.message };
    } finally {
      try {
        this.runtime.setInterruptHandler(() => false);
      } catch {
        // runtime already unusable after an interrupt
      }
    }

    return result;
  }

  _teardown() {
    try { this.vm?.dispose(); } catch { /* already freed */ }
    try { this.runtime?.dispose(); } catch { /* already freed */ }
    this.vm = null;
    this.runtime = null;
  }

  dispose() {
    this._teardown();
    this.poisoned = false;
  }
}

module.exports = { JsRuntime };
