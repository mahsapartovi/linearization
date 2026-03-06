# Point Cloud Viewer

Web-based 3D point cloud visualization/linearization with Flask + Three.js.

## Features
- **Lit point spheres**: Custom shader makes each point a tiny lit sphere with directional + ambient lighting
- **Two-stage workflow**: Upload shows original cloud first → click "Cluster & Linearize" to process
- **Dual view**: Linearized (main) + Clustered (right panel)
- **Hover highlight**: Hover a cluster in the right panel → those points glow in the main view
- **Instant cluster switching**: Click a cluster → instant appear/disappear (no loading)
- **Fast overlap**: "Apply Overlap" button re-linearizes without re-clustering
- **Click-to-mark**: Double-click → marker → export CSV with original XYZ
- **Marker customization**: Choose marker color and size in Parameters panel
- **Persistent clicks**: Clicks survive cluster switching AND page reload (saved to server per cloud file)
- **Cross-view markers**: Click on linearized view → visible on cluster view and vice versa
- **CloudCompare-style camera**: left-drag rotate, right-drag pan, scroll zoom

## Setup
```bash
cd pointcloud-viewer
python3 -m venv venv && source venv/bin/activate
pip install -r requirements.txt
python app.py
# Open http://localhost:5000
```

## Usage
1. **File → Open** → upload .las/.laz/.ply/.xyz → see original cloud
2. **Cluster & Linearize** button in Parameters panel → process into clusters
3. **Hover** over clusters in right panel to highlight in main view
4. **Click** a cluster in right panel for instant isolation
5. **Double-click** any point to mark it (lit sphere marker)
6. **Double-click** a marker to remove it
7. **Export CSV** via toolbar button or File/Tools menu
8. **Apply Overlap** → fast re-linearization without re-clustering
9. **Re-Cluster** → full re-clustering with new grid resolution

## Shortcuts
| Key | Action |
|-----|--------|
| F | Fit to view |
| R | Reset view |
| G | Grid toggle |
| A | Axes toggle |
| +/- | Point size |
| 1/2/3 | Top/Front/Right |
| Esc | Clear cluster isolation |
| Ctrl+O | Open file |
