"""
Point Cloud Viewer — Flask Backend
Upload → Parse → Cluster → Linearize → Dual View → Click → CSV

Key changes:
  - /relinearize: overlap-only update (no re-clustering) 
  - labels[] sent with both views for client-side isolation + hover highlight
  - /isolate_cluster removed — isolation done client-side instantly
"""
import os, json, uuid, traceback, csv, io, base64
import numpy as np
from flask import Flask, render_template, request, jsonify, Response
from werkzeug.utils import secure_filename
from scipy import ndimage
from scipy.spatial import cKDTree

app = Flask(__name__)
app.config['UPLOAD_FOLDER'] = os.path.join(os.path.dirname(__file__), 'uploads')
app.config['MAX_CONTENT_LENGTH'] = 500 * 1024 * 1024
os.makedirs(app.config['UPLOAD_FOLDER'], exist_ok=True)
clicks_dir = os.path.join(os.path.dirname(__file__), 'uploads', 'clicks')
os.makedirs(clicks_dir, exist_ok=True)

ALLOWED_EXT = {'las', 'laz', 'xyz', 'ply', 'asc', 'txt', 'csv'}
cloud_store = {}


def allowed_file(fn):
    return '.' in fn and fn.rsplit('.', 1)[1].lower() in ALLOWED_EXT


# ═══════════════════════════════════════════════════════════
# PARSERS
# ═══════════════════════════════════════════════════════════

def parse_xyz(fp):
    points, colors = [], []
    has_rgb = False
    with open(fp, 'r') as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith('#') or line.startswith('//'): continue
            parts = line.replace(',', ' ').split()
            try: vals = [float(v) for v in parts]
            except ValueError: continue
            if len(vals) < 3: continue
            points.append(vals[:3])
            if len(vals) >= 6:
                r, g, b = vals[3], vals[4], vals[5]
                if r > 1 or g > 1 or b > 1: colors.append([r/255, g/255, b/255])
                else: colors.append([r, g, b])
                has_rgb = True
            else: colors.append(None)
    pts = np.array(points, dtype=np.float64)
    cols = np.array([c if c else [0.5,0.5,0.5] for c in colors], dtype=np.float32) if has_rgb else None
    return pts, cols


def parse_las(fp):
    import laspy
    las = laspy.read(fp)
    pts = np.vstack([las.x, las.y, las.z]).T.astype(np.float64)
    cols = None
    try:
        if hasattr(las, 'red'):
            r = np.array(las.red, dtype=np.float32)
            g = np.array(las.green, dtype=np.float32)
            b = np.array(las.blue, dtype=np.float32)
            mx = max(r.max(), g.max(), b.max(), 1.0)
            if mx > 255: r /= 65535; g /= 65535; b /= 65535
            elif mx > 1: r /= 255; g /= 255; b /= 255
            cols = np.vstack([r, g, b]).T
    except: pass
    info = {}
    try:
        info['point_format'] = int(las.header.point_format.id)
        info['version'] = f"{las.header.version.major}.{las.header.version.minor}"
    except: pass
    return pts, cols, info


def parse_ply(fp):
    from plyfile import PlyData
    ply = PlyData.read(fp)
    v = ply['vertex']
    pts = np.vstack([np.array(v['x'], dtype=np.float64), np.array(v['y'], dtype=np.float64), np.array(v['z'], dtype=np.float64)]).T
    cols = None
    try:
        r = np.array(v['red'], dtype=np.float32); g = np.array(v['green'], dtype=np.float32); b = np.array(v['blue'], dtype=np.float32)
        mx = max(r.max(), g.max(), b.max(), 1.0)
        if mx > 1: r /= 255; g /= 255; b /= 255
        cols = np.vstack([r, g, b]).T
    except: pass
    return pts, cols, [p.name for p in v.properties]


# ═══════════════════════════════════════════════════════════
# CLUSTERING
# ═══════════════════════════════════════════════════════════

def density_segmentation(points, grid_resolution=0.6):
    xy = points[:, :2]
    x_min, y_min = xy[:, 0].min(), xy[:, 1].min()
    x_max, y_max = xy[:, 0].max(), xy[:, 1].max()
    extent = max(x_max - x_min, y_max - y_min)
    if extent < 5: grid_resolution = max(0.1, extent / 20)
    elif extent > 100: grid_resolution = max(1.0, extent / 100)

    nx = int(np.ceil((x_max - x_min) / grid_resolution)) + 1
    ny = int(np.ceil((y_max - y_min) / grid_resolution)) + 1
    if nx * ny > 5_000_000:
        grid_resolution = grid_resolution / np.sqrt(5_000_000 / (nx * ny))
        nx = int(np.ceil((x_max - x_min) / grid_resolution)) + 1
        ny = int(np.ceil((y_max - y_min) / grid_resolution)) + 1

    density = np.zeros((nx, ny), dtype=np.float32)
    gx = np.clip(((xy[:, 0] - x_min) / grid_resolution).astype(int), 0, nx - 1)
    gy = np.clip(((xy[:, 1] - y_min) / grid_resolution).astype(int), 0, ny - 1)
    for i, j in zip(gx, gy): density[i, j] += 1

    sigma = max(1, min(5, int(extent / 10)))
    ds = ndimage.gaussian_filter(density, sigma=sigma)
    fs = max(3, min(11, int(extent / 5)))
    lm = ndimage.maximum_filter(ds, size=fs)
    thresh = ds.max() * 0.05
    peaks = (ds == lm) & (ds > thresh)
    labeled_peaks, n_peaks = ndimage.label(peaks)

    if n_peaks < 2:
        return np.zeros(len(points), dtype=np.int32), 1

    MAX_PEAKS = 30
    if n_peaks > MAX_PEAKS:
        strengths = []
        for p in range(1, n_peaks + 1):
            pos = np.where(labeled_peaks == p)
            if len(pos[0]) > 0: strengths.append((p, ds[pos[0][0], pos[1][0]]))
        strengths.sort(key=lambda x: x[1], reverse=True)
        keep = set(s[0] for s in strengths[:MAX_PEAKS])
        for p in range(1, n_peaks + 1):
            if p not in keep: labeled_peaks[labeled_peaks == p] = 0
        labeled_peaks, n_peaks = ndimage.label(labeled_peaks > 0)

    peak_pos = []
    for p in range(1, n_peaks + 1):
        pos = np.where(labeled_peaks == p)
        if len(pos[0]) > 0: peak_pos.append((pos[0].mean(), pos[1].mean()))
    peak_pos = np.array(peak_pos)

    cell_coords = np.argwhere(density > 0)
    if len(cell_coords) == 0:
        return np.zeros(len(points), dtype=np.int32), 1

    pt = cKDTree(peak_pos)
    _, nearest = pt.query(cell_coords)
    labels_grid = np.full((nx, ny), -1, dtype=np.int32)
    for idx, (ci, cj) in enumerate(cell_coords): labels_grid[ci, cj] = nearest[idx]

    labels = np.array([labels_grid[i, j] for i, j in zip(gx, gy)], dtype=np.int32)
    unlabeled = labels == -1
    if np.any(unlabeled):
        lxy = xy[~unlabeled]; ll = labels[~unlabeled]
        if len(lxy) > 0:
            t = cKDTree(lxy); _, idxs = t.query(xy[unlabeled])
            labels[unlabeled] = ll[idxs]

    return labels, len(set(labels))


# ═══════════════════════════════════════════════════════════
# LINEARIZATION
# ═══════════════════════════════════════════════════════════

def linearize_subgroups(points, labels, overlap_frac=0.15):
    unique = sorted(set(labels))
    result = np.copy(points)
    offset = 0.0
    global_z_min = points[:, 2].min()
    for lbl in unique:
        mask = labels == lbl
        coords = points[mask, :3].copy()
        xe = coords[:, 0].max() - coords[:, 0].min()
        ye = coords[:, 1].max() - coords[:, 1].min()
        if ye > xe:
            coords[:, 0], coords[:, 1] = points[mask, 1].copy(), points[mask, 0].copy()
        mn = coords[:, 0].min()
        mx_v = coords[:, 0].max()
        coords[:, 0] = coords[:, 0] - mn + offset
        coords[:, 1] -= coords[:, 1].min()
        coords[:, 2] -= global_z_min
        result[mask, :3] = coords
        overlap = (mx_v - mn) * overlap_frac
        offset = coords[:, 0].max() - overlap
    return result


# ═══════════════════════════════════════════════════════════
# UTILITIES
# ═══════════════════════════════════════════════════════════

def gen_cluster_colors(n):
    colors = []
    for i in range(n):
        h = i / max(n, 1)
        s, l = 0.85, 0.55
        c = (1 - abs(2 * l - 1)) * s
        x = c * (1 - abs((h * 6) % 2 - 1))
        m = l - c / 2
        if h < 1/6:    r, g, b = c, x, 0
        elif h < 2/6:  r, g, b = x, c, 0
        elif h < 3/6:  r, g, b = 0, c, x
        elif h < 4/6:  r, g, b = 0, x, c
        elif h < 5/6:  r, g, b = x, 0, c
        else:           r, g, b = c, 0, x
        colors.append([r + m, g + m, b + m])
    return colors


def apply_colors(pts, labels, colors):
    """Vectorized color assignment — same logic as original loop version."""
    fallback = [0.5, 0.5, 0.5]
    color_arr = np.array(colors + [fallback], dtype=np.float32)
    fallback_idx = len(colors)
    safe_labels = np.where((labels >= 0) & (labels < len(colors)), labels, fallback_idx)
    return color_arr[safe_labels]


def subsample(pts, cols, mx=5_000_000, indices=None):
    n = pts.shape[0]
    if n <= mx: return pts, cols, n, n, indices
    idx = np.sort(np.random.choice(n, mx, replace=False))
    sub_indices = indices[idx] if indices is not None else None
    return pts[idx], (cols[idx] if cols is not None else None), n, mx, sub_indices


def compute_meta(pts, cols):
    mn = pts.min(0).tolist(); mx = pts.max(0).tolist(); mu = pts.mean(0).tolist()
    ext = (pts.max(0) - pts.min(0)).tolist()
    return {
        'num_points': int(pts.shape[0]),
        'min_x': round(mn[0],4), 'min_y': round(mn[1],4), 'min_z': round(mn[2],4),
        'max_x': round(mx[0],4), 'max_y': round(mx[1],4), 'max_z': round(mx[2],4),
        'mean_x': round(mu[0],4), 'mean_y': round(mu[1],4), 'mean_z': round(mu[2],4),
        'extent_x': round(ext[0],4), 'extent_y': round(ext[1],4), 'extent_z': round(ext[2],4),
        'has_rgb': cols is not None
    }


def to_b64(arr, dtype=np.float32):
    """Convert numpy array to base64-encoded string for compact JSON transport."""
    return base64.b64encode(arr.astype(dtype).tobytes()).decode('ascii')


def build_response(pts, cols, labels, cluster_colors, n_cls, overlap, meta=None, store=None):
    """Standard JSON response. Large arrays are base64-encoded for compact transport."""
    cluster_col_arr = apply_colors(pts, labels, cluster_colors)

    cluster_stats = []
    for lbl in sorted(set(labels)):
        mask = labels == lbl
        cnt = int(mask.sum()); zv = pts[mask, 2]
        cluster_stats.append({
            'id': int(lbl), 'count': cnt,
            'pct': round(100.0 * cnt / len(pts), 1),
            'z_min': round(float(zv.min()), 3), 'z_max': round(float(zv.max()), 3),
            'height': round(float(zv.max() - zv.min()), 3),
            'color': cluster_colors[lbl] if lbl < len(cluster_colors) else [0.5, 0.5, 0.5]
        })

    full = np.hstack([pts, np.zeros((len(pts), 3))])
    lin_data = linearize_subgroups(full, labels, overlap_frac=overlap)
    lin_pts = lin_data[:, :3]

    pts_c = pts - pts.mean(0)
    lin_c = lin_pts - lin_pts.mean(0)
    lin_cols = np.ones_like(lin_c, dtype=np.float32)

    n_pts = len(pts)
    original_indices = np.arange(n_pts, dtype=np.int32)

    cp, cc, ct, cd, cls_orig_idx = subsample(pts_c, cluster_col_arr, 5_000_000, original_indices)
    lp, lc, lt, ld, lin_orig_idx = subsample(lin_c, lin_cols, 5_000_000, original_indices)

    lin_labels = labels[lin_orig_idx] if lin_orig_idx is not None else labels
    cls_labels = labels[cls_orig_idx] if cls_orig_idx is not None else labels
    lin_orig_xyz = pts[lin_orig_idx] if lin_orig_idx is not None else pts
    cls_orig_xyz = pts[cls_orig_idx] if cls_orig_idx is not None else pts

    result = {
        'n_clusters': n_cls,
        'encoding': 'base64',  # tell client to decode
        'linearized': {
            'positions': to_b64(lp.flatten(), np.float32),
            'colors': to_b64(lc.flatten(), np.float32),
            'displayed': ld,
            'original_xyz': to_b64(lin_orig_xyz.flatten(), np.float64),
            'labels': to_b64(lin_labels, np.int32),
        },
        'clustered': {
            'positions': to_b64(cp.flatten(), np.float32),
            'colors': to_b64(cc.flatten(), np.float32),
            'displayed': cd,
            'original_xyz': to_b64(cls_orig_xyz.flatten(), np.float64),
            'labels': to_b64(cls_labels, np.int32),
        },
        'cluster_stats': cluster_stats,
        'cluster_colors': cluster_colors,
    }

    # Include normal/curvature colors if already computed
    if store and store.get('normal_colors') is not None:
        nc = store['normal_colors']
        curvc = store['curvature_colors']
        sub_idx = lin_orig_idx if lin_orig_idx is not None else np.arange(n_pts)
        result['linearized']['normal_colors'] = to_b64(nc[sub_idx].flatten(), np.float32)
        result['linearized']['curvature_colors'] = to_b64(curvc[sub_idx].flatten(), np.float32)
        result['normals_available'] = True

    # Store subsample indices for get_display_colors
    if store is not None:
        store['lin_orig_idx'] = lin_orig_idx if lin_orig_idx is not None else np.arange(n_pts)

    # Map annotation trunk positions to linearized coordinates
    if store and store.get('annotation') and store['annotation'].get('trees'):
        trees = store['annotation']['trees']
        trunk_xyz = np.array([[t['trunk_x'], t['trunk_y'], t['trunk_z']] for t in trees])
        if len(trunk_xyz) > 0:
            # Find exact matching point in main cloud for each annotation trunk
            pts_tree = cKDTree(pts)
            dists, nearest_idx = pts_tree.query(trunk_xyz)
            # lin_c has same indexing as pts (full array before subsampling)
            ann_lin = []
            for ti in range(len(trees)):
                idx = nearest_idx[ti]
                cluster_id = int(labels[idx]) if idx < len(labels) else -1
                entry = {
                    'x': float(lin_c[idx, 0]),
                    'y': float(lin_c[idx, 1]),
                    'z': float(lin_c[idx, 2]),
                    'instance': trees[ti]['instance'],
                    'file': trees[ti]['file'],
                    'count': trees[ti]['count'],
                    'cluster': cluster_id,
                    'match_dist': round(float(dists[ti]), 6),
                    'orig_x': trees[ti]['trunk_x'],
                    'orig_y': trees[ti]['trunk_y'],
                    'orig_z': trees[ti]['trunk_z'],
                }
                if trees[ti].get('dbh') is not None:
                    entry['dbh'] = trees[ti]['dbh']
                ann_lin.append(entry)
            result['annotation_positions'] = ann_lin

    if meta: result['meta'] = meta
    return result


def compute_normals_for_cloud(store):
    """Compute normals + curvature using PCA on k-NN (CloudCompare approach).
    Stores results in the cloud store dict. Called automatically during clustering."""
    pts = store['raw_pts']
    n_pts = len(pts)
    k = min(12, n_pts - 1)
    if k < 3:
        return

    tree = cKDTree(pts)
    _, nn_idx = tree.query(pts, k=k+1)
    nn_idx = nn_idx[:, 1:]

    neighbors = pts[nn_idx]
    centroids = neighbors.mean(axis=1, keepdims=True)
    diff = neighbors - centroids
    cov = np.einsum('nki,nkj->nij', diff, diff) / k
    eigvals, eigvecs = np.linalg.eigh(cov)

    normals = eigvecs[:, :, 0].astype(np.float32)
    eig_sum = eigvals.sum(axis=1)
    eig_sum[eig_sum < 1e-12] = 1e-12
    curvature = (eigvals[:, 0] / eig_sum).astype(np.float32)

    flip = normals[:, 2] < 0
    normals[flip] *= -1

    normal_colors = np.abs(normals).astype(np.float32)
    c_min, c_max = float(curvature.min()), float(curvature.max())
    c_range = c_max - c_min if c_max - c_min > 1e-8 else 1.0
    c_norm = (curvature - c_min) / c_range
    curv_colors = np.zeros((n_pts, 3), dtype=np.float32)
    curv_colors[:, 1] = np.clip(1.0 - c_norm, 0, 1)
    curv_colors[:, 2] = np.clip(c_norm, 0, 1)

    store['normals'] = normals
    store['curvature'] = curvature
    store['normal_colors'] = normal_colors
    store['curvature_colors'] = curv_colors


# ═══════════════════════════════════════════════════════════
# ROUTES
# ═══════════════════════════════════════════════════════════

@app.route('/')
def index():
    return render_template('index.html')


@app.route('/upload_raw', methods=['POST'])
def upload_raw():
    """Parse file and return centered raw points — NO clustering."""
    if 'pointcloud' not in request.files:
        return jsonify({'error': 'No file'}), 400
    file = request.files['pointcloud']
    if file.filename == '' or not allowed_file(file.filename):
        return jsonify({'error': 'Invalid file'}), 400

    fn = secure_filename(file.filename)
    uid = str(uuid.uuid4())[:8]
    path = os.path.join(app.config['UPLOAD_FOLDER'], f"{uid}_{fn}")
    file.save(path)
    ext = fn.rsplit('.', 1)[1].lower()

    try:
        extra = {}
        if ext in ('las', 'laz'): pts, cols, extra = parse_las(path)
        elif ext == 'ply': pts, cols, props = parse_ply(path); extra = {'properties': props}
        else: pts, cols = parse_xyz(path)

        meta = compute_meta(pts, cols)
        meta.update(extra); meta['original_filename'] = fn; meta['format'] = ext.upper()

        if cols is None:
            z = pts[:, 2]; zn, zx = z.min(), z.max(); rng = zx - zn if zx - zn > 1e-6 else 1.0; t = (z - zn) / rng
            cols = np.vstack([np.clip(0.267+t*0.726,0,1), np.clip(0.005+t*0.901,0,1), np.clip(0.329-t*0.185,0,1)]).T.astype(np.float32)
            meta['color_mode'] = 'height'
        else: meta['color_mode'] = 'rgb'

        # Handle optional annotation / ground truth file(s) — each PLY = one tree
        annotation_info = None
        ann_files = request.files.getlist('annotation')
        if ann_files and ann_files[0].filename != '':
            trees = []
            for ann_file in ann_files:
                if ann_file.filename == '': continue
                ann_fn = secure_filename(ann_file.filename)
                ann_path = os.path.join(app.config['UPLOAD_FOLDER'], f"{uid}_ann_{ann_fn}")
                ann_file.save(ann_path)
                try:
                    ann_ext = ann_fn.rsplit('.', 1)[1].lower() if '.' in ann_fn else ''

                    if ann_ext == 'csv':
                        # CSV annotation: one row per tree with X,Y,Z,DBH columns
                        import csv
                        with open(ann_path, 'r') as cf:
                            reader = csv.DictReader(cf)
                            # Normalize headers (lowercase, strip)
                            reader.fieldnames = [h.strip().lower() for h in reader.fieldnames]
                            tree_id = 0
                            for row in reader:
                                tree_id += 1
                                tx = float(row.get('x', 0))
                                ty = float(row.get('y', 0))
                                tz = float(row.get('z', 0))
                                dbh_val = row.get('dbh', '')
                                dbh_float = None
                                if dbh_val and dbh_val.strip():
                                    try: dbh_float = float(dbh_val.strip())
                                    except: pass
                                trees.append({
                                    'file': ann_fn, 'instance': tree_id,
                                    'trunk_x': tx, 'trunk_y': ty, 'trunk_z': tz,
                                    'count': 1, 'dbh': dbh_float,
                                })

                    elif ann_ext == 'ply':
                        from plyfile import PlyData
                        ply = PlyData.read(ann_path)
                        v = ply['vertex']
                        ax = np.array(v['x'], dtype=np.float64)
                        ay = np.array(v['y'], dtype=np.float64)
                        az = np.array(v['z'], dtype=np.float64)
                        inst_id = int(v.data['instance'][0]) if 'instance' in v.data.dtype.names else 0
                        # Find trunk at 1.5m above ground (DBH height)
                        z_ground = az.min()
                        target_z = z_ground + 1.5
                        # Pick points within 0.3m of target height
                        band = np.abs(az - target_z) < 0.3
                        if band.sum() == 0:
                            band = np.abs(az - target_z) < 1.0
                        if band.sum() == 0:
                            band = np.ones(len(az), dtype=bool)
                        bx, by, bz = ax[band], ay[band], az[band]
                        # Trunk center = point nearest to median XY of band
                        mx, my = np.median(bx), np.median(by)
                        d2 = (bx - mx)**2 + (by - my)**2
                        best = np.argmin(d2)
                        trees.append({
                            'file': ann_fn, 'instance': inst_id,
                            'trunk_x': float(bx[best]),
                            'trunk_y': float(by[best]),
                            'trunk_z': float(bz[best]),
                            'count': len(ax),
                        })
                except Exception as ae:
                    print(f"Annotation parse warning ({ann_fn}): {ae}")
            if trees:
                annotation_info = {'trees': trees, 'num_trees': len(trees)}
                meta['annotation_trees'] = len(trees)

        # Store pts_mean for centering annotation positions in raw view
        pts_mean = pts.mean(0)

        cloud_store[uid] = {
            'raw_pts': pts, 'raw_cols': cols, 'meta': meta,
            'labels': None, 'cluster_colors': None,
            'grid_res': None, 'overlap': None,
            'annotation': annotation_info,
            'pts_mean': pts_mean,
        }

        # Center and subsample for display
        pts_c = (pts - pts_mean).astype(np.float32)
        white_cols = np.ones_like(pts_c, dtype=np.float32)
        orig_idx = np.arange(len(pts))
        sp, sc, st_total, st_disp, sub_idx = subsample(pts_c, white_cols, 5_000_000, orig_idx)
        # Store subsample indices so /compute_normals can return correctly-indexed colors
        cloud_store[uid]['raw_sub_idx'] = sub_idx  # None means no downsampling was needed

        result = {
            'id': uid, 'name': fn, 'meta': meta,
            'positions': to_b64(sp.flatten(), np.float32),
            'colors': to_b64(sc.flatten(), np.float32),
            'displayed': st_disp,
            'encoding': 'base64',
        }

        # Send annotation positions in centered space for raw view display
        if annotation_info:
            raw_ann = []
            for t in annotation_info['trees']:
                entry = {
                    'x': float(t['trunk_x'] - pts_mean[0]),
                    'y': float(t['trunk_y'] - pts_mean[1]),
                    'z': float(t['trunk_z'] - pts_mean[2]),
                    'instance': t['instance'],
                    'file': t['file'],
                    'count': t['count'],
                    'orig_x': t['trunk_x'],
                    'orig_y': t['trunk_y'],
                    'orig_z': t['trunk_z'],
                }
                if t.get('dbh') is not None:
                    entry['dbh'] = t['dbh']
                raw_ann.append(entry)
            result['annotation'] = {
                'trees': annotation_info['trees'],
                'num_trees': annotation_info['num_trees'],
                'raw_positions': raw_ann,
            }
        return jsonify(result)
    except Exception as e:
        traceback.print_exc()
        return jsonify({'error': str(e)}), 500


@app.route('/upload', methods=['POST'])
def upload_file():
    if 'pointcloud' not in request.files:
        return jsonify({'error': 'No file'}), 400
    file = request.files['pointcloud']
    if file.filename == '' or not allowed_file(file.filename):
        return jsonify({'error': 'Invalid file'}), 400

    grid_res = float(request.form.get('grid_resolution', 0.6))
    overlap = float(request.form.get('overlap', 0.15))
    fn = secure_filename(file.filename)
    uid = str(uuid.uuid4())[:8]
    path = os.path.join(app.config['UPLOAD_FOLDER'], f"{uid}_{fn}")
    file.save(path)
    ext = fn.rsplit('.', 1)[1].lower()

    try:
        extra = {}
        if ext in ('las', 'laz'): pts, cols, extra = parse_las(path)
        elif ext == 'ply': pts, cols, props = parse_ply(path); extra = {'properties': props}
        else: pts, cols = parse_xyz(path)

        meta = compute_meta(pts, cols)
        meta.update(extra); meta['original_filename'] = fn; meta['format'] = ext.upper()

        if cols is None:
            z = pts[:, 2]; zn, zx = z.min(), z.max(); rng = zx - zn if zx - zn > 1e-6 else 1.0; t = (z - zn) / rng
            cols = np.vstack([np.clip(0.267+t*0.726,0,1), np.clip(0.005+t*0.901,0,1), np.clip(0.329-t*0.185,0,1)]).T.astype(np.float32)
            meta['color_mode'] = 'height'
        else: meta['color_mode'] = 'rgb'

        labels, n_cls = density_segmentation(pts, grid_resolution=grid_res)
        meta['n_clusters'] = n_cls
        cluster_colors = gen_cluster_colors(n_cls)

        cloud_store[uid] = {
            'raw_pts': pts, 'raw_cols': cols, 'meta': meta,
            'labels': labels, 'cluster_colors': cluster_colors,
            'grid_res': grid_res, 'overlap': overlap,
        }

        # Auto-compute normals & curvature
        compute_normals_for_cloud(cloud_store[uid])

        resp = build_response(pts, cols, labels, cluster_colors, n_cls, overlap, meta, store=cloud_store[uid])
        resp['id'] = uid; resp['name'] = fn
        return jsonify(resp)
    except Exception as e:
        traceback.print_exc()
        return jsonify({'error': str(e)}), 500


@app.route('/recluster', methods=['POST'])
def recluster():
    """Full re-clustering (grid resolution changed)."""
    data = request.get_json()
    cid = data.get('cloud_id')
    grid_res = float(data.get('grid_resolution', 0.6))
    overlap = max(-0.5, min(0.5, float(data.get('overlap', 0.15))))
    if cid not in cloud_store: return jsonify({'error': 'Cloud not found'}), 404
    store = cloud_store[cid]
    pts = store['raw_pts']
    try:
        labels, n_cls = density_segmentation(pts, grid_resolution=grid_res)
        cluster_colors = gen_cluster_colors(n_cls)
        store['labels'] = labels; store['cluster_colors'] = cluster_colors
        store['grid_res'] = grid_res; store['overlap'] = overlap
        store['meta']['n_clusters'] = n_cls
        # Auto-compute normals if not already done
        if store.get('normal_colors') is None:
            compute_normals_for_cloud(store)
        return jsonify(build_response(pts, store['raw_cols'], labels, cluster_colors, n_cls, overlap, store=store))
    except Exception as e:
        traceback.print_exc()
        return jsonify({'error': str(e)}), 500


@app.route('/relinearize', methods=['POST'])
def relinearize():
    """FAST overlap-only update — reuses existing labels, skips clustering entirely."""
    data = request.get_json()
    cid = data.get('cloud_id')
    overlap = max(-0.5, min(0.5, float(data.get('overlap', 0.15))))
    if cid not in cloud_store: return jsonify({'error': 'Cloud not found'}), 404
    store = cloud_store[cid]
    store['overlap'] = overlap
    try:
        return jsonify(build_response(
            store['raw_pts'], store['raw_cols'], store['labels'],
            store['cluster_colors'], store['meta']['n_clusters'], overlap, store=store))
    except Exception as e:
        traceback.print_exc()
        return jsonify({'error': str(e)}), 500


@app.route('/save_clicks', methods=['POST'])
def save_clicks():
    """Persist clicks to disk keyed by cloud filename."""
    data = request.get_json()
    cloud_name = data.get('cloud_name', '')
    clicks = data.get('clicks', [])
    if not cloud_name: return jsonify({'error': 'No cloud name'}), 400
    safe_name = secure_filename(cloud_name)
    path = os.path.join(clicks_dir, f"{safe_name}.json")
    with open(path, 'w') as f:
        json.dump(clicks, f)
    return jsonify({'saved': len(clicks)})


@app.route('/load_clicks', methods=['GET'])
def load_clicks():
    """Load previously saved clicks for a cloud filename."""
    cloud_name = request.args.get('cloud_name', '')
    if not cloud_name: return jsonify({'clicks': []})
    safe_name = secure_filename(cloud_name)
    path = os.path.join(clicks_dir, f"{safe_name}.json")
    if os.path.exists(path):
        with open(path) as f:
            return jsonify({'clicks': json.load(f)})
    return jsonify({'clicks': []})


@app.route('/export_clicks', methods=['POST'])
def export_clicks():
    data = request.get_json()
    clicks = data.get('clicks', [])
    if not clicks: return jsonify({'error': 'No click data'}), 400
    output = io.StringIO()
    writer = csv.writer(output)
    writer.writerow(['ID','ViewX','ViewY','ViewZ','OriginalX','OriginalY','OriginalZ',
        'PointIndex','IntersectionDistance','Timestamp','CloudName','ClusterID','ViewType',
        'CameraX','CameraY','CameraZ','CameraRotX','CameraRotY','CameraRotZ','CameraFOV','PointSize',
        'MarkerColor','MarkerSize'])
    for c in clicks:
        writer.writerow([c.get('id',''),c.get('x',''),c.get('y',''),c.get('z',''),
            c.get('originalX',''),c.get('originalY',''),c.get('originalZ',''),
            c.get('pointIndex',''),c.get('intersectionDistance',''),c.get('timestamp',''),
            c.get('cloudName',''),c.get('clusterId',''),c.get('viewType',''),
            c.get('cameraX',''),c.get('cameraY',''),c.get('cameraZ',''),
            c.get('cameraRotX',''),c.get('cameraRotY',''),c.get('cameraRotZ',''),
            c.get('cameraFov',''),c.get('pointSize',''),
            c.get('markerColor',''),c.get('markerSize','')])
    return Response(output.getvalue(), mimetype='text/csv',
                    headers={'Content-Disposition': f'attachment; filename=clicked_points_{uuid.uuid4().hex[:8]}.csv'})


@app.route('/compute_normals', methods=['POST'])
def compute_normals():
    """Compute normals + curvature. Usually auto-called during clustering, kept as fallback.
    In raw mode, returns colors indexed to the raw display subsample."""
    data = request.get_json()
    cid = data.get('cloud_id')
    if cid not in cloud_store:
        return jsonify({'error': 'Cloud not found'}), 404
    store = cloud_store[cid]
    try:
        compute_normals_for_cloud(store)
        curv = store['curvature']
        nc = store['normal_colors']
        curvc = store['curvature_colors']
        # If this is a raw (not yet clustered) cloud, return colors indexed to the raw subsample
        raw_sub_idx = store.get('raw_sub_idx')
        if store.get('labels') is None and raw_sub_idx is not None:
            nc_out = nc[raw_sub_idx]
            curvc_out = curvc[raw_sub_idx]
        else:
            nc_out = nc
            curvc_out = curvc
        return jsonify({
            'status': 'ok',
            'normal_colors': to_b64(nc_out.flatten(), np.float32),
            'curvature_colors': to_b64(curvc_out.flatten(), np.float32),
            'num_points': len(nc_out),
            'curvature_min': round(float(curv.min()), 6),
            'curvature_max': round(float(curv.max()), 6),
        })
    except Exception as e:
        traceback.print_exc()
        return jsonify({'error': str(e)}), 500


@app.route('/get_display_colors', methods=['POST'])
def get_display_colors():
    """Return normal/curvature colors for the current linearized subsample indices."""
    data = request.get_json()
    cid = data.get('cloud_id')
    if cid not in cloud_store:
        return jsonify({'error': 'Cloud not found'}), 404
    store = cloud_store[cid]
    if 'normal_colors' not in store or store['normal_colors'] is None:
        return jsonify({'error': 'Normals not computed yet'}), 400

    nc = store['normal_colors']
    curvc = store['curvature_colors']
    sub_idx = store.get('lin_orig_idx')
    if sub_idx is not None:
        nc = nc[sub_idx]
        curvc = curvc[sub_idx]

    return jsonify({
        'normal_colors': to_b64(nc.flatten(), np.float32),
        'curvature_colors': to_b64(curvc.flatten(), np.float32),
    })



@app.route('/slice_at_height', methods=['POST'])
def slice_at_height():
    """Extract a thin slice of points at a given Z height for DBH measurement."""
    data = request.get_json()
    cid = data.get('cloud_id')
    height = float(data.get('height', 1.5))
    thickness = float(data.get('thickness', 0.1))
    # Original XY center of the tree annotation
    center_x = float(data.get('center_x', 0))
    center_y = float(data.get('center_y', 0))
    radius = float(data.get('radius', 3.0))  # search radius around trunk

    if cid not in cloud_store:
        return jsonify({'error': 'Cloud not found'}), 404
    store = cloud_store[cid]
    pts = store['raw_pts']

    try:
        # Find z_ground in the local area
        dx = pts[:, 0] - center_x
        dy = pts[:, 1] - center_y
        dist2d = np.sqrt(dx*dx + dy*dy)
        local_mask = dist2d < radius
        if local_mask.sum() < 10:
            return jsonify({'error': 'Too few points near trunk'}), 400

        local_pts = pts[local_mask]
        z_ground = local_pts[:, 2].min()
        target_z = z_ground + height

        # Extract slice
        slice_mask = np.abs(local_pts[:, 2] - target_z) < thickness
        if slice_mask.sum() < 3:
            # Widen thickness
            slice_mask = np.abs(local_pts[:, 2] - target_z) < thickness * 3
        if slice_mask.sum() < 3:
            return jsonify({'error': 'No points at slice height'}), 400

        slice_pts = local_pts[slice_mask]
        # Return 2D points (X,Y) centered on trunk
        sx = slice_pts[:, 0] - center_x
        sy = slice_pts[:, 1] - center_y

        return jsonify({
            'points_x': sx.tolist(),
            'points_y': sy.tolist(),
            'count': len(sx),
            'slice_z': round(float(target_z), 4),
            'ground_z': round(float(z_ground), 4),
        })
    except Exception as e:
        traceback.print_exc()
        return jsonify({'error': str(e)}), 500


@app.route('/upload_annotation', methods=['POST'])
def upload_annotation():
    if 'annotation' not in request.files: return jsonify({'error': 'No file'}), 400
    file = request.files['annotation']
    if file.filename == '': return jsonify({'error': 'No file'}), 400
    fn = secure_filename(file.filename); uid = str(uuid.uuid4())[:8]
    path = os.path.join(app.config['UPLOAD_FOLDER'], f"{uid}_{fn}"); file.save(path)
    try:
        labels = []
        with open(path) as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith('#'): continue
                try: labels.append(int(float(line.replace(',', ' ').split()[0])))
                except: continue
        unique = sorted(set(labels))
        return jsonify({'id': uid, 'name': fn, 'parent_id': request.form.get('parent_id',''),
            'type': 'annotation', 'ann_type': 'labels', 'labels': labels, 'unique_classes': unique,
            'meta': {'num_labels': len(labels), 'num_classes': len(unique)}})
    except Exception as e:
        traceback.print_exc()
        return jsonify({'error': str(e)}), 500


if __name__ == '__main__':
    print("\n" + "="*60)
    print("  Point Cloud Viewer — Clustering + Linearization + Click Export")
    print("  http://localhost:8080")
    print("="*60 + "\n")
    app.run(debug=True, host='0.0.0.0', port=8080)
