'use strict';

// MAXBROWSER — tab and navigation controller.
// Parses HTML into a DOM, executes page JavaScript inside QuickJS, then
// returns a serialized snapshot of the resulting document.

const { fetchPage } = require('../network/http');
const { parseHTML } = require('../parser/html');
const { PageSession } = require('./dom');

class Browser {
  runJS(code) {
    const tab = this.currentTab;
    const session = tab && (tab.session || tab.pageSession || tab.dom);
    if (!session) return { ok: false, error: 'no page loaded' };
    return session.run(code);
  }

  constructor(options = {}) {
    this.options = {
      runScripts: options.runScripts !== false,
      loadExternalScripts: options.loadExternalScripts !== false,
      scriptTimeoutMs: options.scriptTimeoutMs || 6000
    };

    this.tabs = [];
    this.activeTab = -1;
    this.nextId = 1;
  }

  newTab(parentTabId = null) {
    const tab = {
      id: this.nextId++,
      parentTabId,
      history: [],
      position: -1,
      page: null,
      session: null
    };

    this.tabs.push(tab);
    this.activeTab = this.tabs.length - 1;
    return tab;
  }

  get currentTab() {
    if (this.activeTab < 0) return this.newTab();
    return this.tabs[this.activeTab];
  }

  _dropSession(tab) {
    if (tab.session) {
      tab.session.dispose();
      tab.session = null;
    }
  }

  async load(url, record = true) {
    const tab = this.currentTab;

    this._dropSession(tab);

    const response = await fetchPage(url);

    const isHtml = /text\/html|application\/xhtml\+xml/i.test(response.contentType || '');

    let document;

    if (isHtml) {
      const session = new PageSession({
        runScripts: this.options.runScripts,
        loadExternalScripts: this.options.loadExternalScripts,
        timeoutMs: this.options.scriptTimeoutMs
      });

      const snapshot = await session.open(response.body, response.url);

      tab.session = session;
      document = {
        title: snapshot.title || response.url,
        text: snapshot.text || '',
        links: snapshot.links || [],
        html: snapshot.html || '',
        errors: snapshot.errors || [],
        logs: snapshot.logs || [],
        scriptsRun: snapshot.scriptsRun || 0,
        scriptsSkipped: snapshot.scriptsSkipped || 0
      };
    } else {
      document = {
        title: response.url,
        text: String(response.body || '').slice(0, 200000),
        links: [],
        html: '',
        errors: [],
        logs: [],
        scriptsRun: 0,
        scriptsSkipped: 0
      };
    }

    const page = {
      url: response.url,
      status: response.status,
      contentType: response.contentType,
      size: response.size,
      document
    };

    tab.page = page;

    if (record) {
      tab.history = tab.history.slice(0, tab.position + 1);
      tab.history.push(page.url);
      tab.position = tab.history.length - 1;
    }

    return page;
  }

  async navigate(url) {
    return this.load(url, true);
  }

  async openLink(index) {
    const tab = this.currentTab;
    const page = tab.page;
    if (!page) throw new Error('No page loaded');

    const link = (page.document.links || [])[Number(index) - 1];
    if (!link) throw new Error('No link ' + index);

    const child = this.newTab(tab.id);
    return this.load(link.url, true).then(() => child);
  }

  async click(selector) {
    const tab = this.currentTab;
    if (!tab.session) throw new Error('No live page to interact with');

    const result = tab.session.click(selector);
    if (!result.ok) throw new Error(String(result.error || 'click failed'));

    if (result.value === 'not-found') throw new Error('Element not found: ' + selector);

    tab.page.document = tab.session.serialize();
    return result.value;
  }

  runScript(code) {
    const tab = this.currentTab;
    if (!tab.session) throw new Error('No live page to run script against');

    const result = tab.session.run(code);
    if (!result.ok) throw new Error(String(result.error || 'script failed'));

    tab.page.document = tab.session.serialize();
    return result.value;
  }

  async back() {
    const tab = this.currentTab;

    if (tab.position > 0) {
      tab.position--;
      const url = tab.history[tab.position];
      await this.load(url, false);
      tab.position = tab.history.indexOf(url);
      return tab.page;
    }

    if (tab.parentTabId != null) {
      const parent = this.tabs.find(t => t.id === tab.parentTabId);
      if (parent) {
        this.activeTab = this.tabs.indexOf(parent);
        return parent.page;
      }
    }

    throw new Error('No history to go back to');
  }

  async forward() {
    const tab = this.currentTab;

    if (tab.position < tab.history.length - 1) {
      tab.position++;
      const url = tab.history[tab.position];
      await this.load(url, false);
      tab.position = tab.history.indexOf(url);
      return tab.page;
    }

    throw new Error('No forward history');
  }

  async reload() {
    const tab = this.currentTab;
    if (!tab.page) throw new Error('Nothing to reload');
    return this.load(tab.page.url, false);
  }

  switchTab(id) {
    const index = this.tabs.findIndex(t => t.id === Number(id));
    if (index === -1) throw new Error('No tab ' + id);
    this.activeTab = index;
    return this.tabs[index];
  }

  closeTab(id) {
    const index = this.tabs.findIndex(t => t.id === Number(id));
    if (index === -1) throw new Error('No tab ' + id);

    this._dropSession(this.tabs[index]);
    this.tabs.splice(index, 1);

    if (this.activeTab >= this.tabs.length) {
      this.activeTab = this.tabs.length - 1;
    }

    return this.currentTab;
  }

  getHistory() {
    return this.currentTab.history.slice();
  }

  getTabs() {
    return this.tabs.map(t => ({
      id: t.id,
      active: this.tabs.indexOf(t) === this.activeTab,
      url: t.page ? t.page.url : '',
      title: t.page ? t.page.document.title : ''
    }));
  }

  dispose() {
    for (const tab of this.tabs) this._dropSession(tab);
  }
}

module.exports = Browser;
