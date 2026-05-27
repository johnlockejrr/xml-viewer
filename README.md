# XML Viewer — PAGE / ALTO

A local web viewer for PAGE-XML and ALTO-XML annotated manuscripts. Displays the source image with polygon overlays and a synchronized transcription mirror panel.

## Features

- **IIIF-style strip** — vertical thumbnail column, one document per row (not card grid)
- **Image + overlay** — colored polygons drawn on canvas over the image; one color per region type
- **Mirrored text panel** — transcribed lines shown in reading order, right panel
- **Bidirectional highlight** — hover a line in the text → highlights on image; hover a polygon on the image → highlights text line and scrolls to it
- **Click to navigate** — clicking a text line scrolls the image panel to center that line
- **Legend / type filter** — click any region type in the legend to hide/show it
- **Overlay toggle** — press `O` to toggle the overlay on/off
- **Baseline rendering** — dashed line shows the baseline within each TextLine
- **PAGE and ALTO** — auto-detected, no configuration needed
- **Region types discovered from files** — no hardcoded type lists
- **Resizable panels** — drag the divider between image and text panels

## Requirements

- Node.js 22+ (uses built-in `node:sqlite`)

## Setup

```bash
npm install
node server.js
# → http://localhost:3838
```

Open Settings (⚙) and set your input directory. It should contain `.xml` files. Images are discovered automatically by matching filename:

```
my-dir/
  page_001.xml     ← PAGE or ALTO
  page_001.jpg     ← sidecar image (same name, any image ext)
  page_002.xml
  page_002.tiff
  images/          ← OR images in a subdirectory named images/, img/, jpg/, tiff/
    page_003.jpg
```

## File Structure

```
xml-viewer/
├── server.js       # Express server + API
├── parseXml.js     # PAGE-XML / ALTO-XML parser
├── viewer.db       # SQLite settings (auto-created)
├── thumbnails/     # Cached thumbs (auto-created)
├── package.json
└── public/
    └── index.html  # Single-file SPA
```

## Keyboard Shortcuts

| Key | Action |
|---|---|
| `←` / `→` | Navigate documents |
| `O` | Toggle overlay |
| `S` | Open Settings |
| `Esc` | Close panels |

## Notes

- XML is parsed on first view and cached in memory (up to 30 documents)
- Coordinates are normalized to 0–1 space internally, scaled to actual image pixels at render time
- For TIFF images without a JPEG sidecar, Sharp converts them on the fly
- RTL scripts (Hebrew, Arabic) are handled via CSS `direction: auto` in the text panel
