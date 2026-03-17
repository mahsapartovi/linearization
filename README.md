# 3D Point Cloud Viewer & DBH Measurement Tool

A web-based interactive tool for visualizing, clustering, linearizing, and annotating 3D point cloud data from forests. Built with Flask (Python) and Three.js (JavaScript).

![Point Cloud Viewer](https://img.shields.io/badge/Flask-Backend-blue) ![Three.js]

---

## Features

### Point Cloud Visualization
- Upload and render point clouds with up to **5 million points** per view
- Lit point-sphere shader rendering with adjustable point size and optional lighting
- Multiple background modes (gradient, black, white)
- Coordinate readout on mouse hover
- Orientation cube for spatial reference
- Resizable panels (left sidebar, right panel, bottom info panel)

### Density-Based Clustering & Linearization
- Automatic density-based spatial clustering (adjustable `eps` parameter)
- Linearized view: clusters are spread along the X-axis for side-by-side comparison
- Multi-row layout: clusters auto-pack into scrollable rows sized to fill the viewport
- Adjustable overlap fraction between adjacent clusters
- Clustered view in a separate panel with per-cluster coloring

### Cluster Interaction
- Hover a cluster in the right panel → highlights it in the main view
- Click a cluster → isolates it (hides all others)
- Per-cluster zoom and camera control
- Normal and curvature visualization (PCA-based, auto-computed)

### Annotation Support
- Upload annotation/ground-truth PLY files alongside the main point cloud
- Each annotation file represents one tree with semantic and instance labels
- Pink sprite markers at 1.5m trunk height (DBH reference)
- Per-file visibility toggle in the DB Tree panel
- Annotation markers filter by isolated cluster

### DBH (Diameter at Breast Height) Measurement
- **Ground surface estimation**: 20×20 grid with 5th-percentile Z, bilinear interpolation, and smoothing
- **Reference plane**: black terrain-following plane at 1.5m above ground
- **Adjustable slice plane**: red plane with height slider
- **Annotation-based slicing**: keeps only trunk points near known tree positions, removes all ground
- **Top-down view** for trunk cross-section inspection
- **Circle fitting**: place, move (arrow keys), resize (+/−), lock (Enter)
- **Multi-circle workflow**: fit multiple trunks before saving all at once (✔)
- DBH diameter recorded in the Click Log table

### Click Log & Data Export
- Double-click any point to log it with original XYZ coordinates
- Annotation entries sorted by cluster (descending)
- Table filters to show only the active cluster's entries
- Right-click context menu: Edit, Add row, Move to bottom
- Drag-and-drop row reordering
- Editable cluster column (contenteditable cells)
- Mouse hover over trees highlights the associated row in the table
- Export all clicks to CSV with full metadata
- Auto-save clicks to server (restored on reload)

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

## Usage Guide

### 1. Upload a Point Cloud

- **File → Open** or click the 📂 toolbar button
- Drag-and-drop or browse for a point cloud file
- Optionally attach annotation PLY files (multiple supported)
- Click **Upload & Process**

### 2. Cluster & Linearize

- Adjust the **eps Parameter** in the right panel (lower = more clusters)
- Click **Cluster & Linearize** (or **Re-Cluster** to recompute)
- The main view shows clusters spread horizontally in rows
- The clustered view (top-right) shows original spatial arrangement with per-cluster colors

### 3. Inspect Clusters

- **Hover** a cluster in the Cluster Properties panel → highlights in main view
- **Click** a cluster → isolates it, zooms in, filters annotations and table
- **✕ Show All** to return to full view
- **Scroll wheel** zooms individual rows independently

### 4. Measure DBH

1. Isolate a cluster (click it in the right panel)
2. **Tools → DBH Calculation** opens the slice tool
3. Click **"Show 1.5m Reference Plane"** to see the terrain-following black plane
4. Adjust the **slice height** with the slider (red plane moves)
5. Click **"✂ Slice & Top View"**:
   - Points above the slice and all ground are removed
   - Only trunk cross-sections remain (using annotation positions)
   - Camera switches to top-down view
6. **Double-click** a trunk hole to place a fitting circle
7. Use **+/−** keys to resize, **arrow keys** to move, **Enter** to lock
8. **Double-click** the next trunk to place another circle (previous stays)
9. Click **✔** to save all DBH measurements to the table

### 5. Export Data

- **File → Export Clicks CSV** or 💾 toolbar button
- CSV includes: original XYZ, cluster ID, camera state, marker properties
- Click data auto-saves to server and restores on reload

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

## Technical Details

### Clustering Pipeline (Server)
1. Voxel grid subsampling at `eps` resolution
2. DBSCAN on subsampled centroids (`min_samples=5`)
3. Labels propagated back to full-resolution points via nearest-neighbor
4. Linearization: clusters sorted by X centroid, spread along X axis with configurable overlap

### Ground Surface Estimation
1. Divide cluster XY footprint into 20×20 grid
2. Filter to bottom 30% of Z range (ground-level points only)
3. Compute 5th percentile Z per cell (robust to noise)
4. Fill empty cells by neighbor averaging
5. Smooth with 3×3 kernel
6. Bilinear interpolation for per-point ground lookup

### DBH Slicing (Annotation-Based)
1. Convert annotation trunk positions to row-local coordinates
2. For each point: keep only if within 0.8m XY of a known trunk AND above ground+0.3m AND below slice height
3. All ground, bushes, and canopy removed — only trunk cross-sections remain

### Normal/Curvature Computation
1. K-nearest neighbors (k=30) via KDTree
2. Batched PCA: `np.einsum` covariance → `np.linalg.eigh`
3. Smallest eigenvector = surface normal
4. Curvature = λ_min / Σλ (ratio of smallest eigenvalue to sum)

### Data Transfer
- Large arrays (positions, colors, labels) are base64-encoded for efficient transfer
- Subsampling caps at 5M points per view for rendering performance
- Click data auto-persists as JSON on the server

---

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/upload_raw` | POST | Upload point cloud + optional annotations |
| `/recluster` | POST | Run clustering and linearization |
| `/relinearize` | POST | Adjust overlap without re-clustering |
| `/compute_normals` | POST | Compute surface normals and curvature |
| `/get_display_colors` | POST | Retrieve normal/curvature color arrays |
| `/save_clicks` | POST | Persist click markers |
| `/load_clicks` | GET | Retrieve saved click markers |
| `/slice_at_height` | POST | Extract point cloud slice at height |
| `/upload_annotation` | POST | Add annotation files to existing cloud |

---

## Browser Compatibility

Tested on:
- Chrome 120+ (recommended)
- Firefox 120+
- Safari 17+
- Edge 120+

Requires WebGL support. Performance depends on GPU — large point clouds (>3M points) benefit from a dedicated graphics card.

---

## License

MIT License — see [LICENSE](LICENSE) for details.
