import * as vscode from 'vscode';
import * as path from 'path';

type LogItem = {
  session: string;
  category: string;
  output: string;
  ansiSource?: boolean; // true = classified via ANSI color → let parseAnsi drive the color
};

class FlutterConsoleStore {
  private logs: LogItem[] = [];
  private listeners = new Set<(items: LogItem[]) => void>();
  private clearListeners = new Set<() => void>();

  add(item: LogItem) {
    const cfg = vscode.workspace.getConfiguration('flutterDebuggerPlus');
    const maxLines = cfg.get<number>('maxLines', 10000);

    const normalized = item.output.replace(/\r\n/g, '\n');
    const parts = normalized.split('\n');
    const batch: LogItem[] = [];
    for (let i = 0; i < parts.length; i++) {
      const text = parts[i];
      const isLast = i === parts.length - 1;
      if (text === '' && isLast) continue;
      batch.push({ ...item, output: text });
    }
    if (!batch.length) return;

    this.logs.push(...batch);
    if (this.logs.length > maxLines) {
      this.logs.splice(0, this.logs.length - maxLines);
    }

    for (const listener of this.listeners) listener(batch);
  }

  all() {
    return [...this.logs];
  }

  clear() {
    this.logs = [];
    for (const listener of this.clearListeners) listener();
  }

  onLog(listener: (items: LogItem[]) => void): vscode.Disposable {
    this.listeners.add(listener);
    return new vscode.Disposable(() => this.listeners.delete(listener));
  }

  onClear(listener: () => void): vscode.Disposable {
    this.clearListeners.add(listener);
    return new vscode.Disposable(() => this.clearListeners.delete(listener));
  }
}

const EXCLUDE_PROJECT = '{**/.fvm/**,**/.pub-cache/**,**/build/**,**/node_modules/**,**/.dart_tool/**}';
const EXCLUDE_MINIMAL = '{**/node_modules/**}';

// Cache package_config per workspace folder (path → {packages, mtime})
const pkgConfigCache = new Map<string, { packages: { name: string; rootUri: string; packageUri: string }[]; mtime: number }>();

async function resolvePackageUri(pkg: string, pkgPath: string): Promise<vscode.Uri | undefined> {
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    const cfgUri = vscode.Uri.joinPath(folder.uri, '.dart_tool', 'package_config.json');
    try {
      // Invalidate cache when file changes
      const stat = await vscode.workspace.fs.stat(cfgUri);
      const cached = pkgConfigCache.get(folder.uri.fsPath);
      if (!cached || cached.mtime !== stat.mtime) {
        const bytes = await vscode.workspace.fs.readFile(cfgUri);
        const json = JSON.parse(Buffer.from(bytes).toString('utf8'));
        pkgConfigCache.set(folder.uri.fsPath, { packages: json.packages ?? [], mtime: stat.mtime });
      }
      const { packages } = pkgConfigCache.get(folder.uri.fsPath)!;
      const entry = packages.find(p => p.name === pkg);
      if (!entry) continue;

      // rootUri can be an absolute file:// URI or a path relative to .dart_tool/
      let rootUri: vscode.Uri;
      if (entry.rootUri.startsWith('file://')) {
        rootUri = vscode.Uri.parse(entry.rootUri);
      } else {
        rootUri = vscode.Uri.joinPath(folder.uri, '.dart_tool', entry.rootUri);
      }

      // packageUri is typically "lib/" — the lib directory within the package root
      const pkgLibRelative = (entry.packageUri ?? 'lib/').replace(/\/$/, '');
      return vscode.Uri.joinPath(rootUri, pkgLibRelative, pkgPath);
    } catch { /* file missing or parse error → try next folder */ }
  }
  return undefined;
}

async function openFileAtLine(filePath: string, line: number, col: number, pkg?: string, pkgPath?: string) {
  const lineIdx = Math.max(0, (line || 1) - 1);
  const colIdx  = Math.max(0, (col  || 1) - 1);
  const range = new vscode.Range(lineIdx, colIdx, lineIdx, colIdx);
  const opts: vscode.TextDocumentShowOptions = { selection: range, preserveFocus: false };

  // 0. Exact resolution via .dart_tool/package_config.json — 100% accurate for any package
  if (pkg && pkgPath) {
    const uri = await resolvePackageUri(pkg, pkgPath);
    if (uri) {
      try {
        await vscode.window.showTextDocument(uri, opts);
        return;
      } catch { /* file might not exist on disk (generated/platform-specific) */ }
    }
  }

  // 1. Absolute path — open directly
  if (path.isAbsolute(filePath)) {
    try {
      await vscode.window.showTextDocument(vscode.Uri.file(filePath), opts);
      return;
    } catch { /* fall through */ }
  }

  // 2. Workspace-relative — covers project files mapped from package: URIs (lib/main.dart etc.)
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    try {
      const uri = vscode.Uri.joinPath(folder.uri, filePath);
      await vscode.window.showTextDocument(uri, opts);
      return;
    } catch { /* fall through */ }
  }

  const basename = filePath.split(/[/\\]/).pop() ?? filePath;
  const normalised = filePath.replace(/\\/g, '/');

  // Score: prefer files with matching path suffix that are NOT in SDK dirs
  function score(uri: vscode.Uri): number {
    const p = uri.fsPath.replace(/\\/g, '/');
    const inSdk = p.includes('/.fvm/') || p.includes('/.pub-cache/');
    let s = inSdk ? 0 : 100; // strongly prefer workspace files over SDK
    if (p.endsWith('/' + normalised) || p === normalised) s += 20;
    else if (p.includes('/' + normalised))                s += 10;
    else if (p.includes(normalised))                      s += 5;
    return s;
  }

  // 3. Round 1: search excluding SDK paths → finds project files reliably
  let found = await vscode.workspace.findFiles(`**/${basename}`, EXCLUDE_PROJECT, 20);

  // 4. Round 2: if nothing found, include SDK dirs → handles package:flutter/... etc.
  if (!found.length) {
    found = await vscode.workspace.findFiles(`**/${basename}`, EXCLUDE_MINIMAL, 20);
  }

  if (!found.length) {
    vscode.window.showWarningMessage(`Flutter Debugger Plus: file not found — ${filePath}`);
    return;
  }

  const best = found.slice().sort((a, b) => score(b) - score(a))[0];
  await vscode.window.showTextDocument(best, opts);
}

class ConsoleViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'flutterDebuggerPlus.consoleView';
  private view?: vscode.WebviewView;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly store: FlutterConsoleStore
  ) {}

  resolveWebviewView(webviewView: vscode.WebviewView) {
    this.view = webviewView;
    webviewView.webview.options = { enableScripts: true };
    webviewView.webview.html = this.getHtml();

    const sendInit = () => {
      webviewView.webview.postMessage({ type: 'init', logs: this.store.all() });
    };

    webviewView.webview.onDidReceiveMessage(async (msg) => {
      if (msg?.type === 'ready') { sendInit(); }
      if (msg?.type === 'clear') { this.store.clear(); }
      if (msg?.type === 'openFile') {
        await openFileAtLine(msg.path ?? '', msg.line ?? 1, msg.col ?? 1, msg.pkg, msg.pkgPath);
      }
    });

    this.store.onLog((items) => {
      this.view?.webview.postMessage({ type: 'logBatch', items });
    });

    this.store.onClear(() => {
      this.view?.webview.postMessage({ type: 'clear' });
    });
  }

  async reveal() {
    await vscode.commands.executeCommand('workbench.view.extension.flutterDebuggerPlusPanel');
    await vscode.commands.executeCommand(`${ConsoleViewProvider.viewType}.focus`);
  }

  private getHtml(): string {
    const nonce = getNonce();
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<style>
  :root { color-scheme: light dark; }
  html, body { height: 100%; }
  body {
    margin: 0;
    font-family: var(--vscode-font-family);
    background: var(--vscode-editor-background);
    color: var(--vscode-editor-foreground);
    overflow: hidden;
  }
  .root { height: 100%; display: flex; flex-direction: column; }

  /* ── Toolbar ───────────────────────────────────────────── */
  .toolbar-main {
    display: flex; gap: 4px; padding: 4px 8px; align-items: center;
    border-bottom: 1px solid var(--vscode-panel-border);
    background: var(--vscode-editor-background);
  }

  /* Search bar — hidden by default, shown on Cmd+F */
  .toolbar-search {
    display: none;
    gap: 6px; padding: 4px 8px; align-items: center;
    border-bottom: 1px solid var(--vscode-panel-border);
    background: var(--vscode-editor-background);
  }
  .toolbar-search.open { display: flex; }

  input, select, button {
    background: var(--vscode-input-background);
    color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, transparent);
    border-radius: 3px;
    font: inherit;
    font-size: 12px;
  }
  select {
    padding: 3px 4px;
    cursor: pointer;
    /* auto-width: no fixed width so browser sizes to content */
    width: auto;
  }
  input { flex: 1; min-width: 180px; padding: 3px 8px; }
  button {
    cursor: pointer; white-space: nowrap;
    padding: 3px 7px;
    display: inline-flex; align-items: center; justify-content: center; gap: 4px;
  }

  /* Icon-only action buttons */
  .btn-icon {
    background: transparent;
    border-color: transparent;
    padding: 3px 5px;
    opacity: .75;
    border-radius: 3px;
  }
  .btn-icon:hover { opacity: 1; background: var(--vscode-toolbar-hoverBackground, rgba(128,128,128,.15)); }
  .btn-icon svg { display: block; }

  /* Scroll-to-bottom — accent color */
  #bottom {
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
    border-color: transparent;
  }
  #bottom:hover { background: var(--vscode-button-hoverBackground); }

  /* Stats pushed to right */
  .spacer { flex: 1; }
  #stats { font-size: 11px; opacity: .65; white-space: nowrap; }

  #closeSearch {
    background: transparent; border-color: transparent;
    opacity: .7; padding: 3px 6px; font-size: 13px;
  }
  #closeSearch:hover { opacity: 1; }

  /* ── Search option toggles (Cc / W / .*) ─────────────────── */
  .search-options {
    display: inline-flex; gap: 2px; align-items: center;
    background: var(--vscode-input-background);
    border: 1px solid var(--vscode-input-border, transparent);
    border-radius: 3px;
    padding: 1px 2px;
  }
  .opt-btn {
    background: transparent;
    border: 1px solid transparent;
    border-radius: 2px;
    padding: 1px 5px;
    font-size: 11px;
    font-weight: 600;
    cursor: pointer;
    color: var(--vscode-input-foreground);
    opacity: .55;
    line-height: 1.6;
    white-space: nowrap;
  }
  .opt-btn:hover { opacity: 1; background: var(--vscode-toolbar-hoverBackground, rgba(128,128,128,.15)); }
  .opt-btn.active {
    opacity: 1;
    background: var(--vscode-inputOption-activeBackground, rgba(0,120,212,.3));
    border-color: var(--vscode-inputOption-activeBorder, rgba(0,120,212,.6));
    color: var(--vscode-inputOption-activeForeground, var(--vscode-input-foreground));
  }

  /* ── Log area ──────────────────────────────────────────── */
  #logsWrap { flex: 1; overflow: auto; }
  #logs {
    padding: 6px 8px;
    font-family: var(--vscode-editor-font-family);
    font-size: var(--vscode-editor-font-size);
    line-height: 1.45;
  }
  .line {
    white-space: pre-wrap;
    word-break: break-all;
    min-height: 1.45em;
  }

  /* ── Log category colors — all use VS Code theme tokens ── */
  .stdout  { color: var(--vscode-debugConsole-infoForeground); }
  .console { color: var(--vscode-debugConsole-infoForeground); }
  .stderr  { color: var(--vscode-debugConsole-errorForeground); }
  .warn    { color: var(--vscode-debugConsole-warningForeground); }
  .telemetry { color: var(--vscode-debugConsole-sourceForeground); opacity: .75; }
  .important { color: var(--vscode-debugConsole-infoForeground); font-weight: bold; }
  .network   { color: var(--vscode-terminal-ansiCyan); }
  /* Lines detected via ANSI: let parseAnsi() drive the color, don't override */
  .ansi-source { color: inherit; }

  /* ── Search highlight ─────────────────────────────────── */
  mark.match {
    background: var(--vscode-editor-findMatchHighlightBackground, rgba(234,92,0,.33));
    color: inherit;
    border-radius: 2px;
    padding: 0 1px;
  }
  mark.match.current {
    background: var(--vscode-editor-findMatchBackground, rgba(255,215,0,.7));
    outline: 1px solid var(--vscode-contrastBorder, transparent);
  }

  /* ── Clickable file links ─────────────────────────────── */
  .file-link {
    text-decoration: underline;
    text-decoration-style: dotted;
    text-underline-offset: 2px;
    cursor: pointer;
    color: inherit;
  }
  .file-link:hover {
    text-decoration-style: solid;
    color: var(--vscode-textLink-activeForeground, var(--vscode-textLink-foreground));
  }
</style>
</head>
<body>
<div class="root">
  <div class="toolbar-main">
    <select id="category">
      <option value="all">All</option>
      <option value="stdout">stdout</option>
      <option value="stderr">stderr</option>
      <option value="console">console</option>
      <option value="warn">warn</option>
      <option value="telemetry">telemetry</option>
      <option value="important">important</option>
      <option value="network">network [log]</option>
    </select>
    <div class="spacer"></div>
    <span id="stats">0 logs</span>
    <!-- Clear: trash icon -->
    <button id="clear" class="btn-icon" title="Clear logs">
      <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 16 16" fill="currentColor">
        <path d="M10 3h3v1h-1v9l-1 1H4l-1-1V4H2V3h3V2a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1v1zm-1 0V2H6v1h3zM4 13h7V4H4v9zm2-8H5v7h1V5zm1 0h1v7H7V5zm2 0h1v7H9V5z"/>
      </svg>
    </button>
    <!-- Bottom: scroll-to-bottom icon -->
    <button id="bottom" title="Scroll to bottom">
      <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
        <path d="M8 11.5L2.5 6h11L8 11.5z"/>
        <rect x="2" y="13" width="12" height="1.5" rx="0.75"/>
      </svg>
    </button>
  </div>
  <div class="toolbar-search" id="searchBar">
    <input id="search" placeholder="Search…" title="Enter = next  Shift+Enter = prev" />
    <div class="search-options">
      <button class="opt-btn" id="optCase"  title="Match Case (Alt+C)">Cc</button>
      <button class="opt-btn" id="optWord"  title="Match Whole Word (Alt+W)">W</button>
      <button class="opt-btn" id="optRegex" title="Use Regular Expression (Alt+R)">.*</button>
    </div>
    <button id="prev" class="btn-icon" title="Previous (Shift+Enter)">
      <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 16 16" fill="currentColor"><path d="M8 5L13.5 11h-11L8 5z"/></svg>
    </button>
    <button id="next" class="btn-icon" title="Next (Enter)">
      <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 16 16" fill="currentColor"><path d="M8 11L2.5 5h11L8 11z"/></svg>
    </button>
    <span id="matchStats" style="font-size:11px;opacity:.7;white-space:nowrap"></span>
    <button id="closeSearch" title="Close (ESC)">✕</button>
  </div>
  <div id="logsWrap"><div id="logs"></div></div>
</div>
<script nonce="${nonce}">
(function () {
  'use strict';
  const vscode = acquireVsCodeApi();

  // ── DOM refs ──────────────────────────────────────────────
  const logsWrap   = document.getElementById('logsWrap');
  const logsEl     = document.getElementById('logs');
  const searchEl   = document.getElementById('search');
  const searchBar  = document.getElementById('searchBar');
  const categoryEl = document.getElementById('category');
  const statsEl    = document.getElementById('stats');
  const matchStats = document.getElementById('matchStats');
  const clearBtn   = document.getElementById('clear');
  const bottomBtn  = document.getElementById('bottom');
  const nextBtn    = document.getElementById('next');
  const prevBtn    = document.getElementById('prev');
  const closeSearchBtn = document.getElementById('closeSearch');
  const optCase  = document.getElementById('optCase');
  const optWord  = document.getElementById('optWord');
  const optRegex = document.getElementById('optRegex');

  // ── Search option state ───────────────────────────────────
  const searchOpts = { matchCase: false, wholeWord: false, regex: false };

  function toggleOpt(key, btn) {
    searchOpts[key] = !searchOpts[key];
    btn.classList.toggle('active', searchOpts[key]);
    // regex và wholeWord không cần nhau
    if (key === 'regex' && searchOpts.regex) {
      searchOpts.wholeWord = false;
      optWord.classList.remove('active');
    }
    if (key === 'wholeWord' && searchOpts.wholeWord) {
      searchOpts.regex = false;
      optRegex.classList.remove('active');
    }
    scheduleHighlight();
  }

  optCase.addEventListener('click',  () => toggleOpt('matchCase', optCase));
  optWord.addEventListener('click',  () => toggleOpt('wholeWord', optWord));
  optRegex.addEventListener('click', () => toggleOpt('regex',     optRegex));

  // Alt+C / Alt+W / Alt+R shortcuts
  document.addEventListener('keydown', (e) => {
    if (!e.altKey) return;
    if (e.key === 'c' || e.key === 'C') { e.preventDefault(); toggleOpt('matchCase', optCase); }
    if (e.key === 'w' || e.key === 'W') { e.preventDefault(); toggleOpt('wholeWord', optWord); }
    if (e.key === 'r' || e.key === 'R') { e.preventDefault(); toggleOpt('regex',     optRegex); }
  });

  // ── Search bar open / close ───────────────────────────────
  function openSearch(prefill) {
    searchBar.classList.add('open');
    if (prefill != null) searchEl.value = prefill;
    searchEl.focus();
    searchEl.select();
    scheduleHighlight();
  }

  function closeSearch() {
    searchBar.classList.remove('open');
    searchEl.value = '';
    applyFilterAndHighlight();
    logsWrap.focus();
  }

  // ── State ─────────────────────────────────────────────────
  let logs            = [];   // [{session, category, output(raw)}]
  let matchNodes      = [];
  let currentMatchIdx = -1;
  let pendingItems    = [];
  let flushTimer      = null;
  let highlightTimer  = null;
  let autoStickBottom = true;

  // ── ANSI parser ───────────────────────────────────────────
  // Maps SGR code → VSCode terminal CSS variable
  const ANSI_FG = {
    30: 'var(--vscode-terminal-ansiBlack)',
    31: 'var(--vscode-terminal-ansiRed)',
    32: 'var(--vscode-terminal-ansiGreen)',
    33: 'var(--vscode-terminal-ansiYellow)',
    34: 'var(--vscode-terminal-ansiBlue)',
    35: 'var(--vscode-terminal-ansiMagenta)',
    36: 'var(--vscode-terminal-ansiCyan)',
    37: 'var(--vscode-terminal-ansiWhite)',
    90: 'var(--vscode-terminal-ansiBrightBlack)',
    91: 'var(--vscode-terminal-ansiBrightRed)',
    92: 'var(--vscode-terminal-ansiBrightGreen)',
    93: 'var(--vscode-terminal-ansiBrightYellow)',
    94: 'var(--vscode-terminal-ansiBrightBlue)',
    95: 'var(--vscode-terminal-ansiBrightMagenta)',
    96: 'var(--vscode-terminal-ansiBrightCyan)',
    97: 'var(--vscode-terminal-ansiBrightWhite)',
  };

  // Returns array of {text, fg, bold, dim, italic, underline}
  function parseAnsi(raw) {
    const segments = [];
    const re = /\\x1b\\[([0-9;]*)m/g;
    let st = { fg: null, bold: false, dim: false, italic: false, underline: false };
    let last = 0;
    let m;
    while ((m = re.exec(raw)) !== null) {
      if (m.index > last) {
        segments.push({ text: raw.slice(last, m.index), ...st });
      }
      const codes = m[1] === '' ? [0] : m[1].split(';').map(Number);
      for (const c of codes) {
        if (c === 0)  { st = { fg: null, bold: false, dim: false, italic: false, underline: false }; }
        else if (c === 1)  { st = { ...st, bold: true }; }
        else if (c === 2)  { st = { ...st, dim: true }; }
        else if (c === 3)  { st = { ...st, italic: true }; }
        else if (c === 4)  { st = { ...st, underline: true }; }
        else if (c === 22) { st = { ...st, bold: false, dim: false }; }
        else if (c === 23) { st = { ...st, italic: false }; }
        else if (c === 24) { st = { ...st, underline: false }; }
        else if (c === 39) { st = { ...st, fg: null }; }
        else if (ANSI_FG[c]) { st = { ...st, fg: ANSI_FG[c] }; }
      }
      last = re.lastIndex;
    }
    if (last < raw.length) segments.push({ text: raw.slice(last), ...st });
    return segments;
  }

  function stripAnsi(raw) {
    return raw.replace(/\\x1b\\[[0-9;]*m/g, '');
  }

  // ── File-link detection ───────────────────────────────────
  // Returns [{start, end, path, line, col}] sorted by start
  function findFileLinks(plain) {
    const results = [];
    const seen = (s, e) => results.some(r => s < r.end && e > r.start);

    // package:pkg/path.dart:line:col
    // Capture pkg name + pkg-relative path so extension host can do exact lookup
    // via .dart_tool/package_config.json (100% accurate, no search/scoring needed)
    const pkgRe = /package:([\\w_]+)\\/([\\w/.\\-]+\\.dart)(?::(\\d+)(?::(\\d+))?)?/g;
    let m;
    while ((m = pkgRe.exec(plain)) !== null) {
      results.push({ start: m.index, end: m.index + m[0].length,
        pkg: m[1], pkgPath: m[2],
        path: 'lib/' + m[2],          // fallback if package_config.json not found
        line: +(m[3] ?? 1), col: +(m[4] ?? 1), label: m[0] });
    }

    // Absolute or relative paths like lib/foo.dart:12:3 or /abs/path/file.dart:5
    const pathRe = /((?:[a-zA-Z]:[\\\\/]|\\/|\\.{1,2}\\/)?(?:[\\w.\\-]+\\/)*[\\w.\\-]+\\.(?:dart|ts|tsx|js|jsx|py|go|java|kt|swift|cpp|c|h|cs|rb|rs))(?::(\\d+)(?::(\\d+))?)?/g;
    while ((m = pathRe.exec(plain)) !== null) {
      if (!seen(m.index, m.index + m[0].length)) {
        results.push({ start: m.index, end: m.index + m[0].length,
          path: m[1], line: +(m[2] ?? 1), col: +(m[3] ?? 1), label: m[0] });
      }
    }

    results.sort((a, b) => a.start - b.start);
    return results;
  }

  // ── Search helpers ────────────────────────────────────────
  function parseQuery(q) {
    if (!q) return null;
    if (searchOpts.regex) {
      try { return new RegExp(q, searchOpts.matchCase ? 'g' : 'gi'); } catch (_) { return null; }
    }
    if (searchOpts.wholeWord) {
      const escaped = q.replace(/[.*+?^\${}()|[\]\\]/g, '\\$&');
      const flags = searchOpts.matchCase ? 'g' : 'gi';
      try { return new RegExp('\\b' + escaped + '\\b', flags); } catch (_) {}
    }
    // Plain text — wrap into regex so we can honour matchCase easily
    const escaped = q.replace(/[.*+?^\${}()|[\]\\]/g, '\\$&');
    const flags = searchOpts.matchCase ? 'g' : 'gi';
    return new RegExp(escaped, flags);
  }

  function findSearchMatches(plain, query) {
    const hits = [];
    if (!query) return hits;
    if (query instanceof RegExp) {
      const flags = query.flags.includes('g') ? query.flags : query.flags + 'g';
      const re = new RegExp(query.source, flags);
      let m;
      while ((m = re.exec(plain)) !== null) {
        hits.push({ start: m.index, end: m.index + m[0].length });
        if (m[0].length === 0) re.lastIndex++;
      }
    } else {
      const lower = plain.toLowerCase();
      const qLower = query.toLowerCase();
      let idx = 0;
      while ((idx = lower.indexOf(qLower, idx)) !== -1) {
        hits.push({ start: idx, end: idx + query.length });
        idx += query.length || 1;
      }
    }
    return hits;
  }

  // ── Core renderer ─────────────────────────────────────────
  // Builds innerHTML from raw text, applying ANSI, file links, and search marks.
  // Returns { html, markCount } where markCount = number of <mark> elements added.
  function renderLineHtml(raw, query) {
    const segments   = parseAnsi(raw);
    const plain      = segments.map(s => s.text).join('');
    const fileLinks  = findFileLinks(plain);
    const searchHits = findSearchMatches(plain, query);

    // Collect all boundary positions to split on
    const boundaries = new Set([0, plain.length]);
    for (const r of [...fileLinks, ...searchHits]) {
      boundaries.add(r.start);
      boundaries.add(r.end);
    }
    // Also split at ANSI segment boundaries
    let off = 0;
    for (const seg of segments) { boundaries.add(off); off += seg.text.length; }
    const positions = Array.from(boundaries).sort((a, b) => a - b);

    // Build per-position ANSI style lookup
    const ansiAt = new Array(plain.length + 1).fill(null);
    let cursor = 0;
    for (const seg of segments) {
      for (let i = 0; i < seg.text.length; i++) ansiAt[cursor + i] = seg;
      cursor += seg.text.length;
    }

    let html = '';
    let markCount = 0;

    for (let pi = 0; pi < positions.length - 1; pi++) {
      const start = positions[pi];
      const end   = positions[pi + 1];
      if (start === end) continue;

      const chunk    = plain.slice(start, end);
      const ansiSeg  = ansiAt[start];
      const inLink   = fileLinks.find(l  => l.start  <= start && end <= l.end);
      const inSearch = searchHits.find(h => h.start <= start && end <= h.end);

      // Build CSS for ANSI
      let ansiStyle = '';
      if (ansiSeg) {
        if (ansiSeg.fg)        ansiStyle += 'color:' + ansiSeg.fg + ';';
        if (ansiSeg.bold)      ansiStyle += 'font-weight:bold;';
        if (ansiSeg.dim)       ansiStyle += 'opacity:.5;';
        if (ansiSeg.italic)    ansiStyle += 'font-style:italic;';
        if (ansiSeg.underline) ansiStyle += 'text-decoration:underline;';
      }

      const escaped = escHtml(chunk);

      // Outer tag: file-link > mark > span(ansi) — innermost wins visually for color
      let inner = ansiStyle ? '<span style="' + ansiStyle + '">' + escaped + '</span>' : escaped;

      if (inSearch) {
        inner = '<mark class="match">' + inner + '</mark>';
        markCount++;
      }
      if (inLink) {
        inner = '<span class="file-link"' +
          ' data-path="' + escAttr(inLink.path) + '"' +
          (inLink.pkg     ? ' data-pkg="'      + escAttr(inLink.pkg)     + '"' : '') +
          (inLink.pkgPath ? ' data-pkg-path="' + escAttr(inLink.pkgPath) + '"' : '') +
          ' data-line="' + inLink.line + '" data-col="' + inLink.col + '">' + inner + '</span>';
      }
      html += inner;
    }
    return { html, markCount };
  }

  function escHtml(s) {
    return s.replace(/[&<>"']/g, c =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[c]));
  }
  function escAttr(s) {
    return s.replace(/"/g, '&quot;').replace(/'/g, '&#039;');
  }

  // ── DOM helpers ───────────────────────────────────────────
  function isNearBottom() {
    return logsWrap.scrollTop + logsWrap.clientHeight >= logsWrap.scrollHeight - 32;
  }
  function scrollToBottom() { logsWrap.scrollTop = logsWrap.scrollHeight; }

  function updateStats() {
    statsEl.textContent = logs.length + ' logs';
    if (matchNodes.length > 0) {
      const idx = currentMatchIdx >= 0 ? (currentMatchIdx + 1) + '/' + matchNodes.length : matchNodes.length;
      matchStats.textContent = idx + ' match' + (matchNodes.length !== 1 ? 'es' : '');
    } else {
      matchStats.textContent = '';
    }
  }

  function createLineEl(item, query) {
    const div = document.createElement('div');
    // ansiSource: color comes from ANSI codes inside the text → add 'ansi-source' to
    // suppress the category color override and let parseAnsi() use VS Code theme colors.
    div.className = 'line ' + item.category + (item.ansiSource ? ' ansi-source' : '');
    div.dataset.category = item.category;
    if (query) {
      const { html } = renderLineHtml(item.output, query);
      div.innerHTML = html;
    } else {
      const segs = parseAnsi(item.output);
      if (segs.length === 1 && !segs[0].fg && !segs[0].bold && !segs[0].dim && !segs[0].italic && !segs[0].underline) {
        // Plain text — also detect file links
        const plain = segs[0].text;
        const links = findFileLinks(plain);
        if (links.length) {
          div.innerHTML = renderLineHtml(item.output, null).html;
        } else {
          div.textContent = plain;
        }
      } else {
        div.innerHTML = renderLineHtml(item.output, null).html;
      }
    }
    return div;
  }

  // ── Batch append ─────────────────────────────────────────
  function appendBatch(items) {
    if (!items?.length) return;
    const stick = autoStickBottom || isNearBottom();
    const query = parseQuery(searchEl.value.trim());
    const cat   = categoryEl.value;
    const frag  = document.createDocumentFragment();

    for (const item of items) {
      logs.push(item);
      const el = createLineEl(item, query);
      const visible = cat === 'all' || item.category === cat;
      if (!visible) el.style.display = 'none';
      frag.appendChild(el);
    }
    logsEl.appendChild(frag);

    // Collect new match nodes
    const newMarks = Array.from(logsEl.querySelectorAll('mark.match'));
    // Only keep marks that are not already tracked (they appear at end of logsEl)
    const existingCount = matchNodes.length;
    matchNodes = newMarks;
    if (matchNodes.length > existingCount && currentMatchIdx === -1) {
      currentMatchIdx = existingCount; // first new match
      setCurrentMatch(currentMatchIdx, false);
    }

    updateStats();
    if (stick) scrollToBottom();
  }

  function queueBatch(items) {
    pendingItems.push(...items);
    if (flushTimer) return;
    flushTimer = requestAnimationFrame(() => {
      const batch = pendingItems.splice(0);
      flushTimer = null;
      appendBatch(batch);
    });
  }

  // ── Filter + full re-highlight ────────────────────────────
  function applyFilterAndHighlight() {
    matchNodes      = [];
    currentMatchIdx = -1;
    const query = parseQuery(searchEl.value.trim());
    const cat   = categoryEl.value;
    const children = logsEl.children;

    for (let i = 0; i < logs.length; i++) {
      const item = logs[i];
      const el   = children[i];
      if (!el) continue;
      const visible = cat === 'all' || item.category === cat;
      el.style.display = visible ? '' : 'none';
      if (!visible) continue;

      const { html } = renderLineHtml(item.output, query);
      if (el.innerHTML !== html) el.innerHTML = html;
    }

    matchNodes = Array.from(logsEl.querySelectorAll('mark.match'));
    if (matchNodes.length) setCurrentMatch(0, true);
    updateStats();
  }

  function scheduleHighlight() {
    if (highlightTimer) clearTimeout(highlightTimer);
    highlightTimer = setTimeout(() => { highlightTimer = null; applyFilterAndHighlight(); }, 80);
  }

  // ── Match navigation ──────────────────────────────────────
  function setCurrentMatch(index, reveal = true) {
    if (!matchNodes.length) { currentMatchIdx = -1; updateStats(); return; }
    if (currentMatchIdx >= 0 && matchNodes[currentMatchIdx]) {
      matchNodes[currentMatchIdx].classList.remove('current');
    }
    currentMatchIdx = ((index % matchNodes.length) + matchNodes.length) % matchNodes.length;
    const node = matchNodes[currentMatchIdx];
    node.classList.add('current');
    if (reveal) node.scrollIntoView({ block: 'center' });
    updateStats();
  }

  function rebuildAll() {
    const stick = autoStickBottom || isNearBottom();
    logsEl.innerHTML = '';
    const frag = document.createDocumentFragment();
    const query = parseQuery(searchEl.value.trim());
    const cat   = categoryEl.value;
    for (const item of logs) {
      const el = createLineEl(item, query);
      if (cat !== 'all' && item.category !== cat) el.style.display = 'none';
      frag.appendChild(el);
    }
    logsEl.appendChild(frag);
    matchNodes      = Array.from(logsEl.querySelectorAll('mark.match'));
    currentMatchIdx = -1;
    if (matchNodes.length) setCurrentMatch(0, false);
    updateStats();
    if (stick) scrollToBottom();
  }

  // ── Event listeners ───────────────────────────────────────
  // Auto-resize select to fit selected option text
  function resizeSelect() {
    const tmp = document.createElement('canvas');
    const ctx = tmp.getContext('2d');
    ctx.font = getComputedStyle(categoryEl).font;
    const text = categoryEl.options[categoryEl.selectedIndex]?.text ?? '';
    categoryEl.style.width = (ctx.measureText(text).width + 36) + 'px';
  }
  resizeSelect();

  searchEl.addEventListener('input', scheduleHighlight);
  categoryEl.addEventListener('change', () => { resizeSelect(); applyFilterAndHighlight(); });
  clearBtn.addEventListener('click', () => vscode.postMessage({ type: 'clear' }));
  bottomBtn.addEventListener('click', () => { autoStickBottom = true; scrollToBottom(); });
  nextBtn.addEventListener('click', () => setCurrentMatch(currentMatchIdx + 1));
  prevBtn.addEventListener('click', () => setCurrentMatch(currentMatchIdx - 1));
  closeSearchBtn.addEventListener('click', closeSearch);
  logsWrap.addEventListener('scroll', () => { autoStickBottom = isNearBottom(); });

  // Enter / Shift+Enter → navigate matches  |  ESC → close search
  searchEl.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); closeSearch(); return; }
    if (e.key !== 'Enter') return;
    e.preventDefault();
    setCurrentMatch(e.shiftKey ? currentMatchIdx - 1 : currentMatchIdx + 1);
  });

  // Cmd+F / Ctrl+F → mở search bar, điền selection nếu có
  document.addEventListener('keydown', (e) => {
    if (!(e.metaKey || e.ctrlKey) || e.key !== 'f') return;
    e.preventDefault();
    const sel = window.getSelection()?.toString().trim() || null;
    openSearch(sel);
  });

  // Click file links → postMessage to extension host
  logsEl.addEventListener('click', (e) => {
    const link = e.target.closest('.file-link');
    if (!link) return;
    vscode.postMessage({
      type:    'openFile',
      path:    link.dataset.path,
      pkg:     link.dataset.pkg     ?? '',
      pkgPath: link.dataset.pkgPath ?? '',
      line:    parseInt(link.dataset.line ?? '1', 10),
      col:     parseInt(link.dataset.col  ?? '1', 10),
    });
  });

  // ── Extension messages ────────────────────────────────────
  window.addEventListener('message', (event) => {
    const msg = event.data;
    if (msg.type === 'init') {
      logs = msg.logs ?? [];
      rebuildAll();
      return;
    }
    if (msg.type === 'logBatch') {
      queueBatch(msg.items ?? []);
      return;
    }
    if (msg.type === 'clear') {
      logs            = [];
      pendingItems    = [];
      matchNodes      = [];
      currentMatchIdx = -1;
      logsEl.innerHTML = '';
      updateStats();
      return;
    }
  });

  vscode.postMessage({ type: 'ready' });
})();
</script>
</body>
</html>`;
  }
}

function isFlutterOrDartSession(session: vscode.DebugSession) {
  const type = String(session.type || '').toLowerCase();
  const name = String(session.name || '').toLowerCase();
  const cfgType = String((session.configuration as Record<string, unknown>)?.type ?? '').toLowerCase();
  return type.includes('dart') || type.includes('flutter') ||
    cfgType.includes('dart') || name.includes('flutter') || name.includes('dart');
}

function getNonce() {
  let text = '';
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) text += possible.charAt(Math.floor(Math.random() * possible.length));
  return text;
}

/** Strip ANSI SGR sequences so pattern matching works on visible text. */
function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, '');
}

/** Dart compiler / analyzer error or context header line. */
function isDartCompileLine(output: string): boolean {
  return /\.dart:\d+:\d+:.*\b(Error|Context)\b/i.test(stripAnsi(output));
}

/**
 * Layer 1: classify by ANSI escape color embedded by the tool itself.
 * - Dart compiler colors errors red, warnings yellow.
 * - logger package uses 256-color: 196/199 (red/pink) for e/f, 208 (orange) for w.
 * Returns 'stderr' | 'warn' | null (null = no ANSI color hint found).
 */
function classifyByAnsi(output: string): 'stderr' | 'warn' | null {
  // Basic red (31), bright red (91), 256-color red (196) / pink (199) — errors & fatals
  if (/\x1b\[(?:31|91)m/.test(output) || /\x1b\[38;5;(?:196|199)m/.test(output)) {
    return 'stderr';
  }
  // Basic yellow (33), bright yellow (93), 256-color orange (208) — warnings
  if (/\x1b\[(?:33|93)m/.test(output) || /\x1b\[38;5;208m/.test(output)) {
    return 'warn';
  }
  return null;
}

/**
 * Layer 2: classify by text pattern (fallback when ANSI is absent, e.g. logcat strips it).
 * Returns 'stderr' | 'warn' | null.
 */
function classifyByPattern(output: string): 'stderr' | 'warn' | null {
  const text = stripAnsi(output);
  // ── Errors ──────────────────────────────────────────────────────────────
  const isError =
    // Android logcat — ALL E/flutter & F/flutter (logcat 'E' priority, ANSI stripped)
    /^[EF]\/flutter\s*\(\s*\d+\s*\):/.test(text) ||
    /^E\/AndroidRuntime\s*\(\s*\d+\s*\):/.test(text) ||
    /^FATAL EXCEPTION:/.test(text) ||
    // Flutter framework error box
    /══╡ EXCEPTION CAUGHT BY/.test(text) ||
    /^The following .+ (was thrown|error occurred)/.test(text) ||
    /^Another exception was thrown:/.test(text) ||
    // Dart VM / iOS (no logcat prefix)
    /^flutter: Unhandled Exception:/.test(text) ||
    /^flutter: (Exception|Error|FormatException|StateError|RangeError|TypeError|NoSuchMethodError|ArgumentError|AssertionError|NullThrownError|StackOverflowError|ConcurrentModificationError|UnsupportedError):/.test(text) ||
    // Dart compiler/analyzer — ANSI may sit between line:col and "Error:"
    /\.dart:\d+:\d+:.*\bError\b/i.test(text) ||
    /\.dart:\d+:\d+:.*\bContext\b/i.test(text) ||
    // Riverpod
    /\bProviderException\b/.test(text) ||
    /\bCircularDependencyError\b/.test(text) ||
    // logger package emoji fallback (when colors: false)
    /[⛔👾]/.test(text);

  if (isError) return 'stderr';

  // ── Warnings ────────────────────────────────────────────────────────────
  const isWarn =
    /^W\/flutter\s*\(\s*\d+\s*\):/.test(text) ||
    /\.dart:\d+:\d+:.*\bWarning\b/i.test(text) ||
    // logger package emoji fallback
    /⚠/.test(text);

  if (isWarn) return 'warn';

  return null;
}

/**
 * Main classifier: ANSI layer first (most accurate), then pattern layer (fallback).
 * Returns category + whether color came from ANSI (so webview can let parseAnsi drive rendering).
 */
function classifyCategory(output: string, base: string): { category: string; ansiSource: boolean } {
  if (base === 'stderr') return { category: 'stderr', ansiSource: false };
  const ansi = classifyByAnsi(output);
  if (ansi) return { category: ansi, ansiSource: true };
  const pattern = classifyByPattern(output);
  if (pattern) return { category: pattern, ansiSource: false };
  if (/^\[log\]/.test(output)) return { category: 'network', ansiSource: false };
  return { category: base, ansiSource: false };
}

export function activate(context: vscode.ExtensionContext) {
  const store    = new FlutterConsoleStore();
  const provider = new ConsoleViewProvider(context, store);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(ConsoleViewProvider.viewType, provider, {
      webviewOptions: { retainContextWhenHidden: true }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('flutterDebuggerPlus.show',  () => provider.reveal()),
    vscode.commands.registerCommand('flutterDebuggerPlus.clear', () => store.clear())
  );

  context.subscriptions.push(vscode.debug.onDidStartDebugSession(async (session) => {
    const cfg = vscode.workspace.getConfiguration('flutterDebuggerPlus');
    if (!cfg.get<boolean>('autoRevealOnFlutterDebug', true)) return;
    if (cfg.get<boolean>('onlyFlutterDart', true) && !isFlutterOrDartSession(session)) return;
    await provider.reveal();
  }));

  context.subscriptions.push(vscode.debug.registerDebugAdapterTrackerFactory('*', {
    createDebugAdapterTracker(session: vscode.DebugSession) {
      const cfg = vscode.workspace.getConfiguration('flutterDebuggerPlus');
      if (cfg.get<boolean>('onlyFlutterDart', true) && !isFlutterOrDartSession(session)) return undefined;

      // Tracks whether we are inside a [log] network block so that
      // body/curl continuation lines (without [log] prefix) inherit the network color.
      let networkBlock = false;
      // Tracks Dart compile error blocks (source snippets, ^^^ carets, etc.)
      let compileErrorBlock = false;

      return {
        onDidSendMessage(message: unknown) {
          const msg = message as Record<string, unknown>;
          if (msg?.type !== 'event' || msg?.event !== 'output') return;
          const body = (msg.body ?? {}) as Record<string, unknown>;
          const output = String(body.output ?? '');
          if (!output) return;
          const base = String(body.category ?? 'console');
          const stripped = stripAnsi(output);
          let { category, ansiSource } = classifyCategory(output, base);

          // Close blocks on independent log lines
          if (/^[A-Z]\/\w+\s*\(\s*\d+/.test(stripped) || /^Reloaded \d+ libraries/.test(stripped)) {
            networkBlock = false;
            compileErrorBlock = false;
          }

          if (isDartCompileLine(output)) {
            compileErrorBlock = true;
            networkBlock = false;
            category = 'stderr';
            ansiSource = false;
          } else if (/^\[log\]/.test(stripped)) {
            networkBlock = true;
            compileErrorBlock = false;
          } else if (compileErrorBlock && category === base) {
            category = 'stderr';
            ansiSource = false;
          } else if (category === 'network') {
            networkBlock = true;
            compileErrorBlock = false;
          } else if (networkBlock && category === base) {
            category = 'network';
            ansiSource = false;
          } else if (category !== base) {
            networkBlock = false;
            if (category !== 'stderr' && category !== 'warn') compileErrorBlock = false;
          }

          store.add({
            session: session.name,
            category,
            ansiSource,
            output,
          });
        }
      };
    }
  }));
}

export function deactivate() {}
