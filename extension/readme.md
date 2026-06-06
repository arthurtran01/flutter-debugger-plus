# Flutter Debugger Plus

A searchable Flutter/Dart debug console with native VSCode colors, ANSI support, clickable file links, and a VSCode-style find bar — docked in the bottom panel alongside Terminal, Output, and Debug Console.

## Features

### 🎨 Native Debug Console Colors

Log categories are styled with the same CSS variables VSCode uses internally, adapting automatically to any theme.

### 🌈 ANSI Color Support

Parses `\x1b[...m` escape sequences and renders them using VSCode's terminal color palette. Supports **bold**, dim, *italic*, and underline.

### 🔗 Clickable File Links

Detects file references in log output and makes them clickable.

### 🔍 Find Bar (Cmd+F / Ctrl+F)

- **Match Case** · **Whole Word** · **Regular Expression** toggles
- `Enter` → next match, `Shift+Enter` → previous
- Select text then `Cmd+F` to search the selection
- `ESC` or `✕` to close

### ⚡ Performance

- Batched rendering via `requestAnimationFrame`
- Auto scroll-to-bottom, pauses when scrolled up
- Configurable max log lines in memory

## Settings

```json
{
  "flutterDebuggerPlus.autoRevealOnFlutterDebug": true,
  "flutterDebuggerPlus.onlyFlutterDart": true,
  "flutterDebuggerPlus.maxLines": 5000
}
```


| Setting                    | Default | Description                                                               |
| -------------------------- | ------- | ------------------------------------------------------------------------- |
| `autoRevealOnFlutterDebug` | `true`  | Auto-open the panel when a Flutter/Dart debug session starts              |
| `onlyFlutterDart`          | `true`  | Capture only Dart/Flutter sessions; disable to capture all debug adapters |
| `maxLines`                 | `5000`  | Maximum number of log lines kept in memory                                |

## Project Details

- **Repository:** [arthurtran01/flutter-debugger-plus](https://github.com/arthurtran01/flutter-debugger-plus)
- **Issues:** [Report a bug](https://github.com/arthurtran01/flutter-debugger-plus/issues)

