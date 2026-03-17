# 3D Point Cloud Viewer 

A web-based interactive tool for visualizing, clustering, linearizing, and annotating 3D point cloud data from terrestrial laser scanning (TLS) of forests. Built with Flask (Python) and Three.js (JavaScript).

![Point Cloud Viewer](https://img.shields.io/badge/Flask-Backend-blue) ![Three.js]

---


## Project Structure

```
pointcloud-viewer/
├── app.py                      # Flask backend (clustering, linearization, normals, slicing)
├── requirements.txt            # Python dependencies
├── templates/
│   └── index.html              # Main HTML template (UI layout, modals, panels)
├── static/
│   ├── css/
│   │   └── style.css           # Full application styling
│   └── js/
│       └── viewer.js           # Three.js viewer (rendering, interaction, DBH measurement)
├── uploads/                    # Uploaded point cloud files (auto-created)
│   └── clicks/                 # Auto-saved click data (JSON)
└── README.md
```

---

## Installation

### Prerequisites
- Python 3.9+
- pip

### Setup

```bash
git clone https://github.com/your-username/pointcloud-viewer.git
cd pointcloud-viewer
python3 -m venv venv
source venv/bin/activate        # Linux/macOS
# venv\Scripts\activate         # Windows
pip install -r requirements.txt
python app.py
```

Open **http://localhost:5000** in your browser.

### Dependencies

| Package | Purpose |
|---------|---------|
| Flask ≥ 2.3 | Web server and API |
| NumPy ≥ 1.24 | Array operations |
| SciPy ≥ 1.10 | KDTree for spatial queries |
| laspy ≥ 2.5 | LAS/LAZ file parsing |
| lazrs ≥ 0.5 | LAZ decompression |
| plyfile ≥ 0.9 | PLY file parsing |
| scikit-learn ≥ 1.3 | DBSCAN clustering, PCA normals |

---

## Supported File Formats

| Format | Extension | Notes |
|--------|-----------|-------|
| LAS | `.las` | Standard lidar format |
| LAZ | `.laz` | Compressed LAS |
| PLY | `.ply` | Stanford polygon format |
| XYZ/ASCII | `.xyz`, `.asc`, `.txt`, `.csv` | Space/comma-delimited XYZ (optional RGB) |

**Annotation files**: PLY format with `x, y, z, semantic, instance` columns. Each file represents one tree.

---


## Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `F` | Fit to view |
| `R` | Reset camera |
| `G` | Toggle grid |
| `A` | Toggle axes |
| `L` | Toggle lighting |
| `1` / `2` / `3` | Top / Front / Right view |
| `Esc` | Clear cluster isolation |
| `+` / `-` | Resize DBH circle (in slice mode) |
| `← → ↑ ↓` | Move DBH circle (in slice mode) |
| `Enter` | Lock DBH circle (in slice mode) |

### Mouse Controls

| Action | Effect |
|--------|--------|
| Left drag | Rotate |
| Right drag | Pan |
| Ctrl + Left drag | Pan |
| Scroll | Zoom (per-row in linearized view) |
| Double-click | Mark/unmark point (or place DBH circle in slice mode) |

---

## Display Modes

Access via **Display** menu:

- **White** — default monochrome rendering
- **Normal** — RGB mapped from surface normal direction (|Nx|→R, |Ny|→G, |Nz|→B)
- **Curvature** — green (flat) to blue (curved) based on PCA eigenvalue ratios

---




## Browser Compatibility

Tested on:
- Chrome 120+ (recommended)
- Firefox 120+
- Safari 17+
- Edge 120+

Requires WebGL support. Performance depends on GPU — large point clouds (>3M points) benefit from a dedicated graphics card.

---
