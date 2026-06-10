import * as vscode from 'vscode';
import * as path from 'path';

type LogItem = {
  session: string;
  category: string;
  output: string;
  ansiSource?: boolean; // true = classified via ANSI color → let parseAnsi drive the color
  loggerBlock?: boolean; // logger PrettyPrinter box line — strip flutter: prefix, compact style
  loggerFrame?: boolean; // box border / separator line (┌ ─ │ └)
  prettyDioBlock?: boolean; // flutter_pretty_dio_logger — strip [log] prefix, cyan styling
  prettyDioFrame?: boolean; // BEGIN/END separator line (==== onRequest ====)
};

class FlutterConsoleStore {
  private logs: LogItem[] = [];
  private listeners = new Set<(items: LogItem[]) => void>();
  private clearListeners = new Set<() => void>();

  add(item: LogItem) {
    const cfg = vscode.workspace.getConfiguration('flutterDebuggerPlus');
    const maxLines = cfg.get<number>('maxLines', 10000);

    const normalized = item.output.replace(/\r\n/g, '\n');
    const batch: LogItem[] = [];
    if (normalized === '') {
      // Intentional blank line (tracker already split per line) — keep it
      batch.push({ ...item, output: '' });
    } else {
      const parts = normalized.split('\n');
      for (let i = 0; i < parts.length; i++) {
        const text = parts[i];
        const isLast = i === parts.length - 1;
        if (text === '' && isLast) continue;
        batch.push({ ...item, output: text });
      }
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
  ) {
    this.store.onLog((items) => {
      this.view?.webview.postMessage({ type: 'logBatch', items });
    });
    this.store.onClear(() => {
      this.view?.webview.postMessage({ type: 'clear' });
    });
    context.subscriptions.push(
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('flutterDebuggerPlus.tooltipDuration')) {
          this.pushTooltipConfig();
        }
      })
    );
  }

  private tooltipDurationMs(): number {
    const cfg = vscode.workspace.getConfiguration('flutterDebuggerPlus');
    const sec = cfg.get<number>('tooltipDuration', 3);
    return sec <= 0 ? 0 : Math.round(sec * 1000);
  }

  private pushTooltipConfig() {
    this.view?.webview.postMessage({
      type: 'config',
      tooltipDurationMs: this.tooltipDurationMs()
    });
  }

  resolveWebviewView(webviewView: vscode.WebviewView) {
    this.view = webviewView;
    webviewView.webview.options = { enableScripts: true };
    webviewView.webview.html = this.getHtml();

    const sendInit = () => {
      webviewView.webview.postMessage({
        type: 'init',
        logs: this.store.all(),
        tooltipDurationMs: this.tooltipDurationMs()
      });
    };

    webviewView.webview.onDidReceiveMessage(async (msg) => {
      if (msg?.type === 'ready') { sendInit(); }
      if (msg?.type === 'clear') { this.store.clear(); }
      if (msg?.type === 'openFile') {
        await openFileAtLine(msg.path ?? '', msg.line ?? 1, msg.col ?? 1, msg.pkg, msg.pkgPath);
      }
    });
  }

  async reveal() {
    await vscode.commands.executeCommand('workbench.view.extension.flutterDebuggerPlusPanel');
    await vscode.commands.executeCommand(`${ConsoleViewProvider.viewType}.focus`);
  }

  private getHtml(): string {
    const nonce = getNonce();
    const tooltipDurationMs = this.tooltipDurationMs();
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

  /* ── Filter toolbar (VS Code Debug Console + Android Studio style) ── */
  .toolbar-filter {
    display: flex;
    gap: 4px;
    padding: 4px 6px;
    align-items: center;
    border-bottom: 1px solid var(--vscode-panel-border);
    background: var(--vscode-editor-background);
    flex-shrink: 0;
    overflow: visible;
    position: relative;
    z-index: 2;
  }
  .filter-wrap {
    flex: 1;
    display: flex;
    align-items: center;
    gap: 4px;
    min-width: 80px;
    background: var(--vscode-input-background);
    border: 1px solid var(--vscode-input-border, transparent);
    border-radius: 3px;
    padding: 0 6px;
  }
  .filter-wrap:focus-within {
    border-color: var(--vscode-focusBorder, var(--vscode-input-border));
  }
  .filter-icon {
    opacity: .55;
    flex-shrink: 0;
    display: block;
  }
  #search {
    flex: 1;
    min-width: 0;
    border: none;
    background: transparent;
    padding: 4px 0;
    font-size: 12px;
  }
  #search:focus { outline: none; }

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
  input:not(#search) { flex: 1; min-width: 180px; padding: 3px 8px; }
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

  /* Toggle buttons (soft wrap, scroll-to-end) — Android Studio style */
  .btn-icon.active {
    opacity: 1;
    background: var(--vscode-inputOption-activeBackground, rgba(0,120,212,.3));
    border: 1px solid var(--vscode-inputOption-activeBorder, rgba(0,120,212,.6));
    color: var(--vscode-inputOption-activeForeground, var(--vscode-input-foreground));
  }

  /* Stats / match count */
  .spacer { flex: 1; }
  #matchStats { font-size: 11px; opacity: .65; white-space: nowrap; min-width: 4em; text-align: right; }

  /* Category filter — compact, right side */
  #category {
    max-width: 9em;
    font-size: 11px;
    padding: 3px 4px;
  }

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

  /* ── Hover tooltips (Android Studio style — fixed host, not clipped) ── */
  .has-tip { position: relative; }
  .tip-select-wrap { display: inline-flex; position: relative; }
  /* Template content — copied to #tipHost on hover */
  .has-tip > .tip-popup { display: none !important; }

  #tipHost {
    position: fixed;
    z-index: 10000;
    min-width: 200px;
    max-width: 320px;
    padding: 8px 10px;
    background: var(--vscode-editorHoverWidget-background, #252526);
    color: var(--vscode-editorHoverWidget-foreground, #cccccc);
    border: 1px solid var(--vscode-editorHoverWidget-border, #454545);
    border-radius: 6px;
    box-shadow: 0 4px 14px rgba(0, 0, 0, .45);
    pointer-events: none;
    white-space: normal;
    text-align: left;
    line-height: 1.35;
  }
  #tipHost[hidden] { display: none !important; }
  #tipHost .tip-head {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    gap: 10px;
    font-weight: 600;
    font-size: 12px;
    margin-bottom: 5px;
  }
  #tipHost .tip-keys {
    opacity: .72;
    font-weight: 400;
    font-size: 11px;
    white-space: nowrap;
    flex-shrink: 0;
  }
  #tipHost .tip-body {
    font-size: 11px;
    opacity: .92;
    line-height: 1.45;
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
  /* Soft wrap off → keep lines on one row, scroll horizontally */
  #logs.nowrap { width: max-content; min-width: 100%; }
  #logs.nowrap .line { white-space: pre; word-break: normal; }

  /* ── Log category colors — all use VS Code theme tokens ── */
  .stdout  { color: var(--vscode-debugConsole-infoForeground); }
  .console { color: var(--vscode-debugConsole-infoForeground); }
  .stderr  { color: var(--vscode-debugConsole-errorForeground); }
  .warn    { color: var(--vscode-debugConsole-warningForeground); }
  .telemetry { color: var(--vscode-debugConsole-sourceForeground); opacity: .75; }
  .important { color: var(--vscode-debugConsole-infoForeground); font-weight: bold; }
  .line.network:not(.pretty-dio-block) {
    color: var(--vscode-terminal-ansiBrightCyan, var(--vscode-terminal-ansiCyan));
  }

  /* Error / warning — always use debug console theme colors */
  .line.stderr,
  .line.pretty-dio-block.stderr,
  .line.stderr.ansi-source,
  .line.logger-block.stderr {
    color: var(--vscode-debugConsole-errorForeground);
  }
  .line.stderr .file-link {
    color: inherit;
    text-decoration: underline;
    text-underline-offset: 2px;
    opacity: .95;
  }
  .line.stderr .file-link:hover {
    color: var(--vscode-textLink-activeForeground);
    opacity: 1;
  }
  .line.warn,
  .line.pretty-dio-block.warn,
  .line.warn.ansi-source,
  .line.logger-block.warn {
    color: var(--vscode-debugConsole-warningForeground);
  }

  /* flutter_pretty_dio_logger — syntax colors (network / API logs only) */
  .line.pretty-dio-block {
    line-height: 1.35;
    color: var(--vscode-editor-foreground, var(--vscode-debugConsole-infoForeground));
  }
  .line.pretty-dio-block.pretty-dio-frame {
    opacity: .72;
    font-size: .92em;
    letter-spacing: -.02em;
  }
  .line.pretty-dio-block.pretty-dio-frame.dio-phase-req {
    color: var(--vscode-terminal-ansiBlue, var(--vscode-debugConsole-infoForeground));
  }
  .line.pretty-dio-block.pretty-dio-frame.dio-phase-res {
    color: var(--vscode-terminal-ansiGreen, var(--vscode-debugConsole-infoForeground));
  }
  .line.pretty-dio-block.pretty-dio-frame.dio-phase-err {
    color: var(--vscode-debugConsole-errorForeground);
  }
  .line.pretty-dio-block .dio-kind-req {
    color: var(--vscode-terminal-ansiBlue, var(--vscode-debugConsole-infoForeground));
    font-weight: 600;
  }
  .line.pretty-dio-block .dio-kind-res {
    color: var(--vscode-terminal-ansiGreen, var(--vscode-debugConsole-infoForeground));
    font-weight: 600;
  }
  .line.pretty-dio-block .dio-kind-err {
    color: var(--vscode-debugConsole-errorForeground);
    font-weight: 600;
  }
  .line.pretty-dio-block .dio-method {
    color: var(--vscode-terminal-ansiBrightGreen, var(--vscode-terminal-ansiGreen));
    font-weight: 600;
  }
  .line.pretty-dio-block .dio-status {
    color: var(--vscode-terminal-ansiBrightYellow, var(--vscode-terminal-ansiYellow));
    font-weight: 600;
  }
  .line.pretty-dio-block .dio-uri {
    color: var(--vscode-terminal-ansiCyan, var(--vscode-terminal-ansiBrightCyan));
    cursor: default;
  }
  .line.pretty-dio-block .dio-section {
    color: var(--vscode-terminal-ansiMagenta, var(--vscode-terminal-ansiBrightMagenta));
    font-weight: 600;
    font-style: normal;
    opacity: 1;
  }
  .line.pretty-dio-block .dio-hdr-key {
    color: var(--vscode-terminal-ansiCyan, var(--vscode-terminal-ansiBrightCyan));
  }
  .line.pretty-dio-block .dio-json-key {
    color: var(--vscode-symbolIcon-propertyForeground, var(--vscode-terminal-ansiBlue));
  }
  .line.pretty-dio-block .dio-json-str {
    color: var(--vscode-terminal-ansiYellow, var(--vscode-terminal-ansiBrightYellow));
  }
  .line.pretty-dio-block .dio-json-num {
    color: var(--vscode-terminal-ansiBrightMagenta, var(--vscode-terminal-ansiMagenta));
  }
  .line.pretty-dio-block .dio-json-bool {
    color: var(--vscode-terminal-ansiBrightBlue, var(--vscode-terminal-ansiBlue));
  }
  .line.pretty-dio-block .dio-json-punct {
    color: var(--vscode-debugConsole-sourceForeground);
    opacity: .75;
  }
  .line.pretty-dio-block .dio-null {
    color: var(--vscode-debugConsole-sourceForeground);
    font-style: italic;
    opacity: .85;
  }
  .line.pretty-dio-block .dio-curl-cmd {
    color: var(--vscode-terminal-ansiBrightMagenta, var(--vscode-terminal-ansiMagenta));
    font-weight: 600;
  }
  .line.pretty-dio-block .dio-curl-flag {
    color: var(--vscode-terminal-ansiBrightYellow, var(--vscode-terminal-ansiYellow));
  }
  .line.pretty-dio-block .dio-timing {
    color: var(--vscode-terminal-ansiBrightBlue, var(--vscode-terminal-ansiBlue));
  }
  .line.pretty-dio-block .dio-label {
    color: var(--vscode-debugConsole-sourceForeground);
    opacity: .9;
  }
  /* Lines detected via ANSI: let parseAnsi() drive the color, don't override */
  .ansi-source { color: inherit; }

  /* logger PrettyPrinter box — compact, Android Studio style */
  .line.logger-block { line-height: 1.35; }
  .line.logger-block.logger-frame { opacity: .82; }
  .line.logger-block .file-link {
    color: var(--vscode-textLink-foreground);
    text-decoration: underline;
    text-decoration-style: solid;
    text-underline-offset: 2px;
  }
  .line.logger-block .file-link:hover {
    color: var(--vscode-textLink-activeForeground);
  }

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

  /* ── Context menu (right-click) ───────────────────────── */
  .ctx-menu {
    position: fixed;
    z-index: 1000;
    min-width: 168px;
    background: var(--vscode-menu-background);
    color: var(--vscode-menu-foreground);
    border: 1px solid var(--vscode-menu-border, var(--vscode-widget-border));
    box-shadow: 0 2px 8px rgba(0, 0, 0, .36);
    padding: 4px 0;
    border-radius: 5px;
  }
  .ctx-menu[hidden] { display: none; }
  .ctx-item {
    display: block;
    width: 100%;
    text-align: left;
    background: transparent;
    border: none;
    padding: 5px 18px;
    color: inherit;
    cursor: pointer;
    font: inherit;
    font-size: 13px;
    border-radius: 0;
  }
  .ctx-item:hover:not(:disabled) {
    background: var(--vscode-menu-selectionBackground);
    color: var(--vscode-menu-selectionForeground, var(--vscode-menu-foreground));
  }
  .ctx-item:disabled { opacity: .45; cursor: default; }
  .ctx-sep {
    height: 1px;
    margin: 4px 0;
    background: var(--vscode-menu-separatorBackground, var(--vscode-panel-border));
  }
</style>
</head>
<body>
<div class="root">
  <div class="toolbar-filter">
    <div class="filter-wrap">
      <svg class="filter-icon" xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
        <path d="M11.742 10.344a6.5 6.5 0 1 0-1.397 1.398h-.001l3.85 3.85a1 1 0 0 0 1.415-1.414l-3.85-3.85zm-5.242 1.156a5 5 0 1 1 0-10 5 5 0 0 1 0 10z"/>
      </svg>
      <input id="search" type="text" spellcheck="false"
        placeholder="Filter (e.g. text, !exclude) or ↑↓ for history" />
    </div>
    <div class="search-options">
      <button class="opt-btn has-tip" id="optCase" type="button">
        Cc
        <span class="tip-popup" role="tooltip">
          <span class="tip-head"><span>Match Case</span><span class="tip-keys">⌥C</span></span>
          <span class="tip-body">Use Tab to focus on an option, and Space to toggle it.</span>
        </span>
      </button>
      <button class="opt-btn has-tip" id="optWord" type="button">
        W
        <span class="tip-popup" role="tooltip">
          <span class="tip-head"><span>Words</span><span class="tip-keys">⌥W</span></span>
          <span class="tip-body">Use Tab to focus on an option, and Space to toggle it.</span>
        </span>
      </button>
      <button class="opt-btn has-tip" id="optRegex" type="button">
        .*
        <span class="tip-popup" role="tooltip">
          <span class="tip-head"><span>Regex</span><span class="tip-keys">⌥R</span></span>
          <span class="tip-body">Use Tab to focus on an option, and Space to toggle it.</span>
        </span>
      </button>
    </div>
    <button id="prev" class="btn-icon has-tip" type="button">
      <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 16 16" fill="currentColor"><path d="M8 5L13.5 11h-11L8 5z"/></svg>
      <span class="tip-popup" role="tooltip">
        <span class="tip-head"><span>Previous Match</span><span class="tip-keys">⇧↩</span></span>
        <span class="tip-body">Jump to the previous filter match in the log output.</span>
      </span>
    </button>
    <button id="next" class="btn-icon has-tip" type="button">
      <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 16 16" fill="currentColor"><path d="M8 11L2.5 5h11L8 11z"/></svg>
      <span class="tip-popup" role="tooltip">
        <span class="tip-head"><span>Next Match</span><span class="tip-keys">↩</span></span>
        <span class="tip-body">Jump to the next filter match in the log output.</span>
      </span>
    </button>
    <span id="matchStats"></span>
    <div class="spacer"></div>
    <span class="tip-select-wrap has-tip">
      <select id="category">
        <option value="all">All</option>
        <option value="stdout">stdout</option>
        <option value="stderr">stderr</option>
        <option value="console">console</option>
        <option value="warn">warn</option>
        <option value="telemetry">telemetry</option>
        <option value="important">important</option>
        <option value="network">API / [log]</option>
      </select>
      <span class="tip-popup" role="tooltip">
        <span class="tip-head"><span>Category Filter</span></span>
        <span class="tip-body">Show only logs of the selected type — stdout, stderr, warn, API / [log] (flutter_pretty_dio_logger), etc.</span>
      </span>
    </span>
    <button id="wrap" class="btn-icon has-tip" type="button">
      <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
        <rect x="2" y="3" width="12" height="1.4" rx="0.7"/>
        <rect x="2" y="11.6" width="4" height="1.4" rx="0.7"/>
        <path d="M2 7h9.5a2.75 2.75 0 0 1 0 5.5H10v1.7l-3-2.4 3-2.4v1.7h1.5a1.35 1.35 0 0 0 0-2.7H2V7z"/>
      </svg>
      <span class="tip-popup" role="tooltip">
        <span class="tip-head"><span>Soft Wrap</span></span>
        <span class="tip-body">Toggle wrapping long lines. When off, scroll horizontally to read full lines.</span>
      </span>
    </button>
    <button id="stick" class="btn-icon has-tip" type="button">
      <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
        <path d="M8 11.5L2.5 6h11L8 11.5z"/>
        <rect x="2" y="13" width="12" height="1.5" rx="0.75"/>
      </svg>
      <span class="tip-popup" role="tooltip">
        <span class="tip-head"><span>Scroll to the End</span></span>
        <span class="tip-body">Auto-follow new logs at the bottom. Scrolling up releases the lock; scroll back down to re-engage.</span>
      </span>
    </button>
    <button id="clear" class="btn-icon has-tip" type="button">
      <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 16 16" fill="currentColor">
        <path d="M10 3h3v1h-1v9l-1 1H4l-1-1V4H2V3h3V2a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1v1zm-1 0V2H6v1h3zM4 13h7V4H4v9zm2-8H5v7h1V5zm1 0h1v7H7V5zm2 0h1v7H9V5z"/>
      </svg>
      <span class="tip-popup" role="tooltip">
        <span class="tip-head"><span>Clear Console</span></span>
        <span class="tip-body">Remove all log lines from the console. Right-click the log area for Clear Log as well.</span>
      </span>
    </button>
  </div>
  <div id="logsWrap"><div id="logs"></div></div>
</div>
<div id="tipHost" hidden aria-hidden="true"></div>
<div id="ctxMenu" class="ctx-menu" hidden>
  <button class="ctx-item" id="ctxCopy" type="button">Copy</button>
  <div class="ctx-sep"></div>
  <button class="ctx-item" id="ctxClear" type="button">Clear Log</button>
</div>
<script nonce="${nonce}">
(function () {
  'use strict';
  const vscode = acquireVsCodeApi();

  // ── DOM refs ──────────────────────────────────────────────
  const logsWrap   = document.getElementById('logsWrap');
  const logsEl     = document.getElementById('logs');
  const searchEl   = document.getElementById('search');
  const categoryEl = document.getElementById('category');
  const matchStats = document.getElementById('matchStats');
  const clearBtn   = document.getElementById('clear');
  const stickBtn   = document.getElementById('stick');
  const wrapBtn    = document.getElementById('wrap');
  const nextBtn    = document.getElementById('next');
  const prevBtn    = document.getElementById('prev');
  const ctxMenu        = document.getElementById('ctxMenu');
  const ctxCopy        = document.getElementById('ctxCopy');
  const ctxClear       = document.getElementById('ctxClear');
  const optCase  = document.getElementById('optCase');
  const optWord  = document.getElementById('optWord');
  const optRegex = document.getElementById('optRegex');

  let tooltipDurationMs = ${tooltipDurationMs};

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

  // ── Filter bar (always visible) ─────────────────────────
  const filterHistory = [];
  let filterHistoryIdx = -1;

  function focusFilter(prefill) {
    if (prefill != null) searchEl.value = prefill;
    searchEl.focus();
    searchEl.select();
    scheduleHighlight();
  }

  function pushFilterHistory(q) {
    const trimmed = q.trim();
    if (!trimmed) return;
    if (filterHistory[0] === trimmed) return;
    filterHistory.unshift(trimmed);
    if (filterHistory.length > 20) filterHistory.pop();
    filterHistoryIdx = -1;
  }

  // ── State ─────────────────────────────────────────────────
  let logs            = [];   // [{session, category, output(raw)}]
  let matchNodes      = [];
  let currentMatchIdx = -1;
  let pendingItems    = [];
  let flushTimer      = null;
  let highlightTimer  = null;
  let autoStickBottom = true;

  // Soft wrap — persisted across webview reloads
  const savedState = vscode.getState() || {};
  let softWrap = savedState.softWrap !== false; // default: on

  function updateToggleUI() {
    stickBtn.classList.toggle('active', autoStickBottom);
    wrapBtn.classList.toggle('active', softWrap);
    logsEl.classList.toggle('nowrap', !softWrap);
  }

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

  // xterm-256 palette → CSS. 0-15 map to the terminal theme vars, the rest
  // follow the standard xterm color-cube / grayscale formulas.
  const ANSI_16 = [30, 31, 32, 33, 34, 35, 36, 37, 90, 91, 92, 93, 94, 95, 96, 97];
  function ansi256ToCss(n) {
    if (n == null || isNaN(n) || n < 0 || n > 255) return null;
    if (n < 16) return ANSI_FG[ANSI_16[n]];
    if (n < 232) {
      const v = [0, 95, 135, 175, 215, 255];
      const i = n - 16;
      return 'rgb(' + v[Math.floor(i / 36)] + ',' + v[Math.floor(i / 6) % 6] + ',' + v[i % 6] + ')';
    }
    const g = 8 + 10 * (n - 232);
    return 'rgb(' + g + ',' + g + ',' + g + ')';
  }

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
      for (let ci = 0; ci < codes.length; ci++) {
        const c = codes[ci];
        if (c === 0)  { st = { fg: null, bold: false, dim: false, italic: false, underline: false }; }
        else if (c === 1)  { st = { ...st, bold: true }; }
        else if (c === 2)  { st = { ...st, dim: true }; }
        else if (c === 3)  { st = { ...st, italic: true }; }
        else if (c === 4)  { st = { ...st, underline: true }; }
        else if (c === 22) { st = { ...st, bold: false, dim: false }; }
        else if (c === 23) { st = { ...st, italic: false }; }
        else if (c === 24) { st = { ...st, underline: false }; }
        else if (c === 39) { st = { ...st, fg: null }; }
        else if (c === 38 || c === 48) {
          // Extended color: 38;5;n (256-color) or 38;2;r;g;b (truecolor).
          // 48 (background) is consumed but ignored.
          const mode = codes[ci + 1];
          if (mode === 5) {
            if (c === 38) {
              const css = ansi256ToCss(codes[ci + 2]);
              if (css) st = { ...st, fg: css };
            }
            ci += 2;
          } else if (mode === 2) {
            if (c === 38) {
              st = { ...st, fg: 'rgb(' + codes[ci + 2] + ',' + codes[ci + 3] + ',' + codes[ci + 4] + ')' };
            }
            ci += 4;
          }
        }
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
  function overlapsHttpUrl(plain, start, end) {
    const urlRe = /https?:\\/\\/[^\\s)\\]>"]+/g;
    let um;
    while ((um = urlRe.exec(plain)) !== null) {
      if (start < um.index + um[0].length && end > um.index) return true;
    }
    return false;
  }

  function findFileLinks(plain) {
    const results = [];
    const seen = (s, e) => results.some(r => s < r.end && e > r.start);
    const push = (entry) => {
      if (seen(entry.start, entry.end)) return;
      if (overlapsHttpUrl(plain, entry.start, entry.end)) return;
      results.push(entry);
    };

    // package:pkg/path.dart:line:col (also inside stack-trace parens)
    const pkgRe = /package:([\\w_]+)\\/([\\w/.\\-]+\\.dart)(?::(\\d+)(?::(\\d+))?)?/g;
    let m;
    while ((m = pkgRe.exec(plain)) !== null) {
      push({ start: m.index, end: m.index + m[0].length,
        pkg: m[1], pkgPath: m[2],
        path: 'lib/' + m[2],
        line: +(m[3] ?? 1), col: +(m[4] ?? 1), label: m[0] });
    }

    // file:///absolute/path.dart:line:col (Flutter widget dumps — spaces after colons allowed)
    const fileUriRe = /file:\\/\\/([^\\s)]+\.dart)(?::\\s*(\\d+))?(?::\\s*(\\d+))?/g;
    while ((m = fileUriRe.exec(plain)) !== null) {
      const fsPath = decodeURIComponent(m[1]);
      push({ start: m.index, end: m.index + m[0].length,
        path: fsPath,
        line: +(m[2] ?? 1), col: +(m[3] ?? 1), label: m[0] });
    }

    // Absolute or relative paths like lib/foo.dart:12:3 or /abs/path/file.dart:5
    const pathRe = /((?:[a-zA-Z]:[\\\\/]|\\/|\\.{1,2}\\/)?(?:[\\w.\\-]+\\/)*[\\w.\\-]+\\.(?:dart|ts|tsx|js|jsx|py|go|java|kt|swift|cpp|c|h|cs|rb|rs))(?::(\\d+)(?::(\\d+))?)?/g;
    while ((m = pathRe.exec(plain)) !== null) {
      // Skip false positives like s:/ or p:/ inside http:// or https://
      if (/[a-zA-Z]$/.test(plain.slice(0, m.index))) continue;
      push({ start: m.index, end: m.index + m[0].length,
        path: m[1], line: +(m[2] ?? 1), col: +(m[3] ?? 1), label: m[0] });
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

  // Strip redundant flutter: / [log] prefix for compact display
  function normalizeDisplayText(raw, item) {
    if (!item?.loggerBlock && !item?.prettyDioBlock) return raw;
    return raw.replace(/^flutter:\\s?/, '').replace(/^\\[log\\]\\s?/, '');
  }

  function dioPhaseClass(plain) {
    if (/onError/i.test(plain)) return 'dio-phase-err';
    if (/onResponse/i.test(plain)) return 'dio-phase-res';
    if (/onRequest/i.test(plain)) return 'dio-phase-req';
    return '';
  }

  function decoratePrettyDioHtml(html, plain) {
    let out = html;

    // BEGIN/END frame rulers
    out = out.replace(/(=+\\s*onRequest\\s*=+\\s*(?:BEGIN|END)\\s*=+)/gi,
      '<span class="dio-frame dio-phase-req">$1</span>');
    out = out.replace(/(=+\\s*onResponse\\s*=+\\s*(?:BEGIN|END)\\s*=+)/gi,
      '<span class="dio-frame dio-phase-res">$1</span>');
    out = out.replace(/(=+\\s*onError\\s*=+\\s*(?:BEGIN|END)\\s*=+)/gi,
      '<span class="dio-frame dio-phase-err">$1</span>');

    // Request / Response / DioError header lines
    out = out.replace(/\\b(Request)\\s*([║|])\\s*(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\\b/gi,
      '<span class="dio-kind-req">$1</span> $2 <span class="dio-method">$3</span>');
    out = out.replace(/\\b(Response)\\s*([║|])\\s*(\\d{3})?/gi, (m, kind, sep, code) =>
      '<span class="dio-kind-res">' + kind + '</span> ' + sep +
      (code ? ' <span class="dio-status">' + code + '</span>' : ''));
    out = out.replace(/\\b(DioError)\\s*([║|])/gi,
      '<span class="dio-kind-err">$1</span> $2');

    // Uri line
    out = out.replace(/(Uri\\s*([║|])\\s*)(https?:\\/\\/[^\\s<&]+)/g,
      '<span class="dio-label">Uri</span> $2 <span class="dio-uri">$3</span>');

    // Section markers
    out = out.replace(/(\\[---(?:requestHeader|requestBody|responseHeader|responseBody|queryParameters|cURL|FormData)---\\])/gi,
      '<span class="dio-section">$1</span>');

    // Processing time (before generic header-key pass)
    out = out.replace(/(Processing Time:\\s*)([\\d.]+\\s*m?s)/i,
      '$1<span class="dio-timing">$2</span>');

    // JSON keys / string values / numbers / booleans / null
    out = out.replace(/&quot;([^&]+)&quot;\\s*:/g,
      '<span class="dio-json-key">&quot;$1&quot;</span>:');
    out = out.replace(/:\\s*&quot;([^&]*)&quot;/g,
      ': <span class="dio-json-str">&quot;$1&quot;</span>');
    out = out.replace(/(?<=^|[\\s,{\\[])(&quot;([^&]+)&quot;)(?=[\\s,}\\]])/g,
      '<span class="dio-json-str">$1</span>');
    out = out.replace(/:\\s*(-?\\d+(?:\\.\\d+)?)(?=[\\s,}\\]<]|$)/g,
      ': <span class="dio-json-num">$1</span>');
    out = out.replace(/(?<=^|[\\s,{\\[])(-?\\d+(?:\\.\\d+)?)(?=[\\s,}\\]]|$)/g,
      '<span class="dio-json-num">$1</span>');
    out = out.replace(/:\\s*(true|false)\\b/g,
      ': <span class="dio-json-bool">$1</span>');
    out = out.replace(/:\\s*(null)\\b/g,
      ': <span class="dio-null">$1</span>');
    out = out.replace(/([{[\\]}])/g, '<span class="dio-json-punct">$1</span>');

    // cURL command
    out = out.replace(/\\bcurl\\b/g, '<span class="dio-curl-cmd">curl</span>');
    out = out.replace(/\\s(-H|-X|-d|--data(?:-raw|-binary|-urlencode)?|--compressed)\\b/g,
      ' <span class="dio-curl-flag">$1</span>');

    // HTTP header keys at line start (Content-Type: …)
    out = out.replace(/^(\\s*[-–]?\\s*)([A-Za-z][\\w-]*)(:\\s*)/g,
      '$1<span class="dio-hdr-key">$2</span>$3');

    // Standalone http(s) URLs (cURL, error messages) — styled only, not clickable
    out = out.replace(/https?:\\/\\/[^\\s<&]+/g, (match, offset, str) => {
      const ctx = str.slice(Math.max(0, offset - 24), offset + match.length + 8);
      if (/dio-uri/.test(ctx)) return match;
      return '<span class="dio-uri">' + match + '</span>';
    });

    return out;
  }

  function isLoggerFrameLine(plain) {
    const t = plain.trim();
    if (/^[┌└├│]/.test(t)) return true;
    if (/^[─\\-]{4,}$/.test(t)) return true;
    return false;
  }

  // ── DOM helpers ───────────────────────────────────────────
  function isNearBottom() {
    return logsWrap.scrollTop + logsWrap.clientHeight >= logsWrap.scrollHeight - 32;
  }
  function scrollToBottom() { logsWrap.scrollTop = logsWrap.scrollHeight; }

  function updateStats() {
    const q = searchEl.value.trim();
    if (matchNodes.length > 0) {
      const idx = currentMatchIdx >= 0 ? (currentMatchIdx + 1) + '/' + matchNodes.length : matchNodes.length;
      matchStats.textContent = idx + (matchNodes.length === 1 ? ' result' : ' results');
    } else if (q) {
      matchStats.textContent = '0 results';
    } else {
      matchStats.textContent = logs.length ? logs.length + ' lines' : '';
    }
  }

  function isForcedCategoryColor(item) {
    return item.category === 'stderr' || item.category === 'warn';
  }

  function isDioStyledLine(item) {
    return item.prettyDioBlock || item.category === 'network';
  }

  function renderItemHtml(item, query) {
    const displayRaw = normalizeDisplayText(item.output, item);
    const plain = stripAnsi(displayRaw);
    const forced = isForcedCategoryColor(item);
    const dioStyled = isDioStyledLine(item);

    if (forced && !query) {
      if (dioStyled) {
        return decoratePrettyDioHtml(escHtml(plain), plain);
      }
      return findFileLinks(plain).length
        ? renderLineHtml(plain, null).html
        : escHtml(plain);
    }
    if (dioStyled && !query) {
      return decoratePrettyDioHtml(escHtml(plain), plain);
    }
    if (query) {
      let html = renderLineHtml(displayRaw, query).html;
      if (dioStyled && !forced) html = decoratePrettyDioHtml(html, plain);
      return html;
    }
    const segs = parseAnsi(displayRaw);
    if (segs.length === 1 && !segs[0].fg && !segs[0].bold && !segs[0].dim && !segs[0].italic && !segs[0].underline) {
      const links = findFileLinks(segs[0].text);
      return links.length ? renderLineHtml(displayRaw, null).html : escHtml(segs[0].text);
    }
    return renderLineHtml(displayRaw, null).html;
  }

  function createLineEl(item, query) {
    const div = document.createElement('div');
    const displayRaw = normalizeDisplayText(item.output, item);
    const forced = isForcedCategoryColor(item);
    const dioStyled = isDioStyledLine(item);
    let cls = 'line ' + item.category + (item.ansiSource && !forced ? ' ansi-source' : '');
    if (item.loggerBlock) {
      cls += ' logger-block';
      if (item.loggerFrame || isLoggerFrameLine(stripAnsi(displayRaw))) cls += ' logger-frame';
    }
    if (dioStyled && !forced) {
      cls += ' pretty-dio-block';
      if (item.prettyDioFrame) {
        cls += ' pretty-dio-frame';
        const phase = dioPhaseClass(stripAnsi(displayRaw));
        if (phase) cls += ' ' + phase;
      }
    }
    div.className = cls;
    div.dataset.category = item.category;
    div.innerHTML = renderItemHtml(item, query);
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

      const displayRaw = normalizeDisplayText(item.output, item);
      const html = renderItemHtml(item, query);
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

  function clearLogs() {
    vscode.postMessage({ type: 'clear' });
  }

  function hideCtxMenu() {
    ctxMenu.hidden = true;
  }

  function showCtxMenu(x, y) {
    const sel = window.getSelection()?.toString() ?? '';
    ctxCopy.disabled = !sel.trim();
    ctxMenu.hidden = false;
    ctxMenu.style.left = x + 'px';
    ctxMenu.style.top = y + 'px';
    requestAnimationFrame(() => {
      const rect = ctxMenu.getBoundingClientRect();
      if (rect.right > window.innerWidth) {
        ctxMenu.style.left = Math.max(0, x - rect.width) + 'px';
      }
      if (rect.bottom > window.innerHeight) {
        ctxMenu.style.top = Math.max(0, y - rect.height) + 'px';
      }
    });
  }

  clearBtn.addEventListener('click', clearLogs);
  ctxClear.addEventListener('click', () => { hideCtxMenu(); clearLogs(); });
  ctxCopy.addEventListener('click', async () => {
    const sel = window.getSelection()?.toString();
    if (sel) {
      try { await navigator.clipboard.writeText(sel); }
      catch { document.execCommand('copy'); }
    }
    hideCtxMenu();
  });

  logsWrap.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    showCtxMenu(e.clientX, e.clientY);
  });
  document.addEventListener('click', hideCtxMenu);
  document.addEventListener('scroll', hideCtxMenu, true);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') hideCtxMenu();
  });

  stickBtn.addEventListener('click', () => {
    autoStickBottom = !autoStickBottom;
    if (autoStickBottom) scrollToBottom();
    updateToggleUI();
  });
  wrapBtn.addEventListener('click', () => {
    softWrap = !softWrap;
    vscode.setState({ ...(vscode.getState() || {}), softWrap });
    updateToggleUI();
  });
  nextBtn.addEventListener('click', () => setCurrentMatch(currentMatchIdx + 1));
  prevBtn.addEventListener('click', () => setCurrentMatch(currentMatchIdx - 1));
  logsWrap.addEventListener('scroll', () => {
    autoStickBottom = isNearBottom();
    updateToggleUI();
  });
  updateToggleUI();

  // ── Toolbar hover tooltips (fixed #tipHost — survives body overflow:hidden) ──
  (function initTooltips() {
    const host = document.getElementById('tipHost');
    if (!host) return;
    let hideTimer = null;
    let autoHideTimer = null;

    function hideTip() {
      clearTimeout(hideTimer);
      clearTimeout(autoHideTimer);
      hideTimer = null;
      autoHideTimer = null;
      host.hidden = true;
      host.setAttribute('aria-hidden', 'true');
    }

    function showTip(el) {
      const popup = el.querySelector('.tip-popup');
      if (!popup) return;
      clearTimeout(hideTimer);
      clearTimeout(autoHideTimer);
      hideTimer = null;
      autoHideTimer = null;
      host.innerHTML = popup.innerHTML;
      host.hidden = false;
      host.setAttribute('aria-hidden', 'false');
      const r = el.getBoundingClientRect();
      host.style.left = (r.left + r.width / 2) + 'px';
      host.style.top = (r.bottom + 6) + 'px';
      host.style.transform = 'translateX(-50%)';
      requestAnimationFrame(() => {
        const hr = host.getBoundingClientRect();
        let left = r.left + r.width / 2;
        if (hr.right > window.innerWidth - 6) left -= hr.right - window.innerWidth + 6;
        if (hr.left < 6) left += 6 - hr.left;
        host.style.left = left + 'px';
      });
      if (tooltipDurationMs > 0) {
        autoHideTimer = setTimeout(hideTip, tooltipDurationMs);
      }
    }

    document.querySelectorAll('.has-tip').forEach((el) => {
      el.addEventListener('mouseenter', () => showTip(el));
      el.addEventListener('mouseleave', () => { hideTimer = setTimeout(hideTip, 60); });
      el.addEventListener('focusin', () => showTip(el));
      el.addEventListener('focusout', () => { hideTimer = setTimeout(hideTip, 60); });
    });
  })();

  // Filter input: Enter/Shift+Enter navigate, ↑↓ history, ESC clear
  searchEl.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      searchEl.value = '';
      filterHistoryIdx = -1;
      applyFilterAndHighlight();
      searchEl.blur();
      return;
    }
    if (e.key === 'ArrowUp') {
      if (!filterHistory.length) return;
      e.preventDefault();
      filterHistoryIdx = Math.min(filterHistoryIdx + 1, filterHistory.length - 1);
      searchEl.value = filterHistory[filterHistoryIdx];
      scheduleHighlight();
      return;
    }
    if (e.key === 'ArrowDown') {
      if (filterHistoryIdx <= 0) {
        if (filterHistoryIdx === 0) { searchEl.value = ''; filterHistoryIdx = -1; scheduleHighlight(); }
        return;
      }
      e.preventDefault();
      filterHistoryIdx--;
      searchEl.value = filterHistory[filterHistoryIdx];
      scheduleHighlight();
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      pushFilterHistory(searchEl.value);
      setCurrentMatch(e.shiftKey ? currentMatchIdx - 1 : currentMatchIdx + 1);
    }
  });

  // Cmd+F / Ctrl+F → focus filter, prefill selection
  document.addEventListener('keydown', (e) => {
    if (!(e.metaKey || e.ctrlKey) || e.key !== 'f') return;
    e.preventDefault();
    const sel = window.getSelection()?.toString().trim() || null;
    focusFilter(sel);
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
      if (typeof msg.tooltipDurationMs === 'number') tooltipDurationMs = msg.tooltipDurationMs;
      rebuildAll();
      return;
    }
    if (msg.type === 'config') {
      if (typeof msg.tooltipDurationMs === 'number') tooltipDurationMs = msg.tooltipDurationMs;
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
  const t = stripFlutterPrefix(stripAnsi(output));
  return /\.dart:\d+:\d+:.*\b(Error|Context)\b/i.test(t) ||
    /^lib\/[\w/.-]+\.dart:\d+:\d+:\s*\bError\b/i.test(t);
}

/** Source snippet / caret line following a Dart compile error. */
function isDartCompileContinuation(stripped: string): boolean {
  const t = stripFlutterPrefix(stripAnsi(stripped));
  if (/^\s*\^+\s*$/.test(t)) return true;
  if (/^\s{2,}\S/.test(t) && !/^lib\//.test(t) && !isPrettyDioLine(stripped) && !isDeveloperLogLine(stripped)) {
    return true;
  }
  return false;
}

/** Dart/Flutter VM stack-trace frame or related error context line. */
function isStackTraceLine(stripped: string): boolean {
  const t = stripFlutterPrefix(stripped);
  return /^When the exception was thrown/.test(t) ||
    /Failed assertion:/i.test(t) ||
    /Assertion failed:/i.test(t) ||
    /^AssertionError\b/.test(t) ||
    /'package:flutter\/src\//.test(t) ||
    /^\s*#\d+\s/.test(t) ||
    /^\#\d+\s/.test(t.trim()) ||
    /\(package:[\w_]+\/[\w/.-]+\.dart:\d+:\d+\)/.test(t) ||
    /^The relevant error-causing widget was:/.test(t) ||
    /^The overflowing /i.test(t) ||
    /^Consider applying a flex factor/i.test(t) ||
    /^See also:/.test(t) ||
    /^During handling (?:of )?this exception/i.test(t) ||
    /^… \d+ lines skipped …/.test(t);
}

/** Start of a Flutter framework diagnostic block (exception or assert). */
function isFlutterDiagnosticStart(stripped: string): boolean {
  const t = stripDeveloperLogPrefix(stripped);
  return /^The following assertion was thrown/i.test(t) ||
    /^The following .+ error occurred/i.test(t);
}

/** Flutter framework error box header (═══ Exception caught by … ═══). */
function isFlutterErrorBoxHeader(stripped: string): boolean {
  const t = stripDeveloperLogPrefix(stripped);
  return /══╡ EXCEPTION CAUGHT BY/i.test(t) ||
    /═+\s*Exception caught by/i.test(t) ||
    (/Exception caught by/i.test(t) && /═{2,}/.test(t)) ||
    isFlutterDiagnosticStart(stripped);
}

function isFlutterErrorBoxFooter(stripped: string): boolean {
  const t = stripDeveloperLogPrefix(stripped).trim();
  return /^═{10,}$/.test(t);
}

/** Remove Flutter print prefix for pattern matching. */
function stripFlutterPrefix(s: string): string {
  return stripAnsi(s).replace(/^flutter:\s?/, '');
}

/** logger PrettyPrinter box line (border, stack frame, message inside a box). */
function isLoggerBoxLine(stripped: string): boolean {
  const t = stripFlutterPrefix(stripped).trimStart();
  if (/^[┌└├│]/.test(t)) return true;
  if (/^[─\-]{4,}$/.test(t)) return true;
  if (/^\s*#\d+\s/.test(t)) return true;
  if (/^[🐛💡⚠⛔👾]/.test(t.trim())) return true;
  return false;
}

function isLoggerBoxStart(stripped: string): boolean {
  return /┌/.test(stripFlutterPrefix(stripped));
}

function isLoggerBoxEnd(stripped: string): boolean {
  return /└/.test(stripFlutterPrefix(stripped));
}

function isLoggerFrameLine(stripped: string): boolean {
  const t = stripFlutterPrefix(stripped).trim();
  return /^[┌└├│]/.test(t) || /^[─\-]{4,}$/.test(t);
}

/** Map logger PrettyPrinter ANSI 256-color codes → category. */
function loggerCategoryFromAnsi(output: string): { category: string; ansiSource: boolean } | null {
  const m = output.match(/\x1b\[38;5;(\d+)m/);
  if (m) {
    const n = parseInt(m[1], 10);
    if (n === 244 || n === 245 || n === 246) return { category: 'telemetry', ansiSource: true };
    if ([12, 39, 45, 51, 27, 33, 38, 75].includes(n)) return { category: 'console', ansiSource: true };
    if ([46, 82, 118, 42, 35, 40, 76].includes(n)) return { category: 'stdout', ansiSource: true };
    if (n === 208 || n === 214 || n === 226 || n === 220) return { category: 'warn', ansiSource: true };
    if (n === 196 || n === 197 || n === 203) return { category: 'stderr', ansiSource: true };
    if (n === 199 || n === 200 || n === 201) return { category: 'stderr', ansiSource: true };
  }
  if (/\x1b\[(?:34|36|94|96)m/.test(output)) return { category: 'console', ansiSource: true };
  if (/\x1b\[(?:32|92)m/.test(output)) return { category: 'stdout', ansiSource: true };
  if (/\x1b\[(?:33|93)m/.test(output)) return { category: 'warn', ansiSource: true };
  if (/\x1b\[(?:31|91)m/.test(output)) return { category: 'stderr', ansiSource: true };
  return null;
}

/** logger emoji → category (PrettyPrinter fallback when ANSI stripped). */
function loggerCategoryFromEmoji(stripped: string): { category: string; ansiSource: boolean } | null {
  const t = stripFlutterPrefix(stripped);
  if (/🐛/.test(t)) return { category: 'console', ansiSource: true };
  if (/💡/.test(t)) return { category: 'stdout', ansiSource: true };
  if (/⚠/.test(t)) return { category: 'warn', ansiSource: true };
  if (/⛔/.test(t)) return { category: 'stderr', ansiSource: true };
  if (/👾/.test(t)) return { category: 'stderr', ansiSource: true };
  return null;
}

/**
 * Layer 1: classify by ANSI escape color embedded by the tool itself.
 * - Dart compiler colors errors red, warnings yellow.
 * - logger package uses 256-color: 196/199 (red/pink) for e/f, 208 (orange) for w, 12/39 (blue) for d/i.
 * Returns category hint or null (null = no ANSI color hint found).
 */
function classifyByAnsi(output: string): 'stderr' | 'warn' | 'stdout' | 'console' | 'telemetry' | null {
  const logger = loggerCategoryFromAnsi(output);
  if (logger) return logger.category as 'stderr' | 'warn' | 'stdout' | 'console' | 'telemetry';
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

/** Dart / Flutter error patterns — dart.dev/language/error-handling + docs.flutter.dev/testing/errors */
function matchesDartFlutterError(text: string): boolean {
  const t = stripDeveloperLogPrefix(text);
  return (
    // Android logcat
    /^[EF]\/flutter\s*\(\s*\d+\s*\):/.test(t) ||
    /^E\/AndroidRuntime\s*\(\s*\d+\s*\):/.test(t) ||
    /^FATAL EXCEPTION:/.test(t) ||
    // Flutter framework error / assert boxes
    /══╡ EXCEPTION CAUGHT BY/.test(t) ||
    (/Exception caught by/i.test(t) && /═{2,}/.test(t)) ||
    /^The following assertion was thrown/i.test(t) ||
    /^The following .+ (was thrown|error occurred)/i.test(t) ||
    /^Another exception was thrown:/.test(t) ||
    /^When the exception was thrown/.test(t) ||
    /Failed assertion:/i.test(t) ||
    /Assertion failed:/i.test(t) ||
    /^AssertionError\b/.test(t) ||
    /\bDartError\b/.test(t) ||
    // Dart VM / async / platform
    /^Unhandled Exception:/i.test(t) ||
    /^flutter: Unhandled Exception:/.test(text) ||
    /^(?:Exception|Error|FormatException|StateError|RangeError|TypeError|NoSuchMethodError|ArgumentError|AssertionError|LateInitializationError|UnimplementedError|StackOverflowError|ConcurrentModificationError|UnsupportedError|NullThrownError|MissingPluginException|PlatformException|FlutterError|OutOfMemoryError|ClientException|HandshakeException|SocketException|HttpException|ProviderException|CircularDependencyError|DartError):/.test(t) ||
    /^flutter: (?:Exception|Error|FormatException|StateError|RangeError|TypeError|NoSuchMethodError|ArgumentError|AssertionError|NullThrownError|StackOverflowError|ConcurrentModificationError|UnsupportedError|LateInitializationError|MissingPluginException|PlatformException):/.test(text) ||
    // Compiler / analyzer
    /\.dart:\d+:\d+:.*\bError\b/i.test(t) ||
    /^lib\/[\w/.-]+\.dart:\d+:\d+:\s*\bError\b/i.test(t) ||
    /\.dart:\d+:\d+:.*\bContext\b/i.test(t) ||
    // Stack trace frames
    /^\s*#\d+\s/.test(t) ||
    /\(package:[\w_]+\/[\w/.-]+\.dart:\d+:\d+\)/.test(t) ||
    /^The relevant error-causing widget was:/.test(t) ||
    /^See also:/.test(t) ||
    /^During handling (?:of )?this exception/i.test(t) ||
    /^Another exception was thrown while/i.test(t) ||
    // Common Flutter layout / render failures (build/layout/paint phase)
    /^The overflowing /i.test(t) ||
    /^Consider applying a flex factor/i.test(t) ||
    /^The specific RenderFlex/i.test(t) ||
    /^Either the assertion indicates/i.test(t) ||
    /^To inspect this widget in Flutter DevTools/i.test(t) ||
    /^If (?:this message did not help|none of these)/i.test(t) ||
    /'package:flutter\/src\//.test(t) ||
    /RenderFlex overflowed/.test(t) ||
    /overflowed by \d+ pixels/.test(t) ||
    /\bwas not laid out\b/i.test(t) ||
    /viewport was given unbounded/i.test(t) ||
    /infinite (?:height|width|size)/i.test(t) ||
    /No Material(?:Localizations| widget)? found/i.test(t) ||
    /setState\(\) or markNeedsBuild\(\) called during build/i.test(t) ||
    /Looking up a deactivated widget/i.test(t) ||
    /Duplicate GlobalKey/i.test(t) ||
    /Incorrect use of ParentDataWidget/i.test(t) ||
    /Cannot hit test a render box/i.test(t) ||
    // logger emoji fallback
    /[⛔👾]/.test(t)
  );
}

/** Dart / Flutter warnings — analyzer hints, deprecations, logcat W */
function matchesDartFlutterWarn(text: string): boolean {
  const t = text.replace(/^flutter:\s?/, '');
  return (
    /^W\/flutter\s*\(\s*\d+\s*\):/.test(t) ||
    /\.dart:\d+:\d+:.*\bWarning\b/i.test(t) ||
    /\.dart:\d+:\d+:.*\bHint\b/i.test(t) ||
    /^info •/.test(t) ||
    /\bdeprecated_member_use\b/.test(t) ||
    /⚠/.test(t)
  );
}

/**
 * Layer 2: classify by text pattern (fallback when ANSI is absent, e.g. logcat strips it).
 * Returns 'stderr' | 'warn' | null.
 */
function classifyByPattern(output: string): 'stderr' | 'warn' | null {
  const text = stripAnsi(output);
  if (matchesDartFlutterError(text)) return 'stderr';
  if (matchesDartFlutterWarn(text)) return 'warn';
  return null;
}
function stripDeveloperLogPrefix(s: string): string {
  return stripAnsi(s).replace(/^flutter:\s?/, '').replace(/^\[log\]\s?/, '');
}

/** flutter_pretty_dio_logger block markers (uses dart:developer log). */
function isPrettyDioBlockStart(stripped: string): boolean {
  const t = stripDeveloperLogPrefix(stripped);
  return /=+\s*on(?:Request|Response|Error)\s*=+\s*BEGIN\s*=+/i.test(t);
}

function isPrettyDioBlockEnd(stripped: string): boolean {
  const t = stripDeveloperLogPrefix(stripped);
  return /=+\s*on(?:Request|Response|Error)\s*=+\s*END\s*=+/i.test(t);
}

function isPrettyDioBlockFrame(stripped: string): boolean {
  return isPrettyDioBlockStart(stripped) || isPrettyDioBlockEnd(stripped);
}

/** Recognise flutter_pretty_dio_logger output lines. */
function isPrettyDioLine(stripped: string): boolean {
  const t = stripDeveloperLogPrefix(stripped);
  if (isPrettyDioBlockStart(stripped) || isPrettyDioBlockEnd(stripped)) return true;
  if (/Request\s*║|Response\s*║|DioError\s*║/.test(t)) return true;
  if (/^Uri\s*║/.test(t)) return true;
  if (/\[---(?:requestHeader|requestBody|responseHeader|responseBody|queryParameters|cURL|FormData)/i.test(t)) return true;
  if (/^Processing Time:/.test(t)) return true;
  if (/^curl -i\b/.test(t)) return true;
  return false;
}

function isDeveloperLogLine(stripped: string): boolean {
  return /^flutter:\s*\[log\]/.test(stripped) || /^\[log\]/.test(stripped);
}

/** Dio block body line (JSON / headers split across lines without repeating [log]). */
function isDioBlockContinuation(stripped: string): boolean {
  const t = stripDeveloperLogPrefix(stripped);
  if (/^\s*$/.test(t)) return true;
  if (isPrettyDioLine(stripped) || isDeveloperLogLine(stripped)) return true;
  if (/^\s*[\[{]/.test(t)) return true;
  if (/^\s*[\]}],?\s*$/.test(t)) return true;
  if (/^\s*"/.test(t)) return true;
  if (/^\s*-/.test(t) && /:\s/.test(t)) return true;
  if (/^\s*#\d+\s/.test(t)) return true;
  if (/\(package:[\w_]+\/[\w/.-]+\.dart:\d+:\d+\)/.test(t)) return true;
  return false;
}

/** Dio / API log line — must not inherit Flutter error coloring. */
function isDioNetworkLine(stripped: string): boolean {
  return isPrettyDioBlockStart(stripped) || isPrettyDioBlockEnd(stripped) ||
    isPrettyDioLine(stripped) || isDioBlockContinuation(stripped);
}

/** Hot restart / reload — reset error block state so colors don't bleed. */
function isSessionResetLine(stripped: string): boolean {
  const t = stripDeveloperLogPrefix(stripped);
  return /^Restarted application in \d+/i.test(t) ||
    /^Performing hot restart/i.test(t) ||
    /^Performing hot reload/i.test(t) ||
    /^Hot reload (?:finished|complete)/i.test(t) ||
    /^Syncing files to device/i.test(t) ||
    /^Reloaded \d+ libraries/.test(t) ||
    /^Flutter run key commands\./i.test(t) ||
    /^A Dart VM Service on/i.test(t) ||
    /^The Flutter DevTools debugger/i.test(t);
}

/** Hard boundary — unrelated log family; drop all sticky block state. */
function isLogBoundaryLine(stripped: string): boolean {
  return isSessionResetLine(stripped) ||
    /^[A-Z]\/\w+\s*\(\s*\d+/.test(stripped) ||
    isPrettyDioBlockStart(stripped) ||
    isLoggerBoxStart(stripped) ||
    isFlutterErrorBoxHeader(stripped) ||
    isDartCompileLine(stripped);
}

/** Lines inside a Flutter error / assert / stack / RenderObject dump. */
function isFlutterDiagnosticContinuation(stripped: string): boolean {
  const t = stripDeveloperLogPrefix(stripped);
  if (/^\s*$/.test(t)) return true;
  if (isFlutterErrorBoxFooter(stripped)) return true;
  if (isFlutterErrorBoxHeader(stripped)) return true;
  if (isStackTraceLine(stripped)) return true;
  if (isFlutterDiagnosticStart(stripped)) return true;
  if (/^The relevant error-causing widget was:/.test(t)) return true;
  if (/^See also:/.test(t)) return true;
  if (/Failed assertion:/i.test(t) || /Assertion failed:/i.test(t)) return true;
  if (/RenderFlex overflowed|viewport was given unbounded|was not laid out/i.test(t)) return true;
  if (/Viewports expand in the cross axis|The following RenderObject was being processed/i.test(t)) return true;
  if (/^Another exception was thrown/.test(t)) return true;
  if (/^\(elided \d+ frames/.test(t)) return true;
  if (/^Render[A-Z]\w*(?:#\d+|\()/.test(t.trim())) return true;
  if (/^(creator|parentData|constraints|size|offset|transform|configuration|child|children)(?: \d+)?:/.test(t.trim())) return true;
  if (/NEEDS-LAYOUT|NEEDS-PAINT|NEEDS-COMPOSITING|MISSING|geometry is not known/i.test(t)) return true;
  if (/BoxConstraints|RenderSliver|RenderViewport|RenderObject|AxisDirection|crossAxisDirection/i.test(t)) return true;
  if (/^\s{2,}\S/.test(t)) return true;
  if (/'package:flutter\/src\//.test(t)) return true;
  if (/file:\/\/[^\s]+/.test(t)) return true;
  return false;
}

/** Any flutter_pretty_dio_logger output — ends Flutter diagnostic block. */
function isDioExclusiveLine(stripped: string): boolean {
  if (isPrettyDioBlockStart(stripped) || isPrettyDioBlockEnd(stripped)) return true;
  if (isPrettyDioLine(stripped)) return true;
  const t = stripDeveloperLogPrefix(stripped);
  if (/\[---(?:requestHeader|requestBody|responseHeader|responseBody|queryParameters|cURL|FormData)/i.test(t)) return true;
  if (/=+\s*END\s*=+/i.test(t) && /on(?:Request|Response|Error)/i.test(t)) return true;
  return false;
}

/** End Flutter diagnostic block — unrelated log family only. */
function isHardDiagnosticEnd(stripped: string): boolean {
  if (isSessionResetLine(stripped)) return true;
  if (isDioExclusiveLine(stripped)) return true;
  if (isLoggerBoxStart(stripped)) return true;
  if (isDartCompileLine(stripped)) return true;
  if (/^[A-Z]\/\w+\s*\(\s*\d+/.test(stripped)) return true;
  if (/^I\/flutter\s*\(\s*\d+\s*\):/.test(stripped)) return true;
  if (/^D\/flutter\s*\(\s*\d+\s*\):/.test(stripped)) return true;
  return false;
}

/** Per-line block flags carried across output events (must not bleed categories). */
type LogBlockState = {
  dio: boolean;
  dioError: boolean;
  compile: boolean;
  diagnostic: boolean;
  logger: boolean;
  loggerCategory: string;
  loggerAnsiSource: boolean;
};

function emptyLogBlockState(): LogBlockState {
  return {
    dio: false,
    dioError: false,
    compile: false,
    diagnostic: false,
    logger: false,
    loggerCategory: 'console',
    loggerAnsiSource: true,
  };
}

/** Drop block state when the current line clearly belongs to a different log family. */
function expireStaleBlocks(stripped: string, s: LogBlockState): LogBlockState {
  if (isLogBoundaryLine(stripped)) return { ...s, compile: false, diagnostic: false };

  const next = { ...s };

  if (next.diagnostic && isHardDiagnosticEnd(stripped)) {
    next.diagnostic = false;
  }

  if (next.compile && !isDartCompileLine(stripped) && !isDartCompileContinuation(stripped)) {
    next.compile = false;
  }

  if (next.dio) {
    if (isPrettyDioBlockEnd(stripped)) {
      next.dio = false;
      next.dioError = false;
    } else if (!isDioNetworkLine(stripped) && !isDeveloperLogLine(stripped) && !isDioBlockContinuation(stripped)) {
      next.dio = false;
      next.dioError = false;
    }
  }

  if (next.logger && isLoggerBoxEnd(stripped)) {
    next.logger = false;
  }

  return next;
}

type ClassifiedLogLine = {
  category: string;
  ansiSource: boolean;
  loggerBlock: boolean;
  loggerFrame: boolean;
  prettyDioBlock: boolean;
  prettyDioFrame: boolean;
  state: LogBlockState;
};

/** Classify one output line; block state applies only to known continuations. */
function classifyOutputLine(line: string, base: string, prev: LogBlockState): ClassifiedLogLine {
  const stripped = stripAnsi(line);
  let state = expireStaleBlocks(stripped, prev);

  if (isSessionResetLine(stripped) || /^[A-Z]\/\w+\s*\(\s*\d+/.test(stripped)) {
    state = emptyLogBlockState();
  }

  let category = base;
  let ansiSource = false;
  let loggerBlock = false;
  let loggerFrame = false;
  let prettyDioBlock = false;
  let prettyDioFrame = false;

  const logText = stripDeveloperLogPrefix(stripped);
  const dioExclusive = isDioExclusiveLine(stripped);

  // ── 1. New block starts (Dio first — must not inherit Flutter diagnostic red) ──
  if (isPrettyDioBlockStart(stripped)) {
    state = { ...emptyLogBlockState(), dio: true, dioError: /onError/i.test(logText) };
    prettyDioBlock = true;
    prettyDioFrame = true;
    category = state.dioError ? 'stderr' : 'network';
    return { category, ansiSource, loggerBlock, loggerFrame, prettyDioBlock, prettyDioFrame, state };
  }

  // Start or continue Dio block (clears diagnostic immediately)
  if (!state.dio && !state.compile && dioExclusive) {
    state = { ...state, dio: true, diagnostic: false, dioError: /DioError\s*║|onError/i.test(logText) };
  }
  if (state.dio && (isDioNetworkLine(stripped) || isDeveloperLogLine(stripped) || isDioBlockContinuation(stripped))) {
    state.diagnostic = false;
    prettyDioBlock = true;
    prettyDioFrame = isPrettyDioBlockFrame(stripped);
    if (/DioError\s*║/.test(logText)) state.dioError = true;
    if (/Status:\s*(?:[45]\d{2})\b/i.test(logText)) state.dioError = true;
    if (isPrettyDioBlockEnd(stripped)) {
      state.dio = false;
      state.dioError = false;
    }
    category = state.dioError ? 'stderr' : 'network';
    return { category, ansiSource: false, loggerBlock, loggerFrame, prettyDioBlock, prettyDioFrame, state };
  }

  if (isLoggerBoxStart(stripped)) {
    const fromAnsi = loggerCategoryFromAnsi(line);
    const fromEmoji = loggerCategoryFromEmoji(stripped);
    const cat = fromAnsi?.category ?? fromEmoji?.category ?? 'console';
    const src = fromAnsi?.ansiSource ?? fromEmoji?.ansiSource ?? true;
    state = { ...emptyLogBlockState(), logger: true, loggerCategory: cat, loggerAnsiSource: src };
    loggerBlock = true;
    category = cat;
    ansiSource = src;
    return { category, ansiSource, loggerBlock, loggerFrame, prettyDioBlock, prettyDioFrame, state };
  }

  if (isDartCompileLine(line)) {
    state = { ...emptyLogBlockState(), compile: true };
    return { category: 'stderr', ansiSource: false, loggerBlock, loggerFrame, prettyDioBlock, prettyDioFrame, state };
  }

  if (isFlutterErrorBoxHeader(stripped)) {
    state = { ...emptyLogBlockState(), diagnostic: true };
    return { category: 'stderr', ansiSource: false, loggerBlock, loggerFrame, prettyDioBlock, prettyDioFrame, state };
  }

  // ── 2. Active block continuations ─────────────────────────
  if (state.compile && isDartCompileContinuation(stripped)) {
    state = { ...state, dio: false, dioError: false, logger: false, diagnostic: false };
    return { category: 'stderr', ansiSource: false, loggerBlock, loggerFrame, prettyDioBlock, prettyDioFrame, state };
  }

  // Flutter diagnostic — only after Dio/Logger/Compile; never bleed into other log types
  if (state.diagnostic) {
    if (isHardDiagnosticEnd(stripped)) {
      state.diagnostic = false;
    } else if (isFlutterDiagnosticContinuation(stripped)) {
      state = { ...state, dio: false, dioError: false, logger: false };
      return { category: 'stderr', ansiSource: false, loggerBlock, loggerFrame, prettyDioBlock, prettyDioFrame, state };
    } else {
      state.diagnostic = false;
    }
  }

  if (state.logger) {
    loggerBlock = true;
    loggerFrame = isLoggerFrameLine(stripped);
    category = state.loggerCategory;
    ansiSource = state.loggerAnsiSource;
    const emojiCat = loggerCategoryFromEmoji(stripped);
    if (emojiCat) {
      state = { ...state, loggerCategory: emojiCat.category, loggerAnsiSource: emojiCat.ansiSource };
      category = emojiCat.category;
      ansiSource = emojiCat.ansiSource;
    } else {
      const ansiCat = loggerCategoryFromAnsi(line);
      if (ansiCat && !loggerFrame) {
        state = { ...state, loggerCategory: ansiCat.category, loggerAnsiSource: ansiCat.ansiSource };
        category = ansiCat.category;
        ansiSource = ansiCat.ansiSource;
      }
    }
    if (isLoggerBoxEnd(stripped)) state.logger = false;
    return { category, ansiSource, loggerBlock, loggerFrame, prettyDioBlock, prettyDioFrame, state };
  }

  // ── 3. Fresh per-line classification ──
  const classified = classifyCategory(line, base);
  category = classified.category;
  ansiSource = classified.ansiSource;

  if (state.compile) state.compile = false;
  if (state.dio && !isDioNetworkLine(stripped)) { state.dio = false; state.dioError = false; }

  return { category, ansiSource, loggerBlock, loggerFrame, prettyDioBlock, prettyDioFrame, state };
}

/**
 * Main classifier: ANSI layer first (most accurate), then pattern layer (fallback).
 * Returns category + whether color came from ANSI (so webview can let parseAnsi drive rendering).
 */
function classifyCategory(output: string, base: string): { category: string; ansiSource: boolean } {
  if (base === 'stderr') return { category: 'stderr', ansiSource: false };
  const stripped = stripAnsi(output);
  const logText = stripDeveloperLogPrefix(stripped);
  if (isFlutterErrorBoxHeader(stripped)) {
    return { category: 'stderr', ansiSource: false };
  }
  if (!isDioExclusiveLine(stripped) && !isDioNetworkLine(stripped) && matchesDartFlutterError(logText)) {
    return { category: 'stderr', ansiSource: false };
  }
  const ansi = classifyByAnsi(output);
  if (ansi) return { category: ansi, ansiSource: true };
  const pattern = classifyByPattern(output);
  if (pattern) return { category: pattern, ansiSource: false };
  if (isPrettyDioLine(stripped)) {
    const t = stripDeveloperLogPrefix(stripped);
    if (/onError/i.test(t) && (isPrettyDioBlockStart(stripped) || /DioError\s*║/.test(t))) {
      return { category: 'stderr', ansiSource: false };
    }
    return { category: 'network', ansiSource: false };
  }
  return { category: base, ansiSource: false };
}

const LAST_LAUNCH_KEY = 'flutterDebuggerPlus.lastLaunch';

type StoredLaunch = { folderPath: string; name: string };

type LaunchEntry = {
  name: string;
  folder: vscode.WorkspaceFolder;
  config: vscode.DebugConfiguration;
};

function workspaceFolderForActiveEditor(): vscode.WorkspaceFolder | undefined {
  const doc = vscode.window.activeTextEditor?.document;
  if (doc) {
    return vscode.workspace.getWorkspaceFolder(doc.uri) ?? vscode.workspace.workspaceFolders?.[0];
  }
  return vscode.workspace.workspaceFolders?.[0];
}

/** launch.json allows line and block comments (JSONC); JSON.parse alone fails. */
function stripJsonComments(text: string): string {
  let out = '';
  let inString = false;
  let quote = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];
    if (inString) {
      out += ch;
      if (ch === '\\' && i + 1 < text.length) out += text[++i];
      else if (ch === quote) inString = false;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inString = true;
      quote = ch;
      out += ch;
      continue;
    }
    if (ch === '/' && next === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      continue;
    }
    if (ch === '/' && next === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++;
      i++;
      continue;
    }
    out += ch;
  }
  return out;
}

function parseLaunchJsonFile(text: string): { configurations?: vscode.DebugConfiguration[] } {
  return JSON.parse(stripJsonComments(text)) as { configurations?: vscode.DebugConfiguration[] };
}

function workspaceFolderForPath(targetPath: string): vscode.WorkspaceFolder | undefined {
  const uri = vscode.Uri.file(targetPath);
  const direct = vscode.workspace.getWorkspaceFolder(uri);
  if (direct) return direct;
  for (const f of vscode.workspace.workspaceFolders ?? []) {
    const base = f.uri.fsPath.replace(/\\/g, '/');
    const target = targetPath.replace(/\\/g, '/');
    if (target.startsWith(base + '/') || target === base) return f;
  }
  return vscode.workspace.workspaceFolders?.[0];
}

/** Walk up from a file/folder until .vscode/launch.json is found. */
async function findLaunchJsonNear(
  from: vscode.Uri
): Promise<{ launchUri: vscode.Uri; projectRoot: vscode.Uri } | undefined> {
  let dir = from;
  try {
    const stat = await vscode.workspace.fs.stat(dir);
    if (stat.type === vscode.FileType.File) {
      dir = vscode.Uri.joinPath(dir, '..');
    }
  } catch { /* treat as directory */ }
  for (let depth = 0; depth < 24; depth++) {
    const launchUri = vscode.Uri.joinPath(dir, '.vscode', 'launch.json');
    try {
      await vscode.workspace.fs.stat(launchUri);
      return { launchUri, projectRoot: dir };
    } catch { /* keep walking up */ }
    const parent = vscode.Uri.joinPath(dir, '..');
    if (parent.fsPath === dir.fsPath) break;
    dir = parent;
  }
  return undefined;
}

async function readLaunchEntriesFromFile(
  launchUri: vscode.Uri,
  projectRoot: vscode.Uri,
  seen: Set<string>,
  entries: LaunchEntry[]
) {
  const folder = workspaceFolderForPath(projectRoot.fsPath);
  if (!folder) return;
  try {
    const raw = await vscode.workspace.fs.readFile(launchUri);
    const json = parseLaunchJsonFile(Buffer.from(raw).toString('utf8'));
    for (const cfg of json.configurations ?? []) {
      if (!cfg?.name || typeof cfg.name !== 'string') continue;
      const key = projectRoot.fsPath + '\0' + cfg.name;
      if (seen.has(key)) continue;
      seen.add(key);
      entries.push({ name: cfg.name, folder, config: { ...cfg } });
    }
  } catch { /* unreadable or invalid */ }
}

/** Read named configurations from .vscode/launch.json (Run and Debug dropdown — above the separator only). */
async function readLaunchEntries(preferFolder?: vscode.WorkspaceFolder): Promise<LaunchEntry[]> {
  const folders = vscode.workspace.workspaceFolders ?? [];
  const ordered = preferFolder
    ? [preferFolder, ...folders.filter(f => f !== preferFolder)]
    : folders;
  const entries: LaunchEntry[] = [];
  const seen = new Set<string>();

  for (const folder of ordered) {
    const launchUri = vscode.Uri.joinPath(folder.uri, '.vscode', 'launch.json');
    await readLaunchEntriesFromFile(launchUri, folder.uri, seen, entries);
  }

  if (!entries.length) {
    const editorUri = vscode.window.activeTextEditor?.document.uri;
    const startUri = editorUri ?? preferFolder?.uri ?? folders[0]?.uri;
    if (startUri) {
      const found = await findLaunchJsonNear(startUri);
      if (found) {
        await readLaunchEntriesFromFile(found.launchUri, found.projectRoot, seen, entries);
      }
    }
  }

  return entries;
}

function resolveStoredLaunch(
  context: vscode.ExtensionContext,
  entries: LaunchEntry[]
): LaunchEntry | undefined {
  const stored = context.globalState.get<StoredLaunch>(LAST_LAUNCH_KEY);
  if (!stored) return undefined;
  return entries.find(
    e => e.name === stored.name && e.folder.uri.fsPath === stored.folderPath
  );
}

async function saveStoredLaunch(context: vscode.ExtensionContext, entry: LaunchEntry) {
  await context.globalState.update(LAST_LAUNCH_KEY, {
    folderPath: entry.folder.uri.fsPath,
    name: entry.name,
  });
}

async function pickLaunchEntry(
  context: vscode.ExtensionContext,
  entries: LaunchEntry[],
  startAfterPick: boolean
): Promise<LaunchEntry | undefined> {
  const stored = context.globalState.get<StoredLaunch>(LAST_LAUNCH_KEY);
  const multiRoot = (vscode.workspace.workspaceFolders?.length ?? 0) > 1;

  const picked = await vscode.window.showQuickPick(
    entries.map(e => ({
      label: e.name,
      description: multiRoot ? e.folder.name : undefined,
      picked: stored?.name === e.name && stored.folderPath === e.folder.uri.fsPath,
      entry: e,
    })),
    {
      title: 'Select Launch Configuration',
      placeHolder: 'Run modes from .vscode/launch.json',
    }
  );
  if (!picked) return undefined;

  await saveStoredLaunch(context, picked.entry);
  if (startAfterPick) {
    await vscode.debug.startDebugging(picked.entry.folder, picked.entry.config);
  }
  return picked.entry;
}

async function fallbackDebugStart() {
  const candidates = ['dart.startDebugging', 'workbench.action.debug.start'];
  const available = new Set(await vscode.commands.getCommands(true));
  for (const id of candidates) {
    if (available.has(id)) {
      await vscode.commands.executeCommand(id);
      return;
    }
  }
  vscode.window.showWarningMessage(
    'Flutter Debugger Plus: No launch.json configurations found. Add .vscode/launch.json or install the Dart extension.'
  );
}

async function startFlutterDebug(context: vscode.ExtensionContext) {
  const folder = workspaceFolderForActiveEditor();
  const entries = await readLaunchEntries(folder);
  if (!entries.length) {
    await fallbackDebugStart();
    return;
  }

  if (entries.length === 1) {
    await saveStoredLaunch(context, entries[0]);
    await vscode.debug.startDebugging(entries[0].folder, entries[0].config);
    return;
  }

  const stored = resolveStoredLaunch(context, entries);
  if (stored) {
    await vscode.debug.startDebugging(stored.folder, stored.config);
    return;
  }

  await pickLaunchEntry(context, entries, true);
}

async function selectLaunchConfig(context: vscode.ExtensionContext) {
  const folder = workspaceFolderForActiveEditor();
  const entries = await readLaunchEntries(folder);
  if (!entries.length) {
    vscode.window.showWarningMessage(
      'Flutter Debugger Plus: No configurations in .vscode/launch.json'
    );
    return;
  }
  const entry = await pickLaunchEntry(context, entries, false);
  if (entry) {
    vscode.window.setStatusBarMessage(`Launch config: ${entry.name}`, 3000);
  }
}

async function stopFlutterDebug() {
  const candidates = ['workbench.action.debug.stop', 'workbench.action.debug.disconnect'];
  const available = new Set(await vscode.commands.getCommands(true));
  for (const id of candidates) {
    if (available.has(id)) {
      await vscode.commands.executeCommand(id);
      return;
    }
  }
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
    vscode.commands.registerCommand('flutterDebuggerPlus.show',              () => provider.reveal()),
    vscode.commands.registerCommand('flutterDebuggerPlus.clear',            () => store.clear()),
    vscode.commands.registerCommand('flutterDebuggerPlus.selectLaunchConfig', () => selectLaunchConfig(context)),
    vscode.commands.registerCommand('flutterDebuggerPlus.debug',            () => startFlutterDebug(context)),
    vscode.commands.registerCommand('flutterDebuggerPlus.stopDebug',        () => stopFlutterDebug())
  );

  context.subscriptions.push(vscode.debug.onDidStartDebugSession(async (session) => {
    const cfg = vscode.workspace.getConfiguration('flutterDebuggerPlus');
    if (cfg.get<boolean>('onlyFlutterDart', true) && !isFlutterOrDartSession(session)) return;
    if (cfg.get<boolean>('clearOnRestart', true)) store.clear();
    if (!cfg.get<boolean>('autoRevealOnFlutterDebug', true)) return;
    await provider.reveal();
  }));

  context.subscriptions.push(vscode.debug.registerDebugAdapterTrackerFactory('*', {
    createDebugAdapterTracker(session: vscode.DebugSession) {
      const cfg = vscode.workspace.getConfiguration('flutterDebuggerPlus');
      if (cfg.get<boolean>('onlyFlutterDart', true) && !isFlutterOrDartSession(session)) return undefined;

      // Sticky block state — carried across output events within one debug session.
      let blockState = emptyLogBlockState();

      const resetBlockState = () => {
        blockState = emptyLogBlockState();
      };

      return {
        onWillReceiveMessage(message: unknown) {
          const msg = message as Record<string, unknown>;
          if (msg?.type !== 'request') return;
          const command = String(msg.command ?? '');
          if (command === 'restart' || command === 'hotRestart') {
            const c = vscode.workspace.getConfiguration('flutterDebuggerPlus');
            if (c.get<boolean>('clearOnRestart', true)) store.clear();
            resetBlockState();
          }
        },
        onDidSendMessage(message: unknown) {
          const msg = message as Record<string, unknown>;
          if (msg?.type !== 'event' || msg?.event !== 'output') return;
          const body = (msg.body ?? {}) as Record<string, unknown>;
          const output = String(body.output ?? '');
          if (!output) return;
          const base = String(body.category ?? 'console');

          const lines = output.replace(/\r\n/g, '\n').split('\n');
          for (let i = 0; i < lines.length; i++) {
            let line = lines[i];
            if (line === '' && i === lines.length - 1) continue;

            if (line.includes('\\^[')) {
              line = line.replace(/\\\^\[/g, '\x1b').replace(/\s*<…>\s*$/, '');
            }

            const result = classifyOutputLine(line, base, blockState);
            blockState = result.state;

            store.add({
              session: session.name,
              category: result.category,
              ansiSource: (result.category === 'stderr' || result.category === 'warn')
                ? false : result.ansiSource,
              output: line,
              loggerBlock: result.loggerBlock,
              loggerFrame: result.loggerFrame,
              prettyDioBlock: result.prettyDioBlock,
              prettyDioFrame: result.prettyDioFrame,
            });
          }
        }
      };
    }
  }));
}

export function deactivate() {}
