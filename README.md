<p align="center">
  <img src="github/component-browser-icon.png" alt="Component Browser logo" width="120" height="120">
</p>

# 🧭 Component Browser

A fast, keyboard-driven Sketch plugin for browsing and inserting Symbols (Components) from your document and libraries.

![Component Browser Screenshot](github/screenshot.png)

## Features

- 🔍 **Smart Search** — Instantly filter symbols by name
- 🎨 **Source Filtering** — Switch between All, Local, and Library sources
- 🖼️ **Preview Thumbnails** — Visual previews for symbols in the list
- ⌨️ **Keyboard First** — Navigate and insert without touching the mouse
- 🔄 **Batch Replace** — Replace multiple selected layers at once

## Installation

1. Open the [latest release](https://github.com/funk4d/Component-Browser-Sketch-Plugin/releases/latest)
2. Download `ComponentBrowser.sketchplugin.zip`
3. Unzip it if your browser did not extract it automatically
4. Double-click `ComponentBrowser.sketchplugin` to install it in Sketch

## Usage

### Open Component Browser

**`Cmd + Shift + ;`** — Launch the browser from anywhere in Sketch

### Navigation

| Key | Action |
|-----|--------|
| `↑` / `↓` | Navigate through symbols |
| `Tab` | Next source filter (All → Local → Library) |
| `Shift + Tab` | Previous source filter |
| `Enter` | Insert selected symbol at viewport center |
| `Shift + Enter` | **Replace** selected layer(s) with symbol |
| `Esc` | Close browser |

### Source Filters

- **All** — Show all symbols (local + libraries)
- **Local** — Symbols defined in current document only
- **Library Name** — Symbols from specific library

### Replace Mode

When you have layers selected, press **`Shift + Enter`** to replace them with the chosen symbol:
- Preserves position
- Preserves dimensions (with checkbox option)
- Works with multiple selections — replaces all selected layers at once

## Tips

- **Search as you type** — Start typing to filter symbols instantly
- **Quick library switch** — Use `Tab` to cycle through sources without leaving the keyboard
- **Drag to move** — Grab the search bar to reposition the window

## Roadmap

- [x] Add symbol preview thumbnails
- [ ] Add customization (settings/preferences)
- [ ] Integrate search for free icon libraries (e.g., Remix Icon)
- [ ] Explore menu command introspection/execution (File, Edit, Window, Help, Plugins)
- [ ] Add more commands

## Credits

Created by [Dmytro Shevchuk](https://github.com/funk4d)

## Releasing

See [RELEASING.md](RELEASING.md) for the expected release package format and the appcast checklist.

## License

MIT
