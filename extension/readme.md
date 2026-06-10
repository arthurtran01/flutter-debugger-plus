# Flutter Debugger Plus

A searchable Flutter/Dart debug console with native VSCode colors, ANSI support, clickable file links, and a VSCode-style find bar — docked in the bottom panel alongside Terminal, Output, and Debug Console.

## Features

### 🎨 Native Debug Console Colors

Log categories are styled with the same CSS variables VSCode uses internally, adapting automatically to any theme.

### 🌈 ANSI Color Support

Parses `\x1b[...m` escape sequences and renders them using VSCode's terminal color palette. Supports **bold**, dim, *italic*, and underline.

### 🔗 Clickable File Links

Detects file references in log output and makes them clickable.

### 🔍 Filter Bar (always visible — VS Code Debug Console style)

- Filter input always at top with **Cc** · **W** · **.*** toggles and match navigation
- `↑` / `↓` in filter for search history · `ESC` clears filter
- `Cmd+F` / `Ctrl+F` focuses filter with selected text

### 🧰 Console Toolbar

- **Filter bar** with **Cc** · **W** · **.\*** toggles, match navigation, and category filter
- **Hover tooltips** on toolbar buttons (Android Studio style — auto-hide after a configurable duration)
- **Soft wrap** toggle — wrap long lines or scroll horizontally
- **Scroll to the end** (auto-follow toggle — releases when you scroll up)
- **Clear logs** · right-click log area for **Copy** / **Clear Log**

### ▶ Quick Debug (Editor Title Bar)

When you have a **`.dart`** file open, debug controls appear in the **top-right editor toolbar**:

| Control | Action |
| ------- | ------ |
| **▼** (triangle) | Pick a run mode from **`.vscode/launch.json`** — same list as Run and Debug (demo, demo profile, demo release, …). Does not include IDE items below the separator (Node.js…, Add Configuration…). |
| **Debug** (▶) | Starts the selected launch configuration via `vscode.debug.startDebugging` |
| **Stop** | Stops the active session (shown while debugging) |

**How configs are loaded:** reads only the `configurations[]` array in `.vscode/launch.json` (each entry's `name`). Your last choice is remembered per workspace.

If there is no `launch.json`, **Debug** falls back to the Dart extension / **F5** behavior.

After debug starts, **Flutter Console+** opens automatically (if `autoRevealOnFlutterDebug` is enabled).

### 🚨 Error & Warning Highlighting

Logs are classified per line and colored automatically:

- **Red (stderr):** Dart/Flutter exceptions and errors — including `AssertionError`, `Failed assertion:`, layout failures (`RenderFlex overflowed`, unbounded viewport), compile errors, stack traces, logcat `E/flutter`, and Flutter diagnostic blocks (`Exception caught by…`, `The following assertion was thrown…`). Based on [Dart error handling](https://dart.dev/language/error-handling) and [Flutter error docs](https://docs.flutter.dev/testing/errors).
- **Yellow (warn):** Analyzer warnings/hints, deprecations, logcat `W/flutter`, logger `⚠` output.

File paths in error lines (`package:…`, `lib/…`, `file:///…`) stay clickable.

### ⚡ Performance

- Batched rendering via `requestAnimationFrame`
- Auto scroll-to-bottom, pauses when scrolled up
- Configurable max log lines in memory

## Settings

```json
{
  "flutterDebuggerPlus.autoRevealOnFlutterDebug": true,
  "flutterDebuggerPlus.onlyFlutterDart": true,
  "flutterDebuggerPlus.maxLines": 5000,
  "flutterDebuggerPlus.clearOnRestart": true,
  "flutterDebuggerPlus.tooltipDuration": 3
}
```


| Setting                    | Default | Description                                                               |
| -------------------------- | ------- | ------------------------------------------------------------------------- |
| `autoRevealOnFlutterDebug` | `true`  | Auto-open the panel when a Flutter/Dart debug session starts              |
| `onlyFlutterDart`          | `true`  | Capture only Dart/Flutter sessions; disable to capture all debug adapters |
| `maxLines`                 | `5000`  | Maximum number of log lines kept in memory                                |
| `clearOnRestart`           | `true`  | Clear logs on hot restart / new debug session                             |
| `tooltipDuration`          | `3`     | Toolbar tooltip visibility in seconds; `0` = until pointer leaves         |

## Project Details

- **Repository:** [arthurtran01/flutter-debugger-plus](https://github.com/arthurtran01/flutter-debugger-plus)
- **Issues:** [Report a bug](https://github.com/arthurtran01/flutter-debugger-plus/issues)

