/* ═══════════════════════════════════════════════════════════
   Point Cloud linearization Viewer
   ═══════════════════════════════════════════════════════════ */
(() => {
"use strict";

// ── State ──
let scene, camera, renderer;

// ── Base64 decode helpers ──
function b64ToFloat32(b64str) {
  const bin = atob(b64str);
  const buf = new ArrayBuffer(bin.length);
  const u8 = new Uint8Array(buf);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return new Float32Array(buf);
}
function b64ToFloat64(b64str) {
  const bin = atob(b64str);
  const buf = new ArrayBuffer(bin.length);
  const u8 = new Uint8Array(buf);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return new Float64Array(buf);
}
function b64ToInt32(b64str) {
  const bin = atob(b64str);
  const buf = new ArrayBuffer(bin.length);
  const u8 = new Uint8Array(buf);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return new Int32Array(buf);
}
function decodeArr(val, type) {
  if (typeof val === 'string') {
    if (type === 'int32') return b64ToInt32(val);
    if (type === 'float64') return b64ToFloat64(val);
    return b64ToFloat32(val);
  }
  // Fallback: plain JSON array
  if (type === 'int32') return new Int32Array(val);
  if (type === 'float64') return new Float64Array(val);
  return new Float32Array(val);
}
let cScene, cCamera, cRenderer;
let orientScene, orientCamera, orientRenderer;

let cloudData = null, cloudId = null;
let rawPoints = null;              // Original (un-clustered) cloud in main view
let isRawMode = false;             // true when showing original, false after clustering
let mainPoints = null, clusterPoints = null;
let fullLinPositions = null, fullLinColors = null;
let originalXYZ = null;       // Float64Array — original XYZ for linearized points
let linLabels = null;          // Int32Array — cluster label per linearized point
let clsLabels = null;          // Int32Array — cluster label per clustered point
let clsPositions = null;       // Float32Array — raw centered positions from clustered view
let clsColors = null;          // Float32Array — cluster colors from clustered view
let clsOrigXYZ = null;         // Float64Array — original XYZ for clustered points

// Pre-built isolated cluster meshes (instant switching)
let isolatedMeshes = {};       // clusterId → THREE.Points
let isolatedOrigXYZMap = {};   // clusterId → Float64Array
let activeIsolatedId = null;   // currently shown cluster, or null

let gridHelper = null, axesHelper = null;
let showGrid = false, showAxes = true;

// Click state
let clickedPoints = [], clickMarkers = [], clickIdCounter = 0;

// Hover state
let hoveredCluster = -1;
let linBaseColors = null;      // Float32Array — white base colors for linearized view

// Point hover ring — shows a glowing ring around the nearest point under cursor
let _hoverRing = null;         // THREE.Mesh — reused across all scenes
let _hoverRingScene = null;    // which scene the ring is currently in
let _hoverRafPending = false;  // throttle flag
let _lastHoverEvent = null;    // last mousemove event for RAF callback

// Normal/Curvature display state
let displayMode = 'white';     // 'white' | 'normal' | 'curvature'
let normalColorsData = null;   // Float32Array — normal RGB per linearized point
let curvatureColorsData = null; // Float32Array — curvature color per linearized point
let whiteColorsData = null;    // Float32Array — default white colors
let rawWhiteColorsData = null; // Float32Array — white colors for raw cloud display
let normalsComputed = false;
let whiteTintColor = [1.0, 1.0, 1.0]; // RGB tint applied in white display mode
let currentBgMode = 'gradient';       // persists across cloud reloads

// Annotation state
let annotationPositions = null;  // array of {x,y,z,instance,file,...} in linearized space
let annotationMarkers = [];      // THREE.Mesh objects for pink circles
let annotationVisible = true;    // global toggle
let annotationFileVisibility = {}; // {filename: true/false}
let linInstanceLabels = null;

// Multi-row linearized state
let linRows = [];              // [{scene, camera, vp, points, labels, origXYZ, clusterIds, baseColors}]
let isRowMode = false;
const ROW_GAP = 6;             // px gap between stacked rows
let currentRowHeight = 0;      // 0 = auto (2/3 of visible viewport height)

// Viewport states
function createVP() {
  return { pivotPoint: new THREE.Vector3(), focalDistance: 15,
    isLeftDown:false, isRightDown:false, isMiddleDown:false,
    lastMousePos: new THREE.Vector2(), mouseMoved:false };
}
const mainVP = createVP(), clsVP = createVP();

// ── Row helpers ──
function effectiveRowHeight() {
  if (currentRowHeight > 0) return currentRowHeight;
  const c = document.getElementById("viewportContainer");
  return Math.round(c.clientHeight * (2 / 3));
}
function clearLinRows() {
  linRows.forEach(r => {
    if (r.points) { r.points.geometry.dispose(); r.points.material.dispose(); }
    if (r.scene) { r.scene.children.forEach(c => { if (c.geometry) c.geometry.dispose(); }); }
  });
  linRows = []; isRowMode = false;
  document.querySelectorAll(".row-label").forEach(el => el.remove());
  const c = document.getElementById("viewportContainer");
  if (c) c.scrollTop = 0;
}
function getRowAtMouse(clientX, clientY) {
  if (!isRowMode || !linRows.length) return null;
  const c = document.getElementById("viewportContainer");
  const rect = c.getBoundingClientRect();
  // Account for scroll: clientY relative to container top + scroll offset = position in canvas
  const py = clientY - rect.top + c.scrollTop;
  const rowH = effectiveRowHeight();
  const nR = linRows.length;
  for (let i = 0; i < nR; i++) {
    const rowTop = i * (rowH + ROW_GAP), rowBot = rowTop + rowH;
    if (py >= rowTop && py < rowBot) return { row: linRows[i], idx: i, localY: py - rowTop, rowH: rowH };
  }
  return null;
}
function buildRowScenes() {
  clearLinRows();

  if (!fullLinPositions || !linLabels || linLabels.length === 0) return false;
  const nPts = linLabels.length;

  // Compute per-cluster X-bounds in linearized space
  const clBounds = {};
  for (let i = 0; i < nPts; i++) {
    const lbl = linLabels[i];
    const x = fullLinPositions[i * 3], y = fullLinPositions[i * 3 + 1], z = fullLinPositions[i * 3 + 2];
    if (!clBounds[lbl]) clBounds[lbl] = { id: lbl, xMin: x, xMax: x, yMin: y, yMax: y, zMin: z, zMax: z };
    else {
      const b = clBounds[lbl];
      if (x < b.xMin) b.xMin = x; if (x > b.xMax) b.xMax = x;
      if (y < b.yMin) b.yMin = y; if (y > b.yMax) b.yMax = y;
      if (z < b.zMin) b.zMin = z; if (z > b.zMax) b.zMax = z;
    }
  }
  const sorted = Object.values(clBounds).sort((a, b) => (a.xMin + a.xMax) / 2 - (b.xMin + b.xMax) / 2);
  if (sorted.length === 0) return false;

  // Compute max Y/Z extent across all clusters
  let gyMin = Infinity, gyMax = -Infinity, gzMin = Infinity, gzMax = -Infinity;
  sorted.forEach(b => {
    if (b.yMin < gyMin) gyMin = b.yMin; if (b.yMax > gyMax) gyMax = b.yMax;
    if (b.zMin < gzMin) gzMin = b.zMin; if (b.zMax > gzMax) gzMax = b.zMax;
  });
  const maxYZ = Math.max(gyMax - gyMin, gzMax - gzMin, 0.001);

  // Determine how many X-units of linearized space fit per row
  // Each row height = 2/3 of visible viewport (or user-set value)
  const container = document.getElementById("viewportContainer");
  const screenW = container.clientWidth;
  const rowH = effectiveRowHeight();
  const viewAspect = screenW / Math.max(rowH, 1);
  const xPerRow = viewAspect * maxYZ * 1.5;  // 1.5x padding for camera FOV

  // Pack clusters into rows based on cumulative X extent
  const rowGroups = [[]];
  let curRowX = 0;
  for (const cl of sorted) {
    const clW = cl.xMax - cl.xMin;
    if (curRowX > 0 && curRowX + clW > xPerRow) {
      rowGroups.push([]);
      curRowX = 0;
    }
    rowGroups[rowGroups.length - 1].push(cl.id);
    curRowX += clW;
  }

  // Build a scene for each row (always, even if only 1 row)
  for (const grp of rowGroups) {
    const grpSet = new Set(grp);
    const indices = [];
    for (let i = 0; i < nPts; i++) { if (grpSet.has(linLabels[i])) indices.push(i); }
    const count = indices.length;
    if (count === 0) continue;

    const pos = new Float32Array(count * 3);
    const col = new Float32Array(count * 3);
    const lbls = new Int32Array(count);
    const origXyz = originalXYZ ? new Float64Array(count * 3) : null;

    for (let j = 0; j < count; j++) {
      const si = indices[j];
      pos[j*3] = fullLinPositions[si*3]; pos[j*3+1] = fullLinPositions[si*3+1]; pos[j*3+2] = fullLinPositions[si*3+2];
      col[j*3] = fullLinColors[si*3]; col[j*3+1] = fullLinColors[si*3+1]; col[j*3+2] = fullLinColors[si*3+2];
      lbls[j] = linLabels[si];
      if (origXyz) { origXyz[j*3] = originalXYZ[si*3]; origXyz[j*3+1] = originalXYZ[si*3+1]; origXyz[j*3+2] = originalXYZ[si*3+2]; }
    }

    // Center the row's points
    let cx = 0, cy = 0, cz = 0;
    for (let j = 0; j < count; j++) { cx += pos[j*3]; cy += pos[j*3+1]; cz += pos[j*3+2]; }
    cx /= count; cy /= count; cz /= count;
    for (let j = 0; j < count; j++) { pos[j*3] -= cx; pos[j*3+1] -= cy; pos[j*3+2] -= cz; }

    const rowScene = new THREE.Scene(); setBg(currentBgMode, rowScene);
    rowScene.add(new THREE.AmbientLight(0xffffff, 0.6));
    const dl = new THREE.DirectionalLight(0xffffff, 0.8); dl.position.set(10, 20, 10); rowScene.add(dl);
    const rowCam = new THREE.PerspectiveCamera(60, screenW / Math.max(rowH, 1), 0.001, 5000);
    const rowVP = createVP();
    const pts = makePoints(pos, col); rowScene.add(pts);
    fitCameraFront(pts, rowCam, rowVP);
    linRows.push({
      scene: rowScene, camera: rowCam, vp: rowVP, points: pts,
      labels: lbls,
      origXYZ: origXyz || new Float64Array(0),
      clusterIds: grp,
      baseColors: new Float32Array(col),
      centerOffset: { x: cx, y: cy, z: cz },
    });
  }

  if (linRows.length === 0) return false;
  isRowMode = true;
  updateRowLabels();
  return true;
}
function updateRowLabels() {
  document.querySelectorAll(".row-label").forEach(el => el.remove());
  if (!isRowMode || linRows.length === 0) return;
  const c = document.getElementById("viewportContainer");
  const rowH = effectiveRowHeight();
  linRows.forEach((r, i) => {
    const lbl = document.createElement("div"); lbl.className = "row-label";
    const ids = r.clusterIds;
    lbl.textContent = ids.length <= 6 ? `Clusters #${ids.join(", #")}` : `Clusters #${ids[0]}–#${ids[ids.length-1]}`;
    lbl.style.top = (i * (rowH + ROW_GAP) + 4) + "px";
    c.appendChild(lbl);
  });
}

let fCnt = 0, fTime = performance.now();

// Track last known Eps_Param for detecting real re-cluster need
let lastEpsParam = 0.6;


// ═══════════════════════════════════════════════════════════
// INIT
// ═══════════════════════════════════════════════════════════

function init() {
  initMainViewport();
  initClusterViewport();
  initOrientCube();
  setupMainControls();
  setupClusterControls();
  setupMenus();
  setupToolbar();
  setupUpload();
  setupPanelResize();
  setupRecluster();
  setupClickExport();
  setupDbh();
  setupContextMenuActions();
  window.addEventListener("resize", onResize);
  document.getElementById("clearIsolation").addEventListener("click", clearIsolation);
  animate();
  status("Ready — File → Open to begin. Double-click to mark points.");
}


// ═══════════════════════════════════════════════════════════
// VIEWPORTS
// ═══════════════════════════════════════════════════════════

function initMainViewport() {
  const c = document.getElementById("viewportContainer");
  scene = new THREE.Scene(); setBg(currentBgMode, scene);
  camera = new THREE.PerspectiveCamera(60, c.clientWidth/c.clientHeight, 0.001, 5000);
  camera.position.set(0,5,15); camera.lookAt(0,0,0);
  renderer = new THREE.WebGLRenderer({antialias:true, preserveDrawingBuffer:true});
  renderer.setSize(c.clientWidth, c.clientHeight);
  //renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setPixelRatio(1);
  c.appendChild(renderer.domElement);
  scene.add(new THREE.AmbientLight(0xffffff, 0.6));
  const dl = new THREE.DirectionalLight(0xffffff, 0.8); dl.position.set(10,20,10); scene.add(dl);
  axesHelper = makeAxes(2); scene.add(axesHelper);
}

function initClusterViewport() {
  const c = document.getElementById("clusterViewContainer"); if (!c) return;
  cScene = new THREE.Scene(); setBg(currentBgMode, cScene);
  const w = c.clientWidth||296, h = c.clientHeight||200;
  cCamera = new THREE.PerspectiveCamera(60, w/Math.max(h,1), 0.001, 5000);
  cCamera.position.set(0,5,15); cCamera.lookAt(0,0,0);
  cRenderer = new THREE.WebGLRenderer({antialias:true});
  cRenderer.setSize(w,h); cRenderer.setPixelRatio(Math.min(window.devicePixelRatio,2));
  c.appendChild(cRenderer.domElement);
  cScene.add(new THREE.AmbientLight(0xffffff, 0.6));
  const dl = new THREE.DirectionalLight(0xffffff, 0.8); dl.position.set(10,20,10); cScene.add(dl);
  cScene.add(makeAxes(1.5));
  new ResizeObserver(() => {
    const w2=c.clientWidth, h2=c.clientHeight;
    if (w2>0 && h2>0 && cRenderer) { cCamera.aspect=w2/h2; cCamera.updateProjectionMatrix(); cRenderer.setSize(w2,h2); }
  }).observe(c);
}

function setBg(mode, s) {
  if (mode==="gradient") {
    const cv=document.createElement("canvas"); cv.width=2; cv.height=512;
    const ctx=cv.getContext("2d"), g=ctx.createLinearGradient(0,0,0,512);
    g.addColorStop(0,"#0a1628"); g.addColorStop(0.5,"#0f2847"); g.addColorStop(1,"#e8e8e8");
    ctx.fillStyle=g; ctx.fillRect(0,0,2,512); s.background=new THREE.CanvasTexture(cv);
  } else if (mode==="black") { s.background=new THREE.Color(0); }
  else { s.background=new THREE.Color(0xffffff); }
}

function makeAxes(len) {
  const g=new THREE.Group();
  [[1,0,0,0xff4444],[0,1,0,0x44ff44],[0,0,1,0x4444ff]].forEach(([x,y,z,c])=>{
    const geo=new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(),new THREE.Vector3(x*len,y*len,z*len)]);
    g.add(new THREE.Line(geo, new THREE.LineBasicMaterial({color:c})));
  }); return g;
}

function initOrientCube() {
  const cv=document.getElementById("cubeCanvas"); if(!cv) return;
  orientScene=new THREE.Scene();
  orientCamera=new THREE.PerspectiveCamera(50,1,0.1,100); orientCamera.position.set(0,0,3);
  orientRenderer=new THREE.WebGLRenderer({canvas:cv,alpha:true,antialias:true});
  orientRenderer.setSize(90,90); orientRenderer.setClearColor(0,0);
  [[0.9,0,0,0xff4444],[0,0.9,0,0x44ff44],[0,0,0.9,0x4444ff]].forEach(([x,y,z,c])=>{
    const geo=new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(),new THREE.Vector3(x,y,z)]);
    orientScene.add(new THREE.Line(geo,new THREE.LineBasicMaterial({color:c})));
    const s=new THREE.Mesh(new THREE.SphereGeometry(0.07,8,8),new THREE.MeshBasicMaterial({color:c}));
    s.position.set(x,y,z); orientScene.add(s);
  });
}

function updateOrientCube() {
  if(!orientCamera||!orientRenderer) return;
  const refCam = (isRowMode && linRows.length > 0 && activeIsolatedId === null) ? linRows[0].camera : camera;
  orientCamera.position.copy(refCam.position).normalize().multiplyScalar(3);
  orientCamera.up.copy(refCam.up); orientCamera.lookAt(0,0,0);
  orientRenderer.render(orientScene, orientCamera);
}


// ═══════════════════════════════════════════════════════════
// CAMERA CONTROLS — from unified-viewer.js
// ═══════════════════════════════════════════════════════════

function setupMainControls() {
  const el = renderer.domElement;
  let dragCam = null, dragVP = null;
  el.addEventListener("mousedown", e => {
    if (isRowMode) {
      const ri = getRowAtMouse(e.clientX, e.clientY);
      if (ri) { dragCam = ri.row.camera; dragVP = ri.row.vp; }
      else return;
    } else { dragCam = camera; dragVP = mainVP; }
    dragVP.mouseMoved=false; dragVP.lastMousePos.set(e.clientX,e.clientY);
    if(e.button===0) dragVP.isLeftDown=true;
    if(e.button===1){dragVP.isMiddleDown=true; e.preventDefault();}
    if(e.button===2) dragVP.isRightDown=true;
  });
  el.addEventListener("mousemove", e => {
    updateCoordReadout(e);
    highlightNearestAnnotationRow(e);
    updatePointHoverRing(e);
    if(!dragVP||(!dragVP.isLeftDown&&!dragVP.isRightDown&&!dragVP.isMiddleDown)) return;
    const cur=new THREE.Vector2(e.clientX,e.clientY), delta=new THREE.Vector2().subVectors(cur,dragVP.lastMousePos);
    if(delta.length()>1.5) dragVP.mouseMoved=true;
    if(dragVP.isLeftDown&&!e.ctrlKey&&!e.shiftKey) handleRotation(delta,dragCam,dragVP);
    if(dragVP.isRightDown) handlePanning(delta,dragCam,dragVP);
    if((e.ctrlKey&&dragVP.isLeftDown)||dragVP.isMiddleDown||(e.shiftKey&&dragVP.isLeftDown)) handlePanning(delta,dragCam,dragVP);
    dragVP.lastMousePos.copy(cur);
  });
  el.addEventListener("mouseup", ()=>{if(dragVP){dragVP.isLeftDown=dragVP.isRightDown=dragVP.isMiddleDown=false;}});
  el.addEventListener("mouseleave", () => { clearPointHoverRing(); });
  el.addEventListener("wheel", e=>{
    if (isRowMode) {
      const ri = getRowAtMouse(e.clientX, e.clientY);
      if (ri) {
        // Zoom the row under cursor (always, no Ctrl needed)
        e.preventDefault();
        handleZoom(e, ri.row.camera, ri.row.vp);
      }
      // If cursor is not over a row (in gap or outside), let browser scroll
    } else {
      e.preventDefault();
      handleZoom(e,camera,mainVP);
    }
  },{passive:false});
  el.addEventListener("dblclick", e=>{
    clearPointHoverRing();
    if (isRowMode) {
      const ri = getRowAtMouse(e.clientX, e.clientY);
      if (ri && !ri.row.vp.mouseMoved) onRowDoubleClick(e, ri);
    } else if(!mainVP.mouseMoved) onMainDoubleClick(e);
  });
  el.addEventListener("contextmenu", e=>e.preventDefault());
  document.addEventListener("keydown", onKeyDown);
}

function setupClusterControls() {
  const c=document.getElementById("clusterViewContainer"); if(!c) return;
  const wait=setInterval(()=>{
    const el=c.querySelector("canvas"); if(!el) return; clearInterval(wait);
    el.addEventListener("mousedown", e=>{
      e.stopPropagation(); clsVP.mouseMoved=false; clsVP.lastMousePos.set(e.clientX,e.clientY);
      if(e.button===0)clsVP.isLeftDown=true; if(e.button===1){clsVP.isMiddleDown=true;e.preventDefault();} if(e.button===2)clsVP.isRightDown=true;
    });
    el.addEventListener("mousemove", e=>{
      e.stopPropagation();
      // Hover highlight (even when not dragging)
      onClusterHover(e);
      if(!clsVP.isLeftDown&&!clsVP.isRightDown&&!clsVP.isMiddleDown) return;
      const cur=new THREE.Vector2(e.clientX,e.clientY), delta=new THREE.Vector2().subVectors(cur,clsVP.lastMousePos);
      if(delta.length()>1.5) clsVP.mouseMoved=true;
      if(clsVP.isLeftDown&&!e.ctrlKey&&!e.shiftKey) handleRotation(delta,cCamera,clsVP);
      if(clsVP.isRightDown) handlePanning(delta,cCamera,clsVP);
      if((e.ctrlKey&&clsVP.isLeftDown)||clsVP.isMiddleDown||(e.shiftKey&&clsVP.isLeftDown)) handlePanning(delta,cCamera,clsVP);
      clsVP.lastMousePos.copy(cur);
    });
    el.addEventListener("mouseup", e=>{
      e.stopPropagation();
      if(clsVP.isLeftDown&&!clsVP.mouseMoved&&e.button===0) onClusterClick(e);
      clsVP.isLeftDown=clsVP.isRightDown=clsVP.isMiddleDown=false;
    });
    el.addEventListener("mouseleave", ()=>{
      // Clear hover highlight when mouse leaves cluster view
      clearHoverHighlight();
    });
    el.addEventListener("wheel", e=>{e.preventDefault();e.stopPropagation();handleZoom(e,cCamera,clsVP);},{passive:false});
    el.addEventListener("contextmenu", e=>{e.preventDefault();e.stopPropagation();});
  },100);
}

function handleRotation(d,cam,vp) {
  const s=0.005, dx=-d.x*s, dy=-d.y*s;
  const cp=cam.position.clone(), tp=vp.pivotPoint.clone();
  const vd=new THREE.Vector3().subVectors(tp,cp).normalize();
  const r=new THREE.Vector3().crossVectors(vd,cam.up.clone().normalize()).normalize();
  const u=new THREE.Vector3().crossVectors(r,vd).normalize();
  const hq=new THREE.Quaternion().setFromAxisAngle(u,dx);
  const vq=new THREE.Quaternion().setFromAxisAngle(r,dy);
  const cq=new THREE.Quaternion().multiplyQuaternions(hq,vq);
  const off=new THREE.Vector3().subVectors(cp,tp); off.applyQuaternion(cq);
  cam.position.copy(tp).add(off);
  cam.up.copy(u).applyQuaternion(cq).normalize();
  cam.lookAt(vp.pivotPoint);
  vp.focalDistance=cam.position.distanceTo(vp.pivotPoint);
}

function handlePanning(d,cam,vp) {
  const dist=cam.position.distanceTo(vp.pivotPoint);
  const ps=2.0*dist*Math.tan((cam.fov*Math.PI/180)/2)/Math.max(window.innerWidth,window.innerHeight);
  const vd=new THREE.Vector3(); cam.getWorldDirection(vd);
  const cr=new THREE.Vector3().crossVectors(vd,cam.up).normalize();
  const cu=new THREE.Vector3().crossVectors(cr,vd).normalize();
  const po=new THREE.Vector3(); po.addScaledVector(cr,-d.x*ps); po.addScaledVector(cu,d.y*ps);
  cam.position.add(po); vp.pivotPoint.add(po);
  vp.focalDistance=cam.position.distanceTo(vp.pivotPoint);
}

function handleZoom(event,cam,vp) {
  const zf=event.deltaY>0?1.1:0.9;
  const dir=new THREE.Vector3().subVectors(vp.pivotPoint,cam.position).normalize();
  const cd=cam.position.distanceTo(vp.pivotPoint);
  const dd=cd*(1-zf), nd=Math.max(0.01,Math.min(5000,cd-dd));
  cam.position.addScaledVector(dir,cd-nd);
  vp.focalDistance=nd;
  if(cam===camera) updateMarkerSizes();
}


// ═══════════════════════════════════════════════════════════
// POINT HOVER RING — glowing border around candidate click target
// ═══════════════════════════════════════════════════════════

function _getOrCreateHoverRing() {
  if (_hoverRing) return _hoverRing;
  // Build a circle outline using LineLoop
  const segments = 32;
  const pts = [];
  for (let i = 0; i <= segments; i++) {
    const a = (i / segments) * Math.PI * 2;
    pts.push(new THREE.Vector3(Math.cos(a), Math.sin(a), 0));
  }
  const geo = new THREE.BufferGeometry().setFromPoints(pts);
  const mat = new THREE.LineBasicMaterial({
    color: 0xffffff,
    transparent: true,
    opacity: 0.92,
    depthTest: false,
    linewidth: 1,  // note: only >1 on some WebGL implementations
  });
  _hoverRing = new THREE.LineLoop(geo, mat);
  _hoverRing.renderOrder = 9999;
  _hoverRing.visible = false;
  return _hoverRing;
}

function _placeHoverRing(scene, position, radius) {
  const ring = _getOrCreateHoverRing();
  // Move ring to new scene if needed
  if (_hoverRingScene && _hoverRingScene !== scene) {
    _hoverRingScene.remove(ring);
  }
  if (_hoverRingScene !== scene) {
    scene.add(ring);
    _hoverRingScene = scene;
  }
  ring.position.copy(position);
  ring.scale.setScalar(radius);
  ring.visible = true;
  // Pulse the opacity slightly using elapsed time
  const t = (performance.now() % 1200) / 1200;
  const pulse = 0.65 + 0.35 * Math.sin(t * Math.PI * 2);
  ring.material.opacity = pulse;
}

function clearPointHoverRing() {
  if (_hoverRing) _hoverRing.visible = false;
}

function _hoverRingRadius(camera, vp) {
  // Scale ring so it appears as a fixed screen-space circle regardless of zoom
  const dist = camera.position.distanceTo(vp.pivotPoint);
  return Math.max(0.02, dist * 0.018);
}

function updatePointHoverRing(e) {
  // Throttle to one raycast per animation frame
  _lastHoverEvent = e;
  if (_hoverRafPending) return;
  _hoverRafPending = true;
  requestAnimationFrame(() => {
    _hoverRafPending = false;
    const ev = _lastHoverEvent;
    if (!ev) return;

    if (isRowMode && linRows.length > 0) {
      const ri = getRowAtMouse(ev.clientX, ev.clientY);
      if (!ri) { clearPointHoverRing(); return; }

      const rect = renderer.domElement.getBoundingClientRect();
      const mx = ((ev.clientX - rect.left) / rect.width) * 2 - 1;
      const my = -((ri.localY) / ri.rowH) * 2 + 1;
      const rc = new THREE.Raycaster();
      rc.setFromCamera(new THREE.Vector2(mx, my), ri.row.camera);
      const dist = ri.row.camera.position.distanceTo(ri.row.vp.pivotPoint);
      rc.params.Points.threshold = Math.max(0.005, Math.min(0.3, 0.012 * (dist / 15)));

      const hits = rc.intersectObject(ri.row.points);
      const colAttr = ri.row.points.geometry.attributes.color;
      const validHit = hits.find(ix => {
        if (!colAttr) return true;
        return (colAttr.getX(ix.index) + colAttr.getY(ix.index) + colAttr.getZ(ix.index)) >= 0.01;
      });

      if (!validHit) { clearPointHoverRing(); return; }
      const pa = ri.row.points.geometry.attributes.position;
      const pos = new THREE.Vector3(pa.getX(validHit.index), pa.getY(validHit.index), pa.getZ(validHit.index));
      _placeHoverRing(ri.row.scene, pos, _hoverRingRadius(ri.row.camera, ri.row.vp));

    } else {
      const target = getActiveMainTarget();
      if (!target) { clearPointHoverRing(); return; }
      const rect = renderer.domElement.getBoundingClientRect();
      const mx = ((ev.clientX - rect.left) / rect.width) * 2 - 1;
      const my = -((ev.clientY - rect.top) / rect.height) * 2 + 1;
      const rc = new THREE.Raycaster();
      rc.setFromCamera(new THREE.Vector2(mx, my), camera);
      const dist = camera.position.distanceTo(mainVP.pivotPoint);
      rc.params.Points.threshold = Math.max(0.005, Math.min(0.3, 0.012 * (dist / 15)));

      const hits = rc.intersectObject(target);
      const colAttr = target.geometry.attributes.color;
      const validHit = hits.find(ix => {
        if (!colAttr) return true;
        return (colAttr.getX(ix.index) + colAttr.getY(ix.index) + colAttr.getZ(ix.index)) >= 0.01;
      });

      if (!validHit) { clearPointHoverRing(); return; }
      const pa = target.geometry.attributes.position;
      const pos = new THREE.Vector3(pa.getX(validHit.index), pa.getY(validHit.index), pa.getZ(validHit.index));
      _placeHoverRing(scene, pos, _hoverRingRadius(camera, mainVP));
    }
  });
}

// ═══════════════════════════════════════════════════════════
// HOVER HIGHLIGHT — cluster in right panel → highlight in main
// ═══════════════════════════════════════════════════════════

function onClusterHover(e) {
  if (!clusterPoints || !cloudData || !linLabels || !mainPoints) return;
  // Don't highlight while dragging
  if (clsVP.isLeftDown || clsVP.isRightDown || clsVP.isMiddleDown) return;
  // Don't highlight when an isolated cluster is shown
  if (activeIsolatedId !== null) return;

  const c = document.getElementById("clusterViewContainer"), canvas = c.querySelector("canvas");
  if (!canvas) return;
  const rect = canvas.getBoundingClientRect();
  const mx = ((e.clientX - rect.left) / rect.width) * 2 - 1;
  const my = -((e.clientY - rect.top) / rect.height) * 2 + 1;

  const rc = new THREE.Raycaster();
  rc.setFromCamera(new THREE.Vector2(mx, my), cCamera);
  rc.params.Points.threshold = Math.max(0.01, clsVP.focalDistance * 0.005);
  const hits = rc.intersectObject(clusterPoints);

  if (!hits.length) {
    if (hoveredCluster !== -1) clearHoverHighlight();
    return;
  }

  // Find which cluster this point belongs to
  const idx = hits[0].index;
  const clusterId = clsLabels ? clsLabels[idx] : -1;
  if (clusterId < 0) { clearHoverHighlight(); return; }

  if (clusterId === hoveredCluster) return; // already highlighted

  applyHoverHighlight(clusterId);
}

function applyHoverHighlight(clusterId) {
  if (!cloudData) return;
  hoveredCluster = clusterId;
  const cc = cloudData.cluster_colors[clusterId];
  if (!cc) return;

  // Row mode: highlight in each row's points
  if (isRowMode && linRows.length > 0) {
    linRows.forEach(r => {
      const colAttr = r.points.geometry.attributes.color;
      const arr = colAttr.array;
      const n = r.labels.length;
      for (let i = 0; i < n; i++) {
        if (r.labels[i] === clusterId) {
          arr[i*3] = cc[0]; arr[i*3+1] = cc[1]; arr[i*3+2] = cc[2];
        } else {
          arr[i*3] = 0.25; arr[i*3+1] = 0.25; arr[i*3+2] = 0.25;
        }
      }
      colAttr.needsUpdate = true;
    });
    return;
  }

  // Single-scene mode: highlight in mainPoints
  if (!mainPoints || !linLabels || !linBaseColors) return;
  const colAttr = mainPoints.geometry.attributes.color;
  const arr = colAttr.array;
  const n = linLabels.length;
  for (let i = 0; i < n; i++) {
    if (linLabels[i] === clusterId) {
      arr[i*3] = cc[0]; arr[i*3+1] = cc[1]; arr[i*3+2] = cc[2];
    } else {
      arr[i*3] = 0.25; arr[i*3+1] = 0.25; arr[i*3+2] = 0.25;
    }
  }
  colAttr.needsUpdate = true;
}

function clearHoverHighlight() {
  if (hoveredCluster === -1) return;
  hoveredCluster = -1;

  // Row mode: restore white base colors on each row
  if (isRowMode && linRows.length > 0) {
    linRows.forEach(r => {
      const colAttr = r.points.geometry.attributes.color;
      colAttr.array.set(r.baseColors);
      colAttr.needsUpdate = true;
    });
    return;
  }

  // Single-scene mode
  if (!mainPoints || !linBaseColors) return;
  const colAttr = mainPoints.geometry.attributes.color;
  colAttr.array.set(linBaseColors);
  colAttr.needsUpdate = true;
}


// ═══════════════════════════════════════════════════════════
// CLICK CAPTURE — with original XYZ lookup
// ═══════════════════════════════════════════════════════════

function onMainDoubleClick(event) {
  const target = getActiveMainTarget();
  if (!target) return;

  const rect=renderer.domElement.getBoundingClientRect();
  const mx=((event.clientX-rect.left)/rect.width)*2-1;
  const my=-((event.clientY-rect.top)/rect.height)*2+1;
  const rc=new THREE.Raycaster();
  rc.setFromCamera(new THREE.Vector2(mx,my),camera);

  const distance=camera.position.distanceTo(mainVP.pivotPoint);
  const dynThresh=Math.max(0.005, Math.min(0.3, 0.01*(distance/15)));
  rc.params.Points.threshold=dynThresh;

  // Check existing markers first → remove
  if (clickMarkers.length>0) {
    const mh=rc.intersectObjects(clickMarkers,true);
    if (mh.length>0) {
      let hit=mh[0].object;
      while(hit.parent&&!hit.userData.isClickMarker) hit=hit.parent;
      const idx=clickMarkers.indexOf(hit);
      if(idx!==-1){
        const removedClick = clickedPoints[idx];
        scene.remove(hit); clickMarkers.splice(idx,1);
        clickedPoints.splice(idx,1);
        updateClickCount();
        autoSaveClicks();
        if (removedClick) removeClickLogEntry(removedClick.id);
        status(`Removed marker. ${clickedPoints.length} clicks remaining.`);
        return;
      }
    }
  }

  // Raycast with escalating thresholds
  let intersects=rc.intersectObject(target), threshUsed=dynThresh;
  if(!intersects.length){threshUsed=dynThresh*2;rc.params.Points.threshold=threshUsed;intersects=rc.intersectObject(target);}
  if(!intersects.length){threshUsed=dynThresh*4;rc.params.Points.threshold=threshUsed;intersects=rc.intersectObject(target);}

  // Skip invisible (black/discarded) points — the shader discards them visually but
  // Three.js raycasting still hits them, causing misses from certain viewpoints.
  const colAttrMain = target.geometry.attributes.color;
  const hit = intersects.find(ix => {
    if (!colAttrMain) return true;
    const r = colAttrMain.getX(ix.index), g = colAttrMain.getY(ix.index), b = colAttrMain.getZ(ix.index);
    return (r + g + b) >= 0.01;
  });

  if (hit) {
    const pi=hit.index;
    const pa=target.geometry.attributes.position;
    if(pi>=pa.count) return;

    const ex=pa.getX(pi), ey=pa.getY(pi), ez=pa.getZ(pi);

    // Look up ORIGINAL XYZ
    let origX='', origY='', origZ='';
    const activeOrigXYZ = (activeIsolatedId !== null) ? isolatedOrigXYZMap[activeIsolatedId] : originalXYZ;
    if (activeOrigXYZ && pi*3+2 < activeOrigXYZ.length) {
      origX = activeOrigXYZ[pi*3];
      origY = activeOrigXYZ[pi*3+1];
      origZ = activeOrigXYZ[pi*3+2];
    }

    const viewType = (activeIsolatedId !== null) ? `cluster_${activeIsolatedId}` : 'linearized';

    // Always determine true cluster membership from labels
    let trueClusterId = activeIsolatedId !== null ? activeIsolatedId : -1;
    if (activeIsolatedId === null && linLabels && pi < linLabels.length) {
      trueClusterId = linLabels[pi];
    }

    const clickData = {
      id: ++clickIdCounter,
      x: hit.point.x, y: hit.point.y, z: hit.point.z,
      exactX: ex, exactY: ey, exactZ: ez,
      originalX: origX, originalY: origY, originalZ: origZ,
      pointIndex: pi, intersectionDistance: hit.point.distanceTo(new THREE.Vector3(ex,ey,ez)),
      timestamp: Date.now(),
      cloudName: cloudData ? cloudData.name : 'unknown',
      clusterId: trueClusterId,
      instanceLabel: (function() {
        if (!annotationPositions || !annotationPositions.length || origX === '' || origX === undefined) return null;
        let best = null, bestD = 4.0;
        for (const a of annotationPositions) {
          const dx = a.orig_x - Number(origX), dy = a.orig_y - Number(origY), dz = a.orig_z - Number(origZ);
          const d = Math.sqrt(dx*dx+dy*dy+dz*dz);
          if (d < bestD) { bestD = d; best = a.instance; }
        }
        return best;
      })(),
      viewType: viewType,
      pointSize: getMaterialSize(target.material),
      markerColor: document.getElementById('markerColor').value || '#ff0000',
      markerSize: parseFloat(document.getElementById('markerSizeSlider').value) || 1.0,
      cameraX:camera.position.x, cameraY:camera.position.y, cameraZ:camera.position.z,
      cameraRotX:camera.rotation.x, cameraRotY:camera.rotation.y, cameraRotZ:camera.rotation.z,
      cameraFov:camera.fov, cameraDistance:distance
    };

    clickedPoints.push(clickData);
    const marker=createClickMarker(new THREE.Vector3(ex,ey,ez), clickData.markerColor, clickData.markerSize);
    clickMarkers.push(marker); scene.add(marker);
    updateClickCount();
    autoSaveClicks();
    addClickLogEntry(clickData);

    const origStr = origX!=='' ? ` | Orig(${Number(origX).toFixed(3)}, ${Number(origY).toFixed(3)}, ${Number(origZ).toFixed(3)})` : '';
    status(`Click #${clickIdCounter} — Pt #${pi} at (${ex.toFixed(3)}, ${ey.toFixed(3)}, ${ez.toFixed(3)})${origStr}`);
  } else {
    status("No point found under cursor. Try zooming in.");
  }
}

function getActiveMainTarget() {
  if (isRawMode && rawPoints) return rawPoints;
  if (activeIsolatedId !== null && isolatedMeshes[activeIsolatedId]) {
    return isolatedMeshes[activeIsolatedId];
  }
  return mainPoints;
}

function onRowDoubleClick(event, ri) {
  // DBH mode: ONLY circle fitting, never fall through to point marking
  if (dbhTopViewMode && dbhSliceActive) {
    onDbhDoubleClick(ri, event);
    return;
  }
  const rect = renderer.domElement.getBoundingClientRect();
  const mx = ((event.clientX - rect.left) / rect.width) * 2 - 1;
  const my = -((ri.localY) / ri.rowH) * 2 + 1;
  const rc = new THREE.Raycaster();
  rc.setFromCamera(new THREE.Vector2(mx, my), ri.row.camera);
  const distance = ri.row.camera.position.distanceTo(ri.row.vp.pivotPoint);
  rc.params.Points.threshold = Math.max(0.005, Math.min(0.3, 0.01 * (distance / 15)));

  // Check existing markers in THIS row scene first → remove
  const rowMarkers = clickMarkers.filter(m => m.parent === ri.row.scene);
  if (rowMarkers.length > 0) {
    const mh = rc.intersectObjects(rowMarkers, true);
    if (mh.length > 0) {
      let hit = mh[0].object;
      while (hit.parent && !hit.userData.isClickMarker) hit = hit.parent;
      const idx = clickMarkers.indexOf(hit);
      if (idx !== -1) {
        const removedClick = clickedPoints[idx];
        ri.row.scene.remove(hit); clickMarkers.splice(idx, 1);
        clickedPoints.splice(idx, 1);
        updateClickCount(); autoSaveClicks();
        if (removedClick) removeClickLogEntry(removedClick.id);
        status(`Removed marker. ${clickedPoints.length} clicks remaining.`);
        return;
      }
    }
  }

  let intersects = rc.intersectObject(ri.row.points);
  if (!intersects.length) { rc.params.Points.threshold *= 3; intersects = rc.intersectObject(ri.row.points); }

  // Skip invisible (black/discarded) points
  const colAttrRow = ri.row.points.geometry.attributes.color;
  const rowHit = intersects.find(ix => {
    if (!colAttrRow) return true;
    const r = colAttrRow.getX(ix.index), g = colAttrRow.getY(ix.index), b = colAttrRow.getZ(ix.index);
    return (r + g + b) >= 0.01;
  });

  if (rowHit) {
    const hit = rowHit, pi = hit.index;
    const pa = ri.row.points.geometry.attributes.position;
    if (pi >= pa.count) return;
    const ex = pa.getX(pi), ey = pa.getY(pi), ez = pa.getZ(pi);
    let origX = '', origY = '', origZ = '';
    if (ri.row.origXYZ && pi * 3 + 2 < ri.row.origXYZ.length) {
      origX = ri.row.origXYZ[pi * 3]; origY = ri.row.origXYZ[pi * 3 + 1]; origZ = ri.row.origXYZ[pi * 3 + 2];
    }
    let trueClusterId = -1;
    if (ri.row.labels && pi < ri.row.labels.length) trueClusterId = ri.row.labels[pi];
    // Look up instance label from annotation centroids
    let instanceLabel = null;
    if (origX !== '' && annotationPositions && annotationPositions.length > 0) {
      let bestDist = 2.0;  // threshold in meters
      for (const ann of annotationPositions) {
        const dx = ann.orig_x - Number(origX), dy = ann.orig_y - Number(origY), dz = ann.orig_z - Number(origZ);
        const d = Math.sqrt(dx*dx + dy*dy + dz*dz);
        if (d < bestDist) { bestDist = d; instanceLabel = ann.instance; }
      }
    }
    const clickData = {
      id: ++clickIdCounter,
      x: hit.point.x, y: hit.point.y, z: hit.point.z,
      exactX: ex, exactY: ey, exactZ: ez,
      originalX: origX, originalY: origY, originalZ: origZ,
      pointIndex: pi, intersectionDistance: 0,
      timestamp: Date.now(),
      cloudName: cloudData ? cloudData.name : 'unknown',
      clusterId: trueClusterId, instanceLabel: instanceLabel, viewType: `linearized_row_${ri.idx}`,
      pointSize: getMaterialSize(ri.row.points.material),
      markerColor: document.getElementById('markerColor').value || '#ff0000',
      markerSize: parseFloat(document.getElementById('markerSizeSlider').value) || 1.0,
      cameraX: ri.row.camera.position.x, cameraY: ri.row.camera.position.y, cameraZ: ri.row.camera.position.z,
      cameraRotX: ri.row.camera.rotation.x, cameraRotY: ri.row.camera.rotation.y, cameraRotZ: ri.row.camera.rotation.z,
      cameraFov: ri.row.camera.fov, cameraDistance: distance
    };
    clickedPoints.push(clickData);
    const marker = createClickMarker(new THREE.Vector3(ex, ey, ez), clickData.markerColor, clickData.markerSize);
    clickMarkers.push(marker); ri.row.scene.add(marker);
    updateClickCount(); autoSaveClicks();
    addClickLogEntry(clickData);
    const origStr = origX !== '' ? ` | Orig(${Number(origX).toFixed(3)}, ${Number(origY).toFixed(3)}, ${Number(origZ).toFixed(3)})` : '';
    status(`Click #${clickIdCounter} — Row ${ri.idx} Pt #${pi} at (${ex.toFixed(3)}, ${ey.toFixed(3)}, ${ez.toFixed(3)})${origStr}`);
  }
}

function calculateMarkerSize() {
  const d=camera.position.distanceTo(mainVP.pivotPoint);
  return Math.max(0.015, Math.min(0.8, 0.02*Math.max(1,d/5)));
}

function createClickMarker(pos, colorHex, sizeMult) {
  colorHex = colorHex || '#ff0000';
  sizeMult = sizeMult || 1.0;
  const sz=calculateMarkerSize() * sizeMult;
  const color = new THREE.Color(colorHex);
  const glowColor = color.clone().lerp(new THREE.Color(0xffffff), 0.3);
  const mat=new THREE.MeshBasicMaterial({color:color,transparent:true,opacity:0.85,depthTest:true,depthWrite:true});
  const m=new THREE.Mesh(new THREE.SphereGeometry(sz,20,20),mat);
  m.position.copy(pos); m.renderOrder=999;
  const gm=new THREE.MeshBasicMaterial({color:glowColor,transparent:true,opacity:0.25,depthTest:true,depthWrite:false});
  m.add(new THREE.Mesh(new THREE.SphereGeometry(sz*1.4,16,16),gm));
  m.userData={baseSize:sz, isClickMarker:true, sizeMultiplier:sizeMult};
  return m;
}

function updateMarkerSizes() {
  if(!clickMarkers.length) return;
  const ns=calculateMarkerSize();
  clickMarkers.forEach(m=>{
    if(m&&m.userData.baseSize){
      const mult = m.userData.sizeMultiplier || 1.0;
      const ts=(ns*mult)/m.userData.baseSize;
      m.scale.setScalar(m.scale.x+(ts-m.scale.x)*0.3);
    }
  });
}

function clearAllClicks() {
  if(!clickedPoints.length) return;
  if(!confirm(`Delete all ${clickedPoints.length} click markers?`)) return;
  clearClicksQuiet();
  clearClickLog();
  autoSaveClicks(); // save empty state to server
  status("All clicks cleared.");
}

function clearClicksQuiet() {
  clickMarkers.forEach(m => {
    if (m.parent) m.parent.remove(m);
    else scene.remove(m);
  });
  clickMarkers = [];
  clickedPoints=[]; updateClickCount();
}

// Reposition ALL markers to match current view's coordinate system
// Linearized view: show ALL markers (all clusters)
// Isolated cluster N view: show only markers belonging to cluster N
function repositionAllMarkers() {
  // In row mode, use row-aware repositioning
  if (isRowMode && linRows.length > 0) {
    repositionMarkersInRows();
    return;
  }
  clickMarkers.forEach((m, i) => {
    const click = clickedPoints[i];
    if (!click) { m.visible = false; return; }
    const ox = click.originalX, oy = click.originalY, oz = click.originalZ;
    if (ox === '' || ox === undefined) { m.visible = false; return; }

    if (activeIsolatedId !== null) {
      // Isolated cluster view — only show markers for THIS cluster
      if (click.clusterId !== activeIsolatedId) {
        m.visible = false;
        return;
      }
      const pos = findNearestInMesh(ox, oy, oz, activeIsolatedId);
      if (pos) { m.position.copy(pos); m.visible = true; }
      else { m.visible = false; }
    } else {
      // Linearized view — show ALL markers
      const pos = findNearestInLinearized(ox, oy, oz);
      if (pos) { m.position.copy(pos); m.visible = true; }
      else { m.visible = false; }
    }
  });
  updateClickCount();
}

// Reposition markers into the correct row scenes based on original XYZ
function repositionMarkersInRows() {
  if (!isRowMode || linRows.length === 0) return;

  clickMarkers.forEach((m, i) => {
    const click = clickedPoints[i];
    if (!click) { m.visible = false; return; }
    const ox = click.originalX, oy = click.originalY, oz = click.originalZ;
    if (ox === '' || ox === undefined) { m.visible = false; return; }

    // During isolation, only show markers for the isolated cluster
    if (activeIsolatedId !== null && click.clusterId !== activeIsolatedId) {
      m.visible = false;
      return;
    }

    // Find which row contains this click's cluster
    let targetRow = null;
    for (const r of linRows) {
      if (r.clusterIds.includes(click.clusterId)) { targetRow = r; break; }
    }
    if (!targetRow) { m.visible = false; return; }

    // Find nearest point in this row by original XYZ
    const posAttr = targetRow.points.geometry.attributes.position;
    const n = targetRow.origXYZ.length / 3;
    let bestDist = Infinity, bestIdx = -1;
    for (let j = 0; j < n; j++) {
      const dx = targetRow.origXYZ[j*3] - ox;
      const dy = targetRow.origXYZ[j*3+1] - oy;
      const dz = targetRow.origXYZ[j*3+2] - oz;
      const d = dx*dx + dy*dy + dz*dz;
      if (d < bestDist) { bestDist = d; bestIdx = j; }
    }

    if (bestIdx >= 0) {
      // Move marker to this row's scene
      if (m.parent) m.parent.remove(m);
      targetRow.scene.add(m);
      m.position.set(posAttr.getX(bestIdx), posAttr.getY(bestIdx), posAttr.getZ(bestIdx));
      m.visible = true;
    } else {
      m.visible = false;
    }
  });
  updateClickCount();
}

// Find nearest point in linearized mesh by original XYZ
function findNearestInLinearized(ox, oy, oz) {
  if (!mainPoints || !originalXYZ) return null;
  const posAttr = mainPoints.geometry.attributes.position;
  const n = posAttr.count;
  let bestDist = Infinity, bestIdx = -1;

  for (let i = 0; i < n; i++) {
    const dx = originalXYZ[i*3] - ox;
    const dy = originalXYZ[i*3+1] - oy;
    const dz = originalXYZ[i*3+2] - oz;
    const d = dx*dx + dy*dy + dz*dz;
    if (d < bestDist) { bestDist = d; bestIdx = i; }
  }

  if (bestIdx >= 0) {
    return new THREE.Vector3(posAttr.getX(bestIdx), posAttr.getY(bestIdx), posAttr.getZ(bestIdx));
  }
  return null;
}

function updateClickCount() {
  // Click count UI removed — this is a no-op to keep callers working
}

// Auto-save clicks to server (debounced)
let _saveTimeout = null;
function autoSaveClicks() {
  if (_saveTimeout) clearTimeout(_saveTimeout);
  _saveTimeout = setTimeout(() => {
    if (!cloudData) return;
    fetch('/save_clicks', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({ cloud_name: cloudData.name, clicks: clickedPoints })
    }).catch(() => {}); // silent fail
  }, 400);
}

// Load saved clicks from server after cloud upload
function loadSavedClicks() {
  if (!cloudData) return;
  fetch(`/load_clicks?cloud_name=${encodeURIComponent(cloudData.name)}`)
    .then(r => r.json())
    .then(data => {
      if (data.clicks && data.clicks.length > 0) {
        restoreClicks(data.clicks);
        status(`Loaded: ${cloudData.name} — restored ${data.clicks.length} saved clicks.`);
      }
    }).catch(() => {});
}

// Restore click markers from saved data
function restoreClicks(savedClicks) {
  // Don't duplicate if already have clicks
  if (clickedPoints.length > 0) return;

  savedClicks.forEach(click => {
    clickedPoints.push(click);
    clickIdCounter = Math.max(clickIdCounter, click.id || 0);

    // Create marker at origin — repositionAllMarkers will fix position
    const marker = createClickMarker(new THREE.Vector3(0,0,0), click.markerColor, click.markerSize);
    clickMarkers.push(marker);
    scene.add(marker); // temporary parent; repositionAllMarkers moves to correct scene
  });

  // Use row-aware repositioning if in row mode
  repositionAllMarkers();
}

// Find nearest point in an isolated mesh by original XYZ
function findNearestInMesh(ox, oy, oz, clusterId) {
  const origXyz = isolatedOrigXYZMap[clusterId];
  const mesh = isolatedMeshes[clusterId];
  if (!origXyz || !mesh || ox === '' || ox === undefined) return null;

  const posAttr = mesh.geometry.attributes.position;
  const n = posAttr.count;
  let bestDist = Infinity, bestIdx = -1;

  for (let i = 0; i < n; i++) {
    const dx = origXyz[i*3] - ox;
    const dy = origXyz[i*3+1] - oy;
    const dz = origXyz[i*3+2] - oz;
    const d = dx*dx + dy*dy + dz*dz;
    if (d < bestDist) { bestDist = d; bestIdx = i; }
  }

  if (bestIdx >= 0) {
    return new THREE.Vector3(posAttr.getX(bestIdx), posAttr.getY(bestIdx), posAttr.getZ(bestIdx));
  }
  return null;
}


// ═══════════════════════════════════════════════════════════
// CSV EXPORT
// ═══════════════════════════════════════════════════════════

function exportClicksCSV() {
  if(!clickedPoints.length){ alert("No clicked points to export."); return; }
  const headers=['ID','ViewX','ViewY','ViewZ','OriginalX','OriginalY','OriginalZ',
    'PointIndex','IntersectionDistance','Timestamp','CloudName','ClusterID','ViewType',
    'PointSize','MarkerColor','MarkerSize','CameraX','CameraY','CameraZ','CameraRotX','CameraRotY','CameraRotZ','CameraFOV','CameraDistance'];
  const rows=[headers.join(',')];
  clickedPoints.forEach(c=>{
    rows.push([c.id,c.x,c.y,c.z,c.originalX,c.originalY,c.originalZ,
      c.pointIndex,c.intersectionDistance,c.timestamp,`"${c.cloudName||''}"`,c.clusterId,`"${c.viewType||''}"`,
      c.pointSize,`"${c.markerColor||'#ff0000'}"`,c.markerSize||1.0,
      c.cameraX,c.cameraY,c.cameraZ,c.cameraRotX,c.cameraRotY,c.cameraRotZ,c.cameraFov,c.cameraDistance].join(','));
  });
  const blob=new Blob([rows.join('\n')],{type:'text/csv;charset=utf-8;'});
  const url=URL.createObjectURL(blob), link=document.createElement('a');
  link.href=url; link.download=`clicked_points_${Date.now()}.csv`;
  document.body.appendChild(link); link.click(); document.body.removeChild(link);
  URL.revokeObjectURL(url);
  status(`Exported ${clickedPoints.length} clicks to CSV (with original XYZ).`);
}

function setupClickExport() {
  document.getElementById("tbExportCSV").addEventListener("click", exportClicksCSV);
  document.getElementById("menuExportCSV").addEventListener("click", exportClicksCSV);
  document.getElementById("menuToolsExport").addEventListener("click", exportClicksCSV);

  // Marker COLOR change — update ALL existing markers
  document.getElementById("markerColor").addEventListener("input", e => {
    const newColorHex = e.target.value;
    const newColor = new THREE.Color(newColorHex);
    const newGlow = newColor.clone().lerp(new THREE.Color(0xffffff), 0.3);
    clickMarkers.forEach(m => {
      if (!m) return;
      m.material.color.copy(newColor);
      if (m.children.length > 0) {
        m.children[0].material.color.copy(newGlow);
      }
    });
    // Update stored click data
    clickedPoints.forEach(c => { c.markerColor = newColorHex; });
    if (clickedPoints.length > 0) autoSaveClicks();
  });

  // Marker SIZE change — update ALL existing markers
  document.getElementById("markerSizeSlider").addEventListener("input", e => {
    const newSize = parseFloat(e.target.value);
    document.getElementById("markerSizeVal").textContent = newSize.toFixed(1);
    // Update ALL existing markers to new size
    const baseUnit = calculateMarkerSize();
    clickMarkers.forEach((m, i) => {
      if (!m) return;
      const sz = baseUnit * newSize;
      m.userData.sizeMultiplier = newSize;
      m.userData.baseSize = sz;
      m.scale.setScalar(1);
      // Rebuild geometry at new size
      m.geometry.dispose();
      m.geometry = new THREE.SphereGeometry(sz, 20, 20);
      if (m.children.length > 0) {
        m.children[0].geometry.dispose();
        m.children[0].geometry = new THREE.SphereGeometry(sz * 1.4, 16, 16);
      }
    });
    // Update stored click data too
    clickedPoints.forEach(c => { c.markerSize = newSize; });
    if (clickedPoints.length > 0) autoSaveClicks();
  });
}
window.getClickedPoints=()=>[...clickedPoints];
window.exportClicksCSV=exportClicksCSV;

// ═══════════════════════════════════════════════════════════
// CLICK LOG — bottom info panel
// ═══════════════════════════════════════════════════════════

function addClickLogEntry(clickData) {
  const tbody = document.getElementById("clickLogTbody");
  const empty = document.getElementById("clickLogEmpty");
  if (!tbody) return;
  if (empty) empty.style.display = "none";

  const ox = clickData.originalX !== '' && clickData.originalX !== undefined ? Number(clickData.originalX).toFixed(3) : '—';
  const oy = clickData.originalY !== '' && clickData.originalY !== undefined ? Number(clickData.originalY).toFixed(3) : '—';
  const oz = clickData.originalZ !== '' && clickData.originalZ !== undefined ? Number(clickData.originalZ).toFixed(3) : '—';

  const tr = document.createElement('tr');
  tr.className = 'click-row';
  tr.draggable = true;
  tr.dataset.clickId = clickData.id;
  tr.dataset.rowType = 'click';
  tr.dataset.cluster = clickData.clusterId;
  tr.innerHTML = `<td class="cle-id">${clickData.id}</td><td>${ox}</td><td>${oy}</td><td>${oz}</td><td class="editable" contenteditable="true" data-field="cluster">${clickData.clusterId}</td><td class="dbh-cell">—</td><td>Click</td>`;
  setupRowDragDrop(tr);
  setupRowContextMenu(tr);
  tbody.appendChild(tr);
  // Apply current filter
  if (activeIsolatedId !== null && clickData.clusterId !== activeIsolatedId) tr.style.display = "none";
  const body = document.getElementById("clickLogBody");
  if (body) body.scrollTop = body.scrollHeight;
}

function addAnnotationLogEntries(annPositions) {
  const tbody = document.getElementById("clickLogTbody");
  const empty = document.getElementById("clickLogEmpty");
  if (!tbody || !annPositions || annPositions.length === 0) return;
  if (empty) empty.style.display = "none";

  tbody.querySelectorAll('tr.ann-row').forEach(el => el.remove());

  // Sort by cluster descending
  const sorted = annPositions.map((ann, i) => ({ann, i}));
  sorted.sort((a, b) => {
    const ca = a.ann.cluster !== undefined ? a.ann.cluster : -1;
    const cb = b.ann.cluster !== undefined ? b.ann.cluster : -1;
    return cb - ca;
  });

  sorted.forEach(({ann, i}) => {
    const tr = document.createElement('tr');
    tr.className = 'ann-row';
    tr.draggable = true;
    tr.dataset.annIdx = i;
    tr.dataset.rowType = 'ann';
    tr.dataset.cluster = ann.cluster !== undefined ? ann.cluster : -1;
    const clStr = ann.cluster !== undefined && ann.cluster >= 0 ? ann.cluster : '—';
    tr.innerHTML = `<td>A${i+1}</td><td>${Number(ann.orig_x).toFixed(3)}</td><td>${Number(ann.orig_y).toFixed(3)}</td><td>${Number(ann.orig_z).toFixed(3)}</td><td class="editable" contenteditable="true" data-field="cluster">${clStr}</td><td class="dbh-cell">${ann._dbh || '—'}</td><td>Annotation</td>`;
    setupRowDragDrop(tr);
    setupRowContextMenu(tr);
    // Apply current filter
    if (activeIsolatedId !== null && ann.cluster !== activeIsolatedId) tr.style.display = "none";
    tbody.appendChild(tr);
  });
}

// Filter click log rows by cluster (show only matching, hide others)
function filterClickLogByCluster(clusterId) {
  const tbody = document.getElementById("clickLogTbody");
  if (!tbody) return;
  tbody.querySelectorAll("tr").forEach(tr => {
    if (clusterId === null) {
      tr.style.display = "";
    } else {
      const rc = parseInt(tr.dataset.cluster);
      tr.style.display = (rc === clusterId || isNaN(rc)) ? "" : "none";
    }
  });
}

function setupRowDragDrop(tr) {
  tr.addEventListener('dragstart', e => {
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', '');
    tr.classList.add('dragging');
    window._dragRow = tr;
  });
  tr.addEventListener('dragend', () => {
    tr.classList.remove('dragging');
    window._dragRow = null;
  });
  tr.addEventListener('dragover', e => {
    e.preventDefault();
    const dragging = window._dragRow;
    if (!dragging || dragging === tr) return;
    const tbody = tr.parentNode;
    const rows = [...tbody.children];
    const dragIdx = rows.indexOf(dragging);
    const hoverIdx = rows.indexOf(tr);
    if (dragIdx < hoverIdx) tbody.insertBefore(dragging, tr.nextSibling);
    else tbody.insertBefore(dragging, tr);
  });
}

// Right-click context menu for table rows
let _ctxRow = null;
function setupRowContextMenu(tr) {
  tr.addEventListener('contextmenu', e => {
    e.preventDefault();
    _ctxRow = tr;
    const menu = document.getElementById("rowContextMenu");
    menu.style.display = "block";
    menu.style.left = e.clientX + "px";
    menu.style.top = e.clientY + "px";
  });
}

function setupContextMenuActions() {
  document.addEventListener("click", () => {
    document.getElementById("rowContextMenu").style.display = "none";
  });
  document.getElementById("ctxEdit").addEventListener("click", () => {
    if (!_ctxRow) return;
    // Focus the first editable cell
    const cell = _ctxRow.querySelector(".editable");
    if (cell) { cell.focus(); }
  });
  document.getElementById("ctxAdd").addEventListener("click", () => {
    if (!_ctxRow) return;
    const tbody = document.getElementById("clickLogTbody");
    const newTr = document.createElement("tr");
    newTr.className = "click-row";
    newTr.draggable = true;
    newTr.dataset.rowType = "click";
    newTr.dataset.clickId = "new";
    newTr.innerHTML = `<td class="cle-id">+</td><td>—</td><td>—</td><td>—</td><td class="editable" contenteditable="true" data-field="cluster">—</td><td class="dbh-cell">—</td><td>Manual</td>`;
    setupRowDragDrop(newTr);
    setupRowContextMenu(newTr);
    _ctxRow.after(newTr);
  });
  document.getElementById("ctxDrop").addEventListener("click", () => {
    if (!_ctxRow) return;
    const tbody = document.getElementById("clickLogTbody");
    tbody.appendChild(_ctxRow); // move to bottom
  });
}

function removeClickLogEntry(clickId) {
  const tbody = document.getElementById("clickLogTbody");
  if (!tbody) return;
  const rows = tbody.querySelectorAll('tr.click-row');
  rows.forEach(tr => {
    if (tr.dataset.clickId === String(clickId)) tr.remove();
  });
  if (!tbody.querySelector('tr')) {
    const empty = document.getElementById("clickLogEmpty");
    if (empty) empty.style.display = "";
  }
}

function clearClickLog() {
  const tbody = document.getElementById("clickLogTbody");
  if (tbody) {
    // Remove ALL rows (clicks + annotations)
    tbody.innerHTML = '';
    const empty = document.getElementById("clickLogEmpty");
    if (empty) empty.style.display = "";
  }
}


// ═══════════════════════════════════════════════════════════
// ANNOTATION MARKERS — green circles at annotated tree positions
// ═══════════════════════════════════════════════════════════

function clearAnnotationMarkers() {
  annotationMarkers.forEach(m => { if (m.parent) m.parent.remove(m); });
  annotationMarkers = [];
}

function createAnnotationMarker(pos, instanceId) {
  // Create a canvas-based pink circle texture for a sprite
  const canvas = document.createElement('canvas');
  canvas.width = 64; canvas.height = 64;
  const ctx = canvas.getContext('2d');
  ctx.beginPath();
  ctx.arc(32, 32, 28, 0, Math.PI * 2);
  ctx.fillStyle = '#ff69b4';
  ctx.fill();
  ctx.lineWidth = 3;
  ctx.strokeStyle = '#ff1493';
  ctx.stroke();
  const texture = new THREE.CanvasTexture(canvas);
  const mat = new THREE.SpriteMaterial({ map: texture, transparent: true, opacity: 0.9 });
  const sprite = new THREE.Sprite(mat);
  sprite.position.copy(pos);
  sprite.scale.set(0.8, 0.8, 0.8);
  sprite.userData.isAnnotation = true;
  sprite.userData.instanceId = instanceId;
  return sprite;
}

function buildAnnotationMarkers() {
  clearAnnotationMarkers();
  if (!annotationPositions || annotationPositions.length === 0) return;
  if (!isRowMode || linRows.length === 0) return;

  annotationPositions.forEach(ann => {
    // ann.x/y/z are in lin_c coordinates (global linearized centered)
    // Each row has its OWN centering offset subtracted from points
    // We need to apply the same offset to place the marker correctly

    // Find which row this annotation belongs to based on cluster ID
    let targetRow = null;
    if (ann.cluster !== undefined && ann.cluster >= 0) {
      for (const r of linRows) {
        if (r.clusterIds.includes(ann.cluster)) { targetRow = r; break; }
      }
    }
    // Fallback: find row by X range
    if (!targetRow) {
      let bestDist = Infinity;
      for (const r of linRows) {
        const bbox = r.points.geometry.boundingBox;
        if (!bbox) continue;
        // Convert annotation pos to row-local coords to check
        const localX = ann.x - r.centerOffset.x;
        if (localX >= bbox.min.x - 2 && localX <= bbox.max.x + 2) {
          const cx = (bbox.min.x + bbox.max.x) / 2;
          const d = Math.abs(localX - cx);
          if (d < bestDist) { bestDist = d; targetRow = r; }
        }
      }
    }
    if (!targetRow) targetRow = linRows[0];

    // Apply the row's centering offset to get local coordinates
    const localPos = new THREE.Vector3(
      ann.x - targetRow.centerOffset.x,
      ann.y - targetRow.centerOffset.y,
      ann.z - targetRow.centerOffset.z
    );

    const marker = createAnnotationMarker(localPos, ann.instance);
    marker.userData.annFile = ann.file;
    const fileVis = annotationFileVisibility[ann.file] !== false;
    marker.visible = annotationVisible && fileVis;
    targetRow.scene.add(marker);
    annotationMarkers.push(marker);
  });
}

function toggleAnnotationVisibility(visible) {
  annotationVisible = visible;
  annotationMarkers.forEach((m, i) => {
    if (i >= annotationPositions.length) return;
    const ann = annotationPositions[i];
    const fileVis = annotationFileVisibility[ann.file] !== false;
    let show = annotationVisible && fileVis;
    // Respect cluster isolation
    if (show && activeIsolatedId !== null && ann.cluster !== activeIsolatedId) show = false;
    m.visible = show;
  });
}

function toggleAnnotationFile(filename, visible) {
  annotationFileVisibility[filename] = visible;
  annotationMarkers.forEach((m, i) => {
    if (i >= annotationPositions.length) return;
    const ann = annotationPositions[i];
    if (ann.file !== filename) return;
    let show = annotationVisible && visible;
    if (show && activeIsolatedId !== null && ann.cluster !== activeIsolatedId) show = false;
    m.visible = show;
  });
}

function filterAnnotationsByCluster(clusterId) {
  if (!annotationPositions) return;
  annotationMarkers.forEach((m, i) => {
    if (i < annotationPositions.length) {
      const ann = annotationPositions[i];
      const fileVis = annotationFileVisibility[ann.file] !== false;
      if (clusterId === null) {
        // Show all (respecting file visibility)
        m.visible = annotationVisible && fileVis;
      } else {
        // Only show annotations belonging to this cluster
        m.visible = annotationVisible && fileVis && (ann.cluster === clusterId);
      }
    }
  });
}


// ═══════════════════════════════════════════════════════════
// DBH MEASUREMENT — terrain-following ground plane (20x20)
// ═══════════════════════════════════════════════════════════

let dbhLinesVisible = false;
let dbhMeshes = [];
let dbhSliceActive = false;
let dbhSliceOffset = 1.5;
let dbhRedMeshes = [];
let dbhTopViewMode = false;
let dbhSavedCams = {};
let dbhCircleMesh = null;
let dbhCircleRadius = 0.15;
let dbhCircleCenter = null;
let dbhTargetRow = null;
let dbhConfirmPending = false;
let dbhHiddenPoints = null;
let dbhGroundGrids = {};
let dbhPlacedCircles = []; // {mesh, radius, center, annIdx} — committed circles

function computeGroundGrid(row, clusterId) {
  const GS = 30;
  const posAttr = row.points.geometry.attributes.position;
  const n = row.labels.length;
  let xMin=Infinity, xMax=-Infinity, yMin=Infinity, yMax=-Infinity, zMin=Infinity, zMax=-Infinity;
  const pts = [];
  for (let i = 0; i < n; i++) {
    if (row.labels[i] !== clusterId) continue;
    const x=posAttr.getX(i), y=posAttr.getY(i), z=posAttr.getZ(i);
    pts.push({x,y,z});
    if(x<xMin)xMin=x; if(x>xMax)xMax=x;
    if(y<yMin)yMin=y; if(y>yMax)yMax=y;
    if(z<zMin)zMin=z; if(z>zMax)zMax=z;
  }
  if (!pts.length) return null;
  const dx=(xMax-xMin)/GS||1, dy=(yMax-yMin)/GS||1;

  // Step 1: Seed grid with annotation-based ground Z (most accurate)
  // Annotation trunk positions are at ground+1.5m, so annZ-1.5 = ground Z
  const cells=[];
  const cellSeeded=[];  // track which cells got annotation-based values
  for(let i=0;i<GS;i++){cells[i]=[];cellSeeded[i]=[];for(let j=0;j<GS;j++){cells[i][j]=Infinity;cellSeeded[i][j]=false;}}

  if (annotationPositions && annotationPositions.length > 0) {
    const offX=row.centerOffset.x, offY=row.centerOffset.y, offZ=row.centerOffset.z;
    annotationPositions.forEach(ann => {
      if (ann.cluster !== clusterId) return;
      // Convert annotation from global lin_c to row-local coords
      const ax = ann.x - offX, ay = ann.y - offY, az = ann.z - offZ;
      // Ground Z at this tree = annotation Z - 1.5m (trunk is placed at DBH height)
      const groundZ = az - 1.5;
      const gi = Math.min(GS-1, Math.max(0, Math.floor((ax - xMin) / dx)));
      const gj = Math.min(GS-1, Math.max(0, Math.floor((ay - yMin) / dy)));
      // Set this cell and neighbors (annotation is a reliable ground sample)
      for(let di=-1;di<=1;di++)for(let dj=-1;dj<=1;dj++){
        const ni=gi+di, nj=gj+dj;
        if(ni>=0&&ni<GS&&nj>=0&&nj<GS){
          if(cells[ni][nj]===Infinity || Math.abs(cells[ni][nj]-groundZ)<1.0){
            cells[ni][nj]=groundZ; cellSeeded[ni][nj]=true;
          }
        }
      }
    });
  }

  // Step 2: Fill remaining cells from point cloud bottom percentile
  const zThresh = zMin + (zMax - zMin) * 0.25;
  const groundPts = pts.filter(p => p.z <= zThresh);
  if (groundPts.length >= 5) {
    const cellPts=[];
    for(let i=0;i<GS;i++){cellPts[i]=[];for(let j=0;j<GS;j++)cellPts[i][j]=[];}
    for(const p of groundPts){
      const gi=Math.min(GS-1,Math.floor((p.x-xMin)/dx));
      const gj=Math.min(GS-1,Math.floor((p.y-yMin)/dy));
      cellPts[gi][gj].push(p.z);
    }
    for(let i=0;i<GS;i++)for(let j=0;j<GS;j++){
      if(cellSeeded[i][j]) continue;  // don't overwrite annotation-seeded cells
      const zs=cellPts[i][j];
      if(zs.length>0){
        zs.sort((a,b)=>a-b);
        cells[i][j]=zs[Math.max(0,Math.floor(zs.length*0.10))];
      }
    }
  }

  // Step 3: Fill empty cells by spreading from neighbors
  let changed = true;
  while (changed) {
    changed = false;
    for(let i=0;i<GS;i++)for(let j=0;j<GS;j++){
      if(cells[i][j]<Infinity)continue;
      let sum=0, cnt=0;
      for(let di=-1;di<=1;di++)for(let dj=-1;dj<=1;dj++){
        const ni=i+di, nj=j+dj;
        if(ni>=0&&ni<GS&&nj>=0&&nj<GS&&cells[ni][nj]<Infinity){sum+=cells[ni][nj];cnt++;}
      }
      if(cnt>0){cells[i][j]=sum/cnt;changed=true;}
    }
  }
  for(let i=0;i<GS;i++)for(let j=0;j<GS;j++){
    if(cells[i][j]>=Infinity)cells[i][j]=zMin;
  }

  // Step 4: Smooth (preserve annotation-seeded cells, smooth others)
  for(let pass=0;pass<2;pass++){
    const smooth=[];
    for(let i=0;i<GS;i++){smooth[i]=[];for(let j=0;j<GS;j++){
      if(cellSeeded[i][j]){smooth[i][j]=cells[i][j];continue;}  // keep annotation values
      let sum=cells[i][j]*2, cnt=2;
      for(let di=-1;di<=1;di++)for(let dj=-1;dj<=1;dj++){
        if(di===0&&dj===0)continue;
        const ni=i+di, nj=j+dj;
        if(ni>=0&&ni<GS&&nj>=0&&nj<GS){sum+=cells[ni][nj];cnt++;}
      }
      smooth[i][j]=sum/cnt;
    }}
    for(let i=0;i<GS;i++)for(let j=0;j<GS;j++)cells[i][j]=smooth[i][j];
  }
  return {xMin,xMax,yMin,yMax,dx,dy,nx:GS,ny:GS,cells};
}

function getGroundZ(grid,x,y){
  if(!grid)return 0;
  // Bilinear interpolation for smooth ground surface
  const fi=(x-grid.xMin)/grid.dx - 0.5;
  const fj=(y-grid.yMin)/grid.dy - 0.5;
  const i0=Math.max(0,Math.min(grid.nx-2,Math.floor(fi)));
  const j0=Math.max(0,Math.min(grid.ny-2,Math.floor(fj)));
  const i1=i0+1, j1=j0+1;
  const fx=fi-i0, fy=fj-j0;
  const cfx=Math.max(0,Math.min(1,fx)), cfy=Math.max(0,Math.min(1,fy));
  const z00=grid.cells[i0][j0], z10=grid.cells[i1][j0];
  const z01=grid.cells[i0][j1], z11=grid.cells[i1][j1];
  return z00*(1-cfx)*(1-cfy) + z10*cfx*(1-cfy) + z01*(1-cfx)*cfy + z11*cfx*cfy;
}

function buildPlaneMesh(grid, offset, color, opacity) {
  const GS=grid.nx, verts=[], indices=[];
  for(let i=0;i<=GS;i++)for(let j=0;j<=GS;j++){
    const x=grid.xMin+i*grid.dx, y=grid.yMin+j*grid.dy;
    const gi=Math.min(GS-1,i), gj=Math.min(GS-1,j);
    verts.push(x, y, grid.cells[gi][gj]+offset);
  }
  for(let i=0;i<GS;i++)for(let j=0;j<GS;j++){
    const a=i*(GS+1)+j, b=a+1, c=(i+1)*(GS+1)+j, d=c+1;
    indices.push(a,c,b, b,c,d);
  }
  const geo=new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(verts,3));
  geo.setIndex(indices); geo.computeVertexNormals();
  return new THREE.Mesh(geo, new THREE.MeshBasicMaterial({color, transparent:true, opacity, side:THREE.DoubleSide, depthTest:false}));
}

function toggleDbhLines() {
  dbhLinesVisible = !dbhLinesVisible;
  if (dbhLinesVisible && activeIsolatedId !== null) buildDbhPlanes();
  else clearDbhMeshes();
}

function clearDbhMeshes() {
  dbhMeshes.forEach(m=>{if(m.parent)m.parent.remove(m);}); dbhMeshes=[];
  dbhRedMeshes.forEach(m=>{if(m.parent)m.parent.remove(m);}); dbhRedMeshes=[];
}

function buildDbhPlanes() {
  clearDbhMeshes();
  if (!isRowMode || !linRows.length || activeIsolatedId===null) return;
  linRows.forEach(r => {
    if (!r.clusterIds.includes(activeIsolatedId)) return;
    const grid = computeGroundGrid(r, activeIsolatedId);
    if (!grid) return;
    dbhGroundGrids[activeIsolatedId] = {grid, row:r};
    const bp = buildPlaneMesh(grid, 1.5, 0x000000, 0.35);
    r.scene.add(bp); dbhMeshes.push(bp);
  });
}

// openSliceTool replaced by openDbhCalc in setupDbh

function closeSliceTool() {
  dbhSliceActive=false; dbhConfirmPending=false;
  document.getElementById("dbhPanel").style.display="none";
  clearDbhMeshes();
  if(dbhCircleMesh){if(dbhCircleMesh.parent)dbhCircleMesh.parent.remove(dbhCircleMesh);dbhCircleMesh=null;}
  dbhPlacedCircles.forEach(pc=>{if(pc.mesh&&pc.mesh.parent)pc.mesh.parent.remove(pc.mesh);});
  dbhPlacedCircles=[];
  if(dbhHiddenPoints&&dbhTargetRow){
    const c=dbhTargetRow.points.geometry.attributes.color;
    c.array.set(dbhHiddenPoints); c.needsUpdate=true; dbhHiddenPoints=null;
  }
  if(dbhTopViewMode){
    linRows.forEach((r,i)=>{
      if(dbhSavedCams[i]){
        r.camera.position.copy(dbhSavedCams[i].pos);
        r.camera.up.copy(dbhSavedCams[i].up);
        r.vp.pivotPoint.copy(dbhSavedCams[i].target);
        r.camera.lookAt(dbhSavedCams[i].target);
        r.camera.updateProjectionMatrix();
      }
    });
    dbhSavedCams={}; dbhTopViewMode=false;
  }
  // Return to cluster view (not full linearized)
  if(dbhSavedClusterId !== null) {
    isolateCluster(dbhSavedClusterId);
  }
  dbhSavedClusterId = null;
}

function updateDbhRedPlane() {
  dbhRedMeshes.forEach(m=>{if(m.parent)m.parent.remove(m);}); dbhRedMeshes=[];
  if(activeIsolatedId===null)return;
  const entry=dbhGroundGrids[activeIsolatedId];
  if(!entry||!entry.grid)return;
  dbhTargetRow=entry.row;
  const rp=buildPlaneMesh(entry.grid,dbhSliceOffset,0xff0000,0.3);
  entry.row.scene.add(rp); dbhRedMeshes.push(rp);
}

function doDbhSlice() {
  if(activeIsolatedId===null||!dbhTargetRow)return;
  const entry=dbhGroundGrids[activeIsolatedId];
  if(!entry||!entry.grid)return;
  const grid=entry.grid, r=dbhTargetRow;
  const posAttr=r.points.geometry.attributes.position;
  const colAttr=r.points.geometry.attributes.color;
  const n=r.labels.length;
  dbhHiddenPoints=new Float32Array(colAttr.array);
  const arr=colAttr.array;

  // Build list of tree trunk XY positions in row-local coordinates
  // from annotations belonging to this cluster
  const trunkXYs = [];
  if (annotationPositions) {
    annotationPositions.forEach(ann => {
      if (ann.cluster !== activeIsolatedId) return;
      // ann.x/y/z are in global linearized centered coords
      // Convert to row-local by subtracting centerOffset
      const lx = ann.x - r.centerOffset.x;
      const ly = ann.y - r.centerOffset.y;
      trunkXYs.push({ x: lx, y: ly });
    });
  }

  const trunkRadius = 0.8; // meters — keep points within this XY distance of a known trunk
  const trunkRadSq = trunkRadius * trunkRadius;

  for(let i=0;i<n;i++){
    if(r.labels[i]!==activeIsolatedId) continue;
    const x=posAttr.getX(i), y=posAttr.getY(i), z=posAttr.getZ(i);
    const gz=getGroundZ(grid, x, y);

    // Always hide points above slice
    if(z > gz + dbhSliceOffset) {
      arr[i*3]=0; arr[i*3+1]=0; arr[i*3+2]=0;
      continue;
    }

    // Check if this point is near any known trunk AND above ground
    let nearTrunk = false;
    for(const t of trunkXYs) {
      const dx = x - t.x, dy = y - t.y;
      if(dx*dx + dy*dy < trunkRadSq) { nearTrunk = true; break; }
    }

    // Must be near a trunk AND above ground+0.3m (skip ground surface)
    if(!nearTrunk || z < gz + 0.3) {
      arr[i*3]=0; arr[i*3+1]=0; arr[i*3+2]=0;
    }
  }

  colAttr.needsUpdate=true;
  dbhMeshes.forEach(m=>{m.visible=false;}); dbhRedMeshes.forEach(m=>{m.visible=false;});
  linRows.forEach((row,idx)=>{
    if(!row.clusterIds.includes(activeIsolatedId))return;
    dbhSavedCams[idx]={pos:row.camera.position.clone(),up:row.camera.up.clone(),target:row.vp.pivotPoint.clone()};
    let cxMin=Infinity,cxMax=-Infinity,cyMin=Infinity,cyMax=-Infinity;
    for(let j=0;j<n;j++){
      if(row.labels[j]!==activeIsolatedId)continue;
      const x=posAttr.getX(j),y=posAttr.getY(j);
      if(x<cxMin)cxMin=x;if(x>cxMax)cxMax=x;if(y<cyMin)cyMin=y;if(y>cyMax)cyMax=y;
    }
    const cx=(cxMin+cxMax)/2,cy=(cyMin+cyMax)/2;
    const midGz=grid.cells[Math.floor(grid.nx/2)][Math.floor(grid.ny/2)]||0;
    const sliceZ=midGz+dbhSliceOffset;
    const vd=Math.max(cxMax-cxMin,cyMax-cyMin)*0.8;
    row.camera.position.set(cx,cy,sliceZ+vd);
    row.camera.up.set(0,1,0);
    row.vp.pivotPoint.set(cx,cy,sliceZ);
    row.camera.lookAt(cx,cy,sliceZ);
    row.camera.updateProjectionMatrix();
  });
  dbhTopViewMode=true;
  document.getElementById("dbhCircleTools").style.display="block";
  status("Top view — dbl-click each trunk, +/− resize, Enter to lock, dbl-click next. ✔ saves all.");
}

function placeDbhCircle(pos3d) {
  // If there's an active circle being fitted, commit it first (keep it on screen)
  if(dbhConfirmPending && dbhCircleMesh && dbhCircleCenter) {
    commitActiveCircle();
  }
  // Start new circle
  const camDist = dbhTargetRow ? dbhTargetRow.camera.position.distanceTo(dbhTargetRow.vp.pivotPoint) : 10;
  dbhCircleRadius = camDist * 0.015;
  dbhCircleCenter = pos3d.clone();
  rebuildDbhCircle(); dbhConfirmPending=true; updateDbhCircleDisplay();
}

// Commit the active circle: find nearest annotation, store in placed array, keep mesh on screen
function commitActiveCircle() {
  if(!dbhCircleMesh || !dbhCircleCenter) return;
  const d = dbhCircleRadius * 2, dStr = d.toFixed(4);
  let annIdx = -1;
  if(annotationPositions && dbhTargetRow) {
    let bestDist = Infinity;
    const offX=dbhTargetRow.centerOffset.x, offY=dbhTargetRow.centerOffset.y;
    annotationPositions.forEach((ann,i) => {
      if(activeIsolatedId!==null && ann.cluster!==activeIsolatedId) return;
      // Skip annotations already committed
      if(dbhPlacedCircles.some(pc => pc.annIdx === i)) return;
      const dx=ann.x-(dbhCircleCenter.x+offX), dy=ann.y-(dbhCircleCenter.y+offY);
      const dd=Math.sqrt(dx*dx+dy*dy);
      if(dd<bestDist){bestDist=dd; annIdx=i;}
    });
  }
  // Store in placed array (mesh stays in scene)
  dbhPlacedCircles.push({
    mesh: dbhCircleMesh,
    radius: dbhCircleRadius,
    center: dbhCircleCenter.clone(),
    annIdx: annIdx,
    diameter: dStr
  });
  // Detach from active — don't remove from scene
  dbhCircleMesh = null;
  dbhCircleCenter = null;
  dbhConfirmPending = false;
}

function rebuildDbhCircle() {
  if(dbhCircleMesh&&dbhCircleMesh.parent)dbhCircleMesh.parent.remove(dbhCircleMesh);
  const canvas = document.createElement('canvas');
  canvas.width = 256; canvas.height = 256;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0,0,256,256);
  // Outer glow for visibility
  ctx.strokeStyle = 'rgba(0,0,0,0.4)';
  ctx.lineWidth = 20;
  ctx.beginPath();
  ctx.arc(128, 128, 100, 0, Math.PI*2);
  ctx.stroke();
  // Main bold black circle
  ctx.strokeStyle = '#000000';
  ctx.lineWidth = 12;
  ctx.beginPath();
  ctx.arc(128, 128, 100, 0, Math.PI*2);
  ctx.stroke();
  // Inner white outline for contrast
  ctx.strokeStyle = 'rgba(255,255,255,0.5)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(128, 128, 100, 0, Math.PI*2);
  ctx.stroke();
  // Crosshair
  ctx.strokeStyle = '#000000';
  ctx.lineWidth = 5;
  ctx.beginPath(); ctx.moveTo(98,128); ctx.lineTo(158,128); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(128,98); ctx.lineTo(128,158); ctx.stroke();
  // Center dot
  ctx.fillStyle = '#000000';
  ctx.beginPath(); ctx.arc(128, 128, 5, 0, Math.PI*2); ctx.fill();
  const texture = new THREE.CanvasTexture(canvas);
  const mat = new THREE.SpriteMaterial({map:texture, transparent:true, depthTest:false});
  dbhCircleMesh = new THREE.Sprite(mat);
  dbhCircleMesh.position.copy(dbhCircleCenter);
  const size = dbhCircleRadius * 2;
  dbhCircleMesh.scale.set(size, size, 1);
  if(dbhTargetRow)dbhTargetRow.scene.add(dbhCircleMesh);
}

function moveDbhCircle(dx,dy){
  if(!dbhCircleCenter||!dbhConfirmPending)return;
  // Move proportional to camera distance so it's visible per keystroke
  const camDist = dbhTargetRow ? dbhTargetRow.camera.position.distanceTo(dbhTargetRow.vp.pivotPoint) : 10;
  const step = camDist * 0.005;
  dbhCircleCenter.x += dx * step;
  dbhCircleCenter.y += dy * step;
  if(dbhCircleMesh)dbhCircleMesh.position.copy(dbhCircleCenter);
}

function resizeDbhCircle(delta){
  if(!dbhConfirmPending||!dbhCircleMesh)return;
  // Scale delta proportional to camera distance
  const camDist = dbhTargetRow ? dbhTargetRow.camera.position.distanceTo(dbhTargetRow.vp.pivotPoint) : 10;
  const scaledDelta = delta * camDist * 0.002;
  dbhCircleRadius=Math.max(0.005, dbhCircleRadius + scaledDelta);
  const size = dbhCircleRadius * 2;
  dbhCircleMesh.scale.set(size, size, 1);
  updateDbhCircleDisplay();
}

function confirmDbhCircle(){
  // Commit the active circle if there is one
  if(dbhConfirmPending && dbhCircleMesh && dbhCircleCenter) {
    commitActiveCircle();
  }
  // Save ALL placed circles' diameters to the annotation table
  const tbody = document.getElementById("clickLogTbody");
  let savedCount = 0;
  dbhPlacedCircles.forEach(pc => {
    if(pc.annIdx >= 0 && annotationPositions && pc.annIdx < annotationPositions.length) {
      annotationPositions[pc.annIdx]._dbh = pc.diameter;
      tbody.querySelectorAll("tr.ann-row").forEach(tr => {
        if(parseInt(tr.dataset.annIdx) === pc.annIdx) {
          const c = tr.querySelector(".dbh-cell");
          if(c) c.textContent = pc.diameter;
        }
      });
      savedCount++;
      status(`DBH: ${pc.diameter}m → instance ${annotationPositions[pc.annIdx].instance}`);
    }
  });
  if(savedCount > 0) status(`Saved ${savedCount} DBH measurement(s)`);
  else if(dbhPlacedCircles.length > 0) status(`${dbhPlacedCircles.length} circle(s) placed but no annotation match`);
}

function updateDbhCircleDisplay(){
  document.getElementById("dbhCircleDiam").textContent=`⌀ ${(dbhCircleRadius*2).toFixed(4)} m`;
}

function setupDbh() {
  document.getElementById("menuDbhCalc").addEventListener("click", openDbhCalc);
  document.getElementById("btnShowBlackPlane").addEventListener("click", ()=>{
    dbhLinesVisible=!dbhLinesVisible;
    if(dbhLinesVisible && activeIsolatedId!==null) buildDbhPlanes();
    else { clearDbhMeshes(); dbhLinesVisible=false; }
    document.getElementById("btnShowBlackPlane").textContent = dbhLinesVisible ? "📏 Hide 1.5m Plane" : "📏 Show 1.5m Reference Plane";
  });
  document.getElementById("btnDbhClose").addEventListener("click", closeSliceTool);
  document.getElementById("btnDbhSave").addEventListener("click", ()=>{confirmDbhCircle();saveAndReturnToCluster();});
  document.getElementById("dbhHeightSlider").addEventListener("input", e=>{
    dbhSliceOffset=parseFloat(e.target.value);
    document.getElementById("dbhHeightVal").textContent=dbhSliceOffset.toFixed(2)+" m";
    updateDbhRedPlane();
  });
  document.getElementById("btnDoSlice").addEventListener("click", doDbhSlice);
  document.getElementById("btnCircleShrink").addEventListener("click", ()=>resizeDbhCircle(-1));
  document.getElementById("btnCircleGrow").addEventListener("click", ()=>resizeDbhCircle(1));
  document.addEventListener("keydown", e=>{
    if(!dbhTopViewMode||!dbhConfirmPending)return;
    switch(e.key){
      case"ArrowLeft":e.preventDefault();moveDbhCircle(-1,0);break;
      case"ArrowRight":e.preventDefault();moveDbhCircle(1,0);break;
      case"ArrowUp":e.preventDefault();moveDbhCircle(0,1);break;
      case"ArrowDown":e.preventDefault();moveDbhCircle(0,-1);break;
      case"Enter":e.preventDefault();if(dbhConfirmPending&&dbhCircleMesh&&dbhCircleCenter)commitActiveCircle();break;
      case"+":case"=":e.preventDefault();resizeDbhCircle(1);break;
      case"-":case"_":e.preventDefault();resizeDbhCircle(-1);break;
    }
  });
}

let dbhSavedClusterId = null; // remember which cluster we were working on

function openDbhCalc() {
  if(activeIsolatedId===null){status("Isolate a cluster first");return;}
  dbhSavedClusterId = activeIsolatedId;
  dbhSliceActive=true; dbhSliceOffset=1.5; dbhTopViewMode=false; dbhConfirmPending=false;
  document.getElementById("dbhPanel").style.display="block";
  document.getElementById("dbhHeightSlider").value="1.5";
  document.getElementById("dbhHeightVal").textContent="1.5 m";
  document.getElementById("dbhCircleTools").style.display="none";
  document.getElementById("btnShowBlackPlane").textContent="📏 Show 1.5m Reference Plane";
  dbhLinesVisible=false;
  if(!dbhGroundGrids[activeIsolatedId]){
    linRows.forEach(r=>{
      if(r.clusterIds.includes(activeIsolatedId))
        dbhGroundGrids[activeIsolatedId]={grid:computeGroundGrid(r,activeIsolatedId),row:r};
    });
  }
  clearDbhMeshes();
  updateDbhRedPlane();
}

function saveAndReturnToCluster() {
  // Clean up DBH visuals
  dbhSliceActive=false; dbhConfirmPending=false;
  document.getElementById("dbhPanel").style.display="none";
  clearDbhMeshes();
  if(dbhCircleMesh){if(dbhCircleMesh.parent)dbhCircleMesh.parent.remove(dbhCircleMesh);dbhCircleMesh=null;}
  dbhPlacedCircles.forEach(pc=>{if(pc.mesh&&pc.mesh.parent)pc.mesh.parent.remove(pc.mesh);});
  dbhPlacedCircles=[];
  // Restore colors
  if(dbhHiddenPoints&&dbhTargetRow){
    const c=dbhTargetRow.points.geometry.attributes.color;
    c.array.set(dbhHiddenPoints); c.needsUpdate=true; dbhHiddenPoints=null;
  }
  // Restore cameras
  if(dbhTopViewMode){
    linRows.forEach((r,i)=>{
      if(dbhSavedCams[i]){
        r.camera.position.copy(dbhSavedCams[i].pos);
        r.camera.up.copy(dbhSavedCams[i].up);
        r.vp.pivotPoint.copy(dbhSavedCams[i].target);
        r.camera.lookAt(dbhSavedCams[i].target);
        r.camera.updateProjectionMatrix();
      }
    });
    dbhSavedCams={}; dbhTopViewMode=false;
  }
  // Return to the cluster view we were working on (not clearIsolation)
  if(dbhSavedClusterId !== null) {
    isolateCluster(dbhSavedClusterId);
  }
  dbhSavedClusterId = null;
}

function onDbhDoubleClick(ri,e){
  if(!dbhTopViewMode||!dbhSliceActive)return false;
  // In top-down view after slicing, raycasting hits INVISIBLE black points above
  // the slice plane (shader discards them but geometry is still there).
  // Solution: intersect the mouse ray with a horizontal plane at the slice Z height.
  // This gives the exact XY where the user clicked at the correct Z.
  const rect=renderer.domElement.getBoundingClientRect();
  const mx=((e.clientX-rect.left)/rect.width)*2-1;
  const my=-((ri.localY)/ri.rowH)*2+1;
  const rc=new THREE.Raycaster();
  rc.setFromCamera(new THREE.Vector2(mx,my),ri.row.camera);
  // Compute the slice Z in row-local coordinates
  const entry=dbhGroundGrids[activeIsolatedId];
  if(!entry||!entry.grid) return true;
  const grid=entry.grid;
  // Use the pivot point Z as a reference (camera is looking at this Z)
  const sliceZ = ri.row.vp.pivotPoint.z;
  // Create horizontal plane at slice Z (normal = +Z, d = -sliceZ)
  const plane=new THREE.Plane(new THREE.Vector3(0,0,1), -sliceZ);
  const intersection=new THREE.Vector3();
  if(rc.ray.intersectPlane(plane, intersection)){
    placeDbhCircle(intersection);
  }
  return true;
}

// ═══════════════════════════════════════════════════════════
// CLOUD LOADING
// ═══════════════════════════════════════════════════════════

function loadCloud(data) {
  clearScene();
  cloudData = data; cloudId = data.id;

  // Keep the user's current display mode — only reset if normals won't be available
  updateColorScaleBar(displayMode);

  // Linearized view — decode base64 arrays
  fullLinPositions = decodeArr(data.linearized.positions, 'float32');
  fullLinColors = decodeArr(data.linearized.colors, 'float32');
  linBaseColors = new Float32Array(fullLinColors); // copy for hover restore
  whiteColorsData = new Float32Array(fullLinColors); // store white as default
  if (data.linearized.original_xyz) originalXYZ = decodeArr(data.linearized.original_xyz, 'float64');
  if (data.linearized.labels) linLabels = decodeArr(data.linearized.labels, 'int32');
  linInstanceLabels = data.linearized.instance_labels ? decodeArr(data.linearized.instance_labels, 'int32') : null;

  // Load normal/curvature colors (auto-computed by server during clustering)
  if (data.linearized.normal_colors) {
    normalColorsData = decodeArr(data.linearized.normal_colors, 'float32');
    curvatureColorsData = decodeArr(data.linearized.curvature_colors, 'float32');
    normalsComputed = true;
  } else {
    normalColorsData = null; curvatureColorsData = null; normalsComputed = false;
    if (displayMode !== 'white') { displayMode = 'white'; }
  }
  updateDisplayMenuChecks();

  mainPoints = makePoints(fullLinPositions, fullLinColors);
  scene.add(mainPoints);
  // Apply the current display mode and point tint to the freshly loaded cloud
  applyDisplayColors();

  // Clustered view — decode base64 arrays
  clsPositions = decodeArr(data.clustered.positions, 'float32');
  clsColors = decodeArr(data.clustered.colors, 'float32');
  if (data.clustered.original_xyz) clsOrigXYZ = decodeArr(data.clustered.original_xyz, 'float64');
  if (data.clustered.labels) clsLabels = decodeArr(data.clustered.labels, 'int32');

  clusterPoints = makePoints(clsPositions, clsColors);
  cScene.add(clusterPoints);
  clusterPoints.userData.clusterStats = data.cluster_stats;
  clusterPoints.userData.clusterColors = data.cluster_colors;

  // Pre-build isolated cluster meshes for instant switching
  buildIsolatedMeshes();

  fitCameraFront(mainPoints, camera, mainVP);
  fitCamera(clusterPoints, cCamera, clsVP);
  updateDBTree(); showMainProps(); showClusterProps(data.cluster_stats, data.cluster_colors);
  document.getElementById("pEpsParam").value = lastEpsParam;
  document.getElementById("pOverlap").value = data.overlap || 0.15;
  document.getElementById("btnRecluster").textContent = "Re-Cluster";
  document.getElementById("btnApplyOverlap").disabled = false;
  activeIsolatedId = null;
  document.getElementById("isolatedBanner").style.display = "none";

  // Build multi-row view from cluster X-extents (client-side)
  // Always uses row mode — each row is 2/3 viewport height
  if (buildRowScenes()) {
    if (mainPoints) mainPoints.visible = false;
  }
  onResize();  // ensure canvas sized correctly for row mode
  // Deferred second resize to handle any layout settling
  requestAnimationFrame(() => onResize());

  // Handle annotation positions — show pink markers on annotated tree trunks
  annotationPositions = data.annotation_positions || null;
  if (annotationPositions && annotationPositions.length > 0) {
    // Initialize per-file visibility
    annotationPositions.forEach(a => { if (annotationFileVisibility[a.file] === undefined) annotationFileVisibility[a.file] = true; });
    buildAnnotationMarkers();
    addAnnotationLogEntries(annotationPositions);
  }
  updateDBTree();  // refresh to show annotation files

  status(`Loaded: ${data.name} — ${data.meta.num_points.toLocaleString()} pts, ${data.meta.n_clusters} clusters. Double-click to mark.`);
  document.getElementById("ptCount").textContent = `Lin: ${data.linearized.displayed.toLocaleString()} · Cls: ${data.clustered.displayed.toLocaleString()}`;

  // Restore any previously saved clicks for this cloud
  loadSavedClicks();
}


// ═══════════════════════════════════════════════════════════
// RAW CLOUD — show original before clustering
// ═══════════════════════════════════════════════════════════

function loadRawCloud(data) {
  clearScene();
  cloudData = data; cloudId = data.id;
  isRawMode = true;

  // Reset display mode
  displayMode = 'white';
  updateColorScaleBar('white');

  const positions = decodeArr(data.positions, 'float32');
  const colors = decodeArr(data.colors, 'float32');

  // Store raw color data for display-mode switching
  rawWhiteColorsData = new Float32Array(colors);
  // Normals are computed async after load — reset state for now
  normalColorsData = null; curvatureColorsData = null; normalsComputed = false;
  updateDisplayMenuChecks();

  rawPoints = makePoints(positions, colors);
  scene.add(rawPoints);
  // Apply whiteTintColor to the freshly loaded raw cloud
  applyDisplayColors();
  fitCamera(rawPoints, camera, mainVP);

  // Kick off background normals computation — available once done
  _fetchRawNormals();

  // Store annotation info for later use after clustering
  if (data.annotation && data.annotation.trees) {
    cloudData._annotationTrees = data.annotation.trees;
  }

  // Show annotation markers on raw view (centered positions)
  if (data.annotation && data.annotation.raw_positions && data.annotation.raw_positions.length > 0) {
    annotationPositions = data.annotation.raw_positions;
    annotationPositions.forEach(a => {
      if (annotationFileVisibility[a.file] === undefined) annotationFileVisibility[a.file] = true;
    });
    // Create markers directly in the main scene for raw view
    clearAnnotationMarkers();
    annotationPositions.forEach(ann => {
      const pos = new THREE.Vector3(ann.x, ann.y, ann.z);
      const marker = createAnnotationMarker(pos, ann.instance);
      marker.userData.annFile = ann.file;
      const fileVis = annotationFileVisibility[ann.file] !== false;
      marker.visible = annotationVisible && fileVis;
      scene.add(marker);
      annotationMarkers.push(marker);
    });
    addAnnotationLogEntries(annotationPositions);
  }

  updateDBTree(); showMainProps();
  showEmptyClusterProps();

  document.getElementById("btnRecluster").textContent = "Cluster & Linearize";
  document.getElementById("btnApplyOverlap").disabled = true;

  const annCount = data.annotation ? data.annotation.num_trees : 0;
  const annMsg = annCount > 0 ? ` (${annCount} annotation trees)` : '';
  status(`Loaded: ${data.name} — ${data.meta.num_points.toLocaleString()} pts${annMsg}. Click "Cluster & Linearize" to begin.`);
  document.getElementById("ptCount").textContent = `Pts: ${data.displayed.toLocaleString()}`;
  document.getElementById("isolatedBanner").style.display = "none";
}


// ═══════════════════════════════════════════════════════════
// PRE-BUILD ISOLATED CLUSTER MESHES — instant switching
// ═══════════════════════════════════════════════════════════

function buildIsolatedMeshes() {
  // Clean up old meshes
  Object.values(isolatedMeshes).forEach(m => scene.remove(m));
  isolatedMeshes = {};
  isolatedOrigXYZMap = {};

  if (!clsLabels || !clsPositions || !cloudData) return;

  const nCls = cloudData.cluster_colors.length;
  const nPts = clsLabels.length;

  // Group point indices by cluster
  const clusterIndices = {};
  for (let i = 0; i < nPts; i++) {
    const lbl = clsLabels[i];
    if (!clusterIndices[lbl]) clusterIndices[lbl] = [];
    clusterIndices[lbl].push(i);
  }

  for (const [lblStr, indices] of Object.entries(clusterIndices)) {
    const lbl = parseInt(lblStr);
    const count = indices.length;

    // Extract positions for this cluster
    const pos = new Float32Array(count * 3);
    const col = new Float32Array(count * 3);
    const origXyz = new Float64Array(count * 3);

    for (let j = 0; j < count; j++) {
      const si = indices[j];
      pos[j*3]   = clsPositions[si*3];
      pos[j*3+1] = clsPositions[si*3+1];
      pos[j*3+2] = clsPositions[si*3+2];
      col[j*3]   = clsColors[si*3];
      col[j*3+1] = clsColors[si*3+1];
      col[j*3+2] = clsColors[si*3+2];
      if (clsOrigXYZ) {
        origXyz[j*3]   = clsOrigXYZ[si*3];
        origXyz[j*3+1] = clsOrigXYZ[si*3+1];
        origXyz[j*3+2] = clsOrigXYZ[si*3+2];
      }
    }

    // Center the cluster points locally
    let cx=0, cy=0, cz=0;
    for (let j = 0; j < count; j++) { cx+=pos[j*3]; cy+=pos[j*3+1]; cz+=pos[j*3+2]; }
    cx/=count; cy/=count; cz/=count;
    for (let j = 0; j < count; j++) { pos[j*3]-=cx; pos[j*3+1]-=cy; pos[j*3+2]-=cz; }

    const mesh = makePoints(pos, col);
    mesh.visible = false;
    scene.add(mesh);
    isolatedMeshes[lbl] = mesh;
    isolatedOrigXYZMap[lbl] = origXyz;
  }
}


// ═══════════════════════════════════════════════════════════
// INSTANT CLUSTER ISOLATION — appear/disappear, no loading
// ═══════════════════════════════════════════════════════════

function isolateCluster(clusterId) {
  if (!cloudData) return;

  clearHoverHighlight();

  // ── Row mode: show cluster in its row, keep other rows normal ──
  if (isRowMode && linRows.length > 0) {
    const cc = cloudData.cluster_colors[clusterId];
    if (!cc) return;

    let targetRow = null;
    linRows.forEach(r => {
      const hasCluster = r.clusterIds.includes(clusterId);
      const colAttr = r.points.geometry.attributes.color;
      const arr = colAttr.array;
      const n = r.labels.length;

      if (hasCluster) {
        targetRow = r;
        // This row contains the cluster → show it with display-mode colors, dim others
        for (let i = 0; i < n; i++) {
          if (r.labels[i] === clusterId) {
            arr[i*3] = r.baseColors[i*3]; arr[i*3+1] = r.baseColors[i*3+1]; arr[i*3+2] = r.baseColors[i*3+2];
          } else {
            arr[i*3] = 0.0; arr[i*3+1] = 0.0; arr[i*3+2] = 0.0;
          }
        }
      } else {
        // Other rows → keep normal display-mode colors (restore base)
        colAttr.array.set(r.baseColors);
      }
      colAttr.needsUpdate = true;
    });

    activeIsolatedId = clusterId;
    // Keep row labels visible
    document.querySelectorAll(".row-label").forEach(el => el.style.display = "");

    // Zoom into the cluster within its row
    if (targetRow) {
      fitCameraToClusterInRow(targetRow, clusterId);
    }

    // Show markers for the isolated cluster only
    repositionMarkersInRows();
    // Filter annotation markers: only show ones belonging to this cluster
    filterAnnotationsByCluster(clusterId);
    // Filter click log table to show only this cluster's rows
    filterClickLogByCluster(clusterId);

    const col = cloudData.cluster_colors[clusterId];
    const rgb = col ? `rgb(${Math.round(col[0]*255)},${Math.round(col[1]*255)},${Math.round(col[2]*255)})` : '#fff';
    const stats = cloudData.cluster_stats.find(s => s.id === clusterId);
    const count = stats ? stats.count.toLocaleString() : '?';
    document.getElementById("isolatedLabel").innerHTML =
      `<span style="display:inline-block;width:12px;height:12px;border-radius:3px;background:${rgb};vertical-align:middle;margin-right:6px;border:1px solid rgba(255,255,255,.4)"></span>Cluster #${clusterId} — ${count} pts`;
    document.getElementById("isolatedBanner").style.display = "flex";
    highlightClusterItem(clusterId);
    const visibleClicks = clickedPoints.filter(c => c.clusterId === clusterId).length;
    status(`Cluster #${clusterId}: ${count} pts · ${visibleClicks} saved clicks`);
    return;
  }

  // ── Single-scene mode (no rows): show mainPoints filtered by cluster with display-mode colors ──
  if (activeIsolatedId !== null && isolatedMeshes[activeIsolatedId]) {
    isolatedMeshes[activeIsolatedId].visible = false;
  }

  // Keep mainPoints visible — paint cluster with display-mode colors, dim others
  if (mainPoints && linLabels && linBaseColors) {
    mainPoints.visible = true;
    const colAttr = mainPoints.geometry.attributes.color;
    const arr = colAttr.array;
    const n = linLabels.length;
    for (let i = 0; i < n; i++) {
      if (linLabels[i] === clusterId) {
        arr[i*3] = linBaseColors[i*3]; arr[i*3+1] = linBaseColors[i*3+1]; arr[i*3+2] = linBaseColors[i*3+2];
      } else {
        arr[i*3] = 0.0; arr[i*3+1] = 0.0; arr[i*3+2] = 0.0;
      }
    }
    colAttr.needsUpdate = true;
    fitCamera(mainPoints, camera, mainVP);
  } else if (isolatedMeshes[clusterId]) {
    // Fallback: use pre-built isolated mesh
    mainPoints.visible = false;
    isolatedMeshes[clusterId].visible = true;
    fitCamera(isolatedMeshes[clusterId], camera, mainVP);
  }

  activeIsolatedId = clusterId;
  repositionAllMarkers();

  const col = cloudData.cluster_colors[clusterId];
  const rgb = col ? `rgb(${Math.round(col[0]*255)},${Math.round(col[1]*255)},${Math.round(col[2]*255)})` : '#fff';
  const stats = cloudData.cluster_stats.find(s => s.id === clusterId);
  const count = stats ? stats.count.toLocaleString() : '?';
  document.getElementById("isolatedLabel").innerHTML =
    `<span style="display:inline-block;width:12px;height:12px;border-radius:3px;background:${rgb};vertical-align:middle;margin-right:6px;border:1px solid rgba(255,255,255,.4)"></span>Cluster #${clusterId} — ${count} pts`;
  document.getElementById("isolatedBanner").style.display = "flex";
  highlightClusterItem(clusterId);
  const visibleClicks = clickedPoints.filter(c => c.clusterId === clusterId).length;
  status(`Cluster #${clusterId}: ${count} pts · ${visibleClicks} saved clicks`);
}

function clearIsolation() {
  // ── Row mode: restore white colors and reset cameras ──
  if (isRowMode && linRows.length > 0) {
    linRows.forEach(r => {
      const colAttr = r.points.geometry.attributes.color;
      colAttr.array.set(r.baseColors);
      colAttr.needsUpdate = true;
      fitCameraFront(r.points, r.camera, r.vp);
    });
    activeIsolatedId = null;
    document.getElementById("isolatedBanner").style.display = "none";
    document.querySelectorAll(".row-label").forEach(el => el.style.display = "");
    highlightClusterItem(-1);
    // Show all markers in linearized view
    repositionMarkersInRows();
    filterAnnotationsByCluster(null);  // show all annotations
    filterClickLogByCluster(null);     // show all table rows
    if (cloudData) status(`Showing all — ${cloudData.meta.n_clusters} clusters`);
    return;
  }

  // ── Single-scene mode ──
  if (!mainPoints) return;

  if (activeIsolatedId !== null && isolatedMeshes[activeIsolatedId]) {
    isolatedMeshes[activeIsolatedId].visible = false;
  }

  // Restore display-mode base colors on mainPoints
  mainPoints.visible = true;
  if (linBaseColors) {
    const colAttr = mainPoints.geometry.attributes.color;
    colAttr.array.set(linBaseColors);
    colAttr.needsUpdate = true;
  }
  activeIsolatedId = null;
  repositionAllMarkers();
  fitCameraFront(mainPoints, camera, mainVP);
  document.getElementById("isolatedBanner").style.display = "none";
  highlightClusterItem(-1);
  if (cloudData) status(`Showing all — ${cloudData.meta.n_clusters} clusters`);
}


function onClusterClick(e) {
  if (!clusterPoints || !cloudData || !clsLabels) return;
  const c = document.getElementById("clusterViewContainer"), canvas = c.querySelector("canvas");
  if (!canvas) return;
  const rect = canvas.getBoundingClientRect();
  const mx = ((e.clientX - rect.left) / rect.width) * 2 - 1;
  const my = -((e.clientY - rect.top) / rect.height) * 2 + 1;
  const rc = new THREE.Raycaster();
  rc.setFromCamera(new THREE.Vector2(mx, my), cCamera);
  rc.params.Points.threshold = Math.max(0.01, clsVP.focalDistance * 0.005);
  const hits = rc.intersectObject(clusterPoints);
  if (!hits.length) return;

  const idx = hits[0].index;
  const clusterId = clsLabels[idx];
  if (clusterId >= 0) isolateCluster(clusterId);
}


// ═══════════════════════════════════════════════════════════
// RE-CLUSTER + FAST OVERLAP
// ═══════════════════════════════════════════════════════════

function rebuildRows() {
  if (!fullLinPositions || !linLabels) return;
  clearLinRows();
  clearHoverHighlight();
  hoveredCluster = -1;
  activeIsolatedId = null;
  document.getElementById("isolatedBanner").style.display = "none";
  if (buildRowScenes()) {
    if (mainPoints) mainPoints.visible = false;
  }
  onResize();
  // Reposition markers into new row scenes
  if (clickMarkers.length > 0) repositionMarkersInRows();
  // Rebuild annotation markers in new row scenes
  if (annotationPositions && annotationPositions.length > 0) buildAnnotationMarkers();
}

function setupRecluster() {
  // Row height slider
  document.getElementById("pRowHeight").addEventListener("input", e => {
    const v = parseInt(e.target.value);
    const label = document.getElementById("rowHeightVal");
    if (v <= 400) {
      currentRowHeight = 0;  // auto
      label.textContent = "Auto";
    } else {
      currentRowHeight = v;
      label.textContent = v + "px";
    }
    rebuildRows();
  });
  // Full re-cluster (or first-time clustering from raw mode)
  document.getElementById("btnRecluster").addEventListener("click", () => {
    if (!cloudId) { status("No cloud loaded"); return; }
    const gr = parseFloat(document.getElementById("pEpsParam").value) || 0.6;
    const ov = parseFloat(document.getElementById("pOverlap").value);
    lastEpsParam = gr;
    showLoading(isRawMode ? "Clustering & linearizing…" : "Re-clustering…");
    fetch("/recluster", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cloud_id: cloudId, grid_resolution: gr, overlap: isNaN(ov) ? 0.15 : ov }) })
    .then(r => r.json()).then(d => {
      hideLoading();
      if (d.error) { status("Error: " + d.error); return; }
      // Preserve metadata across reload
      const savedName = cloudData ? cloudData.name : '';
      const savedMeta = cloudData ? { ...cloudData.meta } : {};
      const savedId = cloudId;
      if (isRawMode) {
        if (rawPoints) { scene.remove(rawPoints); rawPoints = null; }
        isRawMode = false;
      }
      // loadCloud() does clearScene() internally — full teardown + rebuild
      d.id = savedId;
      d.name = savedName;
      d.meta = savedMeta;
      d.meta.n_clusters = d.n_clusters;
      d.overlap = ov;
      loadCloud(d);
      document.getElementById("btnRecluster").textContent = "Re-Cluster";
      document.getElementById("btnApplyOverlap").disabled = false;
      status(`Clustered: ${d.n_clusters} clusters (grid=${gr}, overlap=${ov}). Double-click to mark.`);
    }).catch(e => { hideLoading(); status("Error: " + e.message); });
  });

  // Fast overlap-only (skips clustering)
  document.getElementById("btnApplyOverlap").addEventListener("click", () => {
    if (!cloudId) { status("No cloud loaded"); return; }
    if (isRawMode) { status("Cluster first before adjusting overlap."); return; }
    const ov = parseFloat(document.getElementById("pOverlap").value);
    status("Applying overlap…");
    fetch("/relinearize", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cloud_id: cloudId, overlap: isNaN(ov) ? 0.15 : ov }) })
    .then(r => r.json()).then(d => {
      if (d.error) { status("Error: " + d.error); return; }
      reloadViews(d);
      status(`Overlap updated to ${ov} (fast — no re-clustering)`);
    }).catch(e => { status("Error: " + e.message); });
  });
}

function reloadViews(d) {
  // Teardown old views
  clearLinRows();
  if (mainPoints) scene.remove(mainPoints);
  Object.values(isolatedMeshes).forEach(m => scene.remove(m));
  isolatedMeshes = {};
  if (clusterPoints) cScene.remove(clusterPoints);
  clearClicksQuiet();
  clearClickLog();
  clearHoverHighlight();
  hoveredCluster = -1;
  activeIsolatedId = null;
  document.getElementById("isolatedBanner").style.display = "none";

  // Rebuild linearized view
  fullLinPositions = decodeArr(d.linearized.positions, 'float32');
  fullLinColors = decodeArr(d.linearized.colors, 'float32');
  linBaseColors = new Float32Array(fullLinColors);
  whiteColorsData = new Float32Array(fullLinColors);
  if (d.linearized.original_xyz) originalXYZ = decodeArr(d.linearized.original_xyz, 'float64');
  if (d.linearized.labels) linLabels = decodeArr(d.linearized.labels, 'int32');
  linInstanceLabels = d.linearized.instance_labels ? decodeArr(d.linearized.instance_labels, 'int32') : null;

  // Update normal/curvature colors if available
  if (d.linearized.normal_colors) {
    normalColorsData = decodeArr(d.linearized.normal_colors, 'float32');
    curvatureColorsData = decodeArr(d.linearized.curvature_colors, 'float32');
    normalsComputed = true;
  } else if (normalsComputed) {
    fetchLinearizedDisplayColors();
  }

  // Apply current display mode colors
  if (displayMode !== 'white' && normalColorsData) {
    const nc = displayMode === 'normal' ? normalColorsData : curvatureColorsData;
    fullLinColors = new Float32Array(nc);
    linBaseColors = new Float32Array(nc);
  }

  mainPoints = makePoints(fullLinPositions, fullLinColors);
  scene.add(mainPoints);
  // Re-apply current display mode and point tint after rebuild
  applyDisplayColors();
  updateDisplayMenuChecks();
  clsPositions = decodeArr(d.clustered.positions, 'float32');
  clsColors = decodeArr(d.clustered.colors, 'float32');
  if (d.clustered.original_xyz) clsOrigXYZ = decodeArr(d.clustered.original_xyz, 'float64');
  if (d.clustered.labels) clsLabels = decodeArr(d.clustered.labels, 'int32');

  clusterPoints = makePoints(clsPositions, clsColors);
  cScene.add(clusterPoints);
  clusterPoints.userData.clusterStats = d.cluster_stats;
  clusterPoints.userData.clusterColors = d.cluster_colors;

  // Pre-build isolated meshes
  buildIsolatedMeshes();

  fitCameraFront(mainPoints, camera, mainVP);
  fitCamera(clusterPoints, cCamera, clsVP);

  // Build row scenes from cluster widths (client-side)
  if (buildRowScenes()) {
    if (mainPoints) mainPoints.visible = false;
  }
  onResize();
  requestAnimationFrame(() => onResize());

  // Rebuild annotation markers if annotation positions returned
  if (d.annotation_positions && d.annotation_positions.length > 0) {
    annotationPositions = d.annotation_positions;
    annotationPositions.forEach(a => { if (annotationFileVisibility[a.file] === undefined) annotationFileVisibility[a.file] = true; });
    buildAnnotationMarkers();
    addAnnotationLogEntries(annotationPositions);
  } else if (annotationPositions && annotationPositions.length > 0) {
    // No new positions from server — rebuild markers using existing coords
    buildAnnotationMarkers();
    addAnnotationLogEntries(annotationPositions);
  }
  updateDBTree();

  // Restore user-placed click markers (same as loadCloud)
  loadSavedClicks();

  cloudData.linearized = d.linearized;
  cloudData.clustered = d.clustered;
  cloudData.cluster_stats = d.cluster_stats;
  cloudData.cluster_colors = d.cluster_colors;
  cloudData.meta.n_clusters = d.n_clusters;

  showClusterProps(d.cluster_stats, d.cluster_colors);
  updateDBTree();
}


// ═══════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════

// Lit point-sphere ShaderMaterial — each point rendered as a tiny lit sphere
const _litPointVS = `
  attribute vec3 color;
  varying vec3 vColor;
  uniform float size;
  uniform float scale;
  uniform bool useSizeAttenuation;
  void main() {
    vColor = color;
    vec4 mvPos = modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = useSizeAttenuation ? size * (scale / -mvPos.z) : size;
    gl_PointSize = max(gl_PointSize, 1.0);
    gl_Position = projectionMatrix * mvPos;
  }
`;
const _litPointFS = `
  varying vec3 vColor;
  uniform vec3 lightDir;
  uniform float ambientStrength;
  uniform bool useLighting;
  void main() {
    // Discard hidden points (color set to black during cluster isolation)
    if (vColor.r + vColor.g + vColor.b < 0.01) discard;
    // Discard outside circle
    vec2 cxy = 2.0 * gl_PointCoord - 1.0;
    float r2 = dot(cxy, cxy);
    if (r2 > 1.0) discard;
    if (!useLighting) {
      gl_FragColor = vec4(vColor, 1.0);
      return;
    }
    // Hemisphere normal from point coord
    vec3 normal = vec3(cxy, sqrt(1.0 - r2));
    // Diffuse lighting
    float diff = max(dot(normal, lightDir), 0.0);
    // Rim/fill from opposite side
    float fill = max(dot(normal, vec3(-lightDir.x, -0.2, -lightDir.z)) * 0.3, 0.0);
    vec3 lit = vColor * (ambientStrength + (1.0 - ambientStrength) * diff + fill);
    gl_FragColor = vec4(lit, 1.0);
  }
`;

let lightingEnabled = true;

function makeLitPointsMaterial(ptSize) {
  return new THREE.ShaderMaterial({
    uniforms: {
      size: { value: ptSize || 2.0 },
      scale: { value: 1.0 },
      useSizeAttenuation: { value: false },
      lightDir: { value: new THREE.Vector3(0.35, 0.65, 0.45).normalize() },
      ambientStrength: { value: 0.45 },
      useLighting: { value: lightingEnabled },
    },
    vertexShader: _litPointVS,
    fragmentShader: _litPointFS,
    transparent: false,
    depthTest: true,
    depthWrite: true,
  });
}

function makePoints(pos, col) {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
  geo.computeBoundingBox();
  return new THREE.Points(geo, makeLitPointsMaterial(2.0));
}

function clearScene() {
  clearLinRows();
  clearPointHoverRing();
  _hoverRingScene = null;
  if (rawPoints) { scene.remove(rawPoints); rawPoints = null; }
  if (mainPoints) { scene.remove(mainPoints); mainPoints = null; }
  Object.values(isolatedMeshes).forEach(m => scene.remove(m));
  isolatedMeshes = {};
  isolatedOrigXYZMap = {};
  if (clusterPoints) { cScene.remove(clusterPoints); clusterPoints = null; }
  clickMarkers.forEach(m => { if (m.parent) m.parent.remove(m); else scene.remove(m); }); clickMarkers = [];
  cloudData = null; cloudId = null; activeIsolatedId = null;
  isRawMode = false;
  originalXYZ = null; clsOrigXYZ = null;
  fullLinPositions = null; fullLinColors = null; linBaseColors = null;
  whiteColorsData = null; rawWhiteColorsData = null; normalColorsData = null; curvatureColorsData = null; normalsComputed = false;
  linLabels = null; clsLabels = null; clsPositions = null; clsColors = null;
  hoveredCluster = -1;
  clearAnnotationMarkers();
  annotationPositions = null;
  // Keep annotationFileVisibility and annotationVisible across reclusters
  // They are only fully reset when _clearAll is called
  linInstanceLabels = null;
  // Clean DBH state without calling closeSliceTool (which calls clearIsolation)
  dbhSliceActive = false; dbhConfirmPending = false; dbhTopViewMode = false;
  document.getElementById("dbhPanel").style.display = "none";
  clearDbhMeshes();
  if(dbhCircleMesh){if(dbhCircleMesh.parent)dbhCircleMesh.parent.remove(dbhCircleMesh);dbhCircleMesh=null;}
  dbhPlacedCircles.forEach(pc=>{if(pc.mesh&&pc.mesh.parent)pc.mesh.parent.remove(pc.mesh);});
  dbhPlacedCircles=[];
  dbhHiddenPoints = null; dbhSavedCams = {};
  dbhLinesVisible = false; dbhGroundGrids = {};
  document.getElementById("isolatedBanner").style.display = "none";
  clearClickLog();
}

function fitCamera(pts, cam, vp) {
  if (!pts || !pts.geometry.boundingBox) return;
  const box = pts.geometry.boundingBox, center = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3()), d = Math.max(size.x, size.y, size.z) * 1.5;
  vp.pivotPoint.copy(center); vp.focalDistance = d;
  cam.position.set(center.x, center.y, center.z + d);
  cam.up.set(0, 1, 0); cam.lookAt(vp.pivotPoint); cam.updateProjectionMatrix();
}

function fitCameraFront(pts, cam, vp) {
  // Front view: camera looks along +Y direction, Z is up
  // Trees stand upright (Z), spread left-right (X)
  if (!pts || !pts.geometry.boundingBox) return;
  const box = pts.geometry.boundingBox, center = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3());

  // Compute distance based on FOV + aspect so the cloud fills the viewport
  const halfFov = (cam.fov / 2) * Math.PI / 180;  // radians
  const tanH = Math.tan(halfFov);
  const aspect = cam.aspect || 1;
  // Distance needed to fit Z extent vertically
  const dZ = (size.z / 2) / tanH;
  // Distance needed to fit X extent horizontally
  const dX = (size.x / 2) / (aspect * tanH);
  // Also consider Y depth (we look along -Y, but cloud may have Y depth)
  const d = Math.max(dZ, dX) * 1.1;  // 10% padding

  vp.pivotPoint.copy(center); vp.focalDistance = d;
  cam.position.set(center.x, center.y - d, center.z);
  cam.up.set(0, 0, 1);  // Z is up
  cam.lookAt(vp.pivotPoint); cam.updateProjectionMatrix();
}

function fitCameraToClusterInRow(row, clusterId) {
  // Compute bounding box of only the cluster's points within the row, then zoom in
  const posAttr = row.points.geometry.attributes.position;
  const labels = row.labels;
  const n = labels.length;
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  let found = 0;
  for (let i = 0; i < n; i++) {
    if (labels[i] !== clusterId) continue;
    const x = posAttr.getX(i), y = posAttr.getY(i), z = posAttr.getZ(i);
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
    found++;
  }
  if (found === 0) return;
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2, cz = (minZ + maxZ) / 2;
  const sx = maxX - minX, sy = maxY - minY, sz = maxZ - minZ;
  // Use FOV-based fitting for tight zoom
  const halfFov = (row.camera.fov / 2) * Math.PI / 180;
  const tanH = Math.tan(halfFov);
  const aspect = row.camera.aspect || 1;
  const dZ = (sz / 2) / tanH;
  const dX = (sx / 2) / (aspect * tanH);
  const d = Math.max(dZ, dX) * 1.15;  // 15% padding for cluster zoom
  const center = new THREE.Vector3(cx, cy, cz);
  row.vp.pivotPoint.copy(center);
  row.vp.focalDistance = d;
  row.camera.position.set(cx, cy - d, cz);
  row.camera.up.set(0, 0, 1);
  row.camera.lookAt(center);
  row.camera.updateProjectionMatrix();
}

function fitAll() {
  if (isRowMode && activeIsolatedId === null) {
    linRows.forEach(r => fitCameraFront(r.points, r.camera, r.vp));
  } else {
    const pts = getActiveMainTarget();
    if (pts) {
      if (activeIsolatedId !== null) fitCamera(pts, camera, mainVP);
      else fitCameraFront(pts, camera, mainVP);
    }
  }
}

function setView(v) {
  const applyView = (cam, vp) => {
    const p = vp.pivotPoint, d = vp.focalDistance || 15, up = new THREE.Vector3(0, 0, 1);
    switch (v) {
      case "top": cam.position.set(p.x, p.y, p.z + d); up.set(0, -1, 0); break;
      case "front": cam.position.set(p.x, p.y - d, p.z); break;
      case "right": cam.position.set(p.x + d, p.y, p.z); break;
      case "iso": cam.position.set(p.x + d * 0.6, p.y - d * 0.6, p.z + d * 0.5); break;
    }
    cam.up.copy(up); cam.lookAt(p);
  };
  if (isRowMode && activeIsolatedId === null) {
    linRows.forEach(r => applyView(r.camera, r.vp));
  } else applyView(camera, mainVP);
}

function resetView() {
  if (isRowMode && activeIsolatedId === null) {
    linRows.forEach(r => fitCameraFront(r.points, r.camera, r.vp));
  } else {
    const pts = getActiveMainTarget();
    if (pts) {
      if (activeIsolatedId !== null) fitCamera(pts, camera, mainVP);
      else fitCameraFront(pts, camera, mainVP);
    }
    else { camera.position.set(0, 5, 15); camera.up.set(0, 1, 0); camera.lookAt(0, 0, 0); mainVP.pivotPoint.set(0, 0, 0); mainVP.focalDistance = 15; }
  }
}


// ═══════════════════════════════════════════════════════════
// ═══════════════════════════════════════════════════════════

let _hoveredAnnIdx = -1;
function highlightNearestAnnotationRow(e) {
  if (!annotationPositions || !annotationPositions.length) return;
  if (!isRowMode || !linRows.length) return;
  // Don't run during drag
  const ri = getRowAtMouse(e.clientX, e.clientY);
  if (!ri) { clearAnnRowHighlight(); return; }
  const rect = renderer.domElement.getBoundingClientRect();
  const mx = ((e.clientX - rect.left) / rect.width) * 2 - 1;
  const my = -((ri.localY) / ri.rowH) * 2 + 1;
  const rc = new THREE.Raycaster();
  rc.setFromCamera(new THREE.Vector2(mx, my), ri.row.camera);
  const dist = ri.row.camera.position.distanceTo(ri.row.vp.pivotPoint);
  rc.params.Points.threshold = Math.max(0.01, dist * 0.008);
  const hits = rc.intersectObject(ri.row.points);
  if (!hits.length) { clearAnnRowHighlight(); return; }
  const pi = hits[0].index;
  // Get original XYZ of hit point
  if (!ri.row.origXYZ || pi * 3 + 2 >= ri.row.origXYZ.length) { clearAnnRowHighlight(); return; }
  const ox = ri.row.origXYZ[pi*3], oy = ri.row.origXYZ[pi*3+1], oz = ri.row.origXYZ[pi*3+2];
  // Find nearest annotation
  let bestIdx = -1, bestDist = 4.0; // 4m threshold
  for (let i = 0; i < annotationPositions.length; i++) {
    const a = annotationPositions[i];
    const dx = a.orig_x - ox, dy = a.orig_y - oy, dz = a.orig_z - oz;
    const d = Math.sqrt(dx*dx + dy*dy + dz*dz);
    if (d < bestDist) { bestDist = d; bestIdx = i; }
  }
  if (bestIdx === _hoveredAnnIdx) return;
  clearAnnRowHighlight();
  if (bestIdx >= 0) {
    _hoveredAnnIdx = bestIdx;
    const tbody = document.getElementById("clickLogTbody");
    if (!tbody) return;
    const rows = tbody.querySelectorAll("tr.ann-row");
    rows.forEach(tr => {
      if (parseInt(tr.dataset.annIdx) === bestIdx) {
        tr.style.background = "rgba(0,180,80,.25)";
        tr.style.outline = "1px solid #4fc";
        tr.scrollIntoView({ block: "nearest", behavior: "smooth" });
      }
    });
  }
}
function clearAnnRowHighlight() {
  if (_hoveredAnnIdx < 0) return;
  _hoveredAnnIdx = -1;
  const tbody = document.getElementById("clickLogTbody");
  if (!tbody) return;
  tbody.querySelectorAll("tr.ann-row").forEach(tr => {
    tr.style.background = "";
    tr.style.outline = "";
  });
}

function updateCoordReadout(e) {
  const el = document.getElementById("coordText");
  if (isRowMode && activeIsolatedId === null) {
    const ri = getRowAtMouse(e.clientX, e.clientY);
    if (!ri) { el.textContent = "X: — Y: — Z: —"; return; }
    const rect = renderer.domElement.getBoundingClientRect();
    const mx = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    const my = -((ri.localY) / ri.rowH) * 2 + 1;
    const rc = new THREE.Raycaster(); rc.setFromCamera(new THREE.Vector2(mx, my), ri.row.camera);
    rc.params.Points.threshold = 0.05;
    const hits = rc.intersectObject(ri.row.points);
    if (hits.length > 0) { const p = hits[0].point; el.textContent = `X: ${p.x.toFixed(4)}  Y: ${p.y.toFixed(4)}  Z: ${p.z.toFixed(4)}`; }
    else el.textContent = "X: — Y: — Z: —";
    return;
  }
  const target = getActiveMainTarget();
  if (!target) { el.textContent = "X: — Y: — Z: —"; return; }
  const rect = renderer.domElement.getBoundingClientRect();
  const mx = ((e.clientX - rect.left) / rect.width) * 2 - 1, my = -((e.clientY - rect.top) / rect.height) * 2 + 1;
  const rc = new THREE.Raycaster(); rc.setFromCamera(new THREE.Vector2(mx, my), camera);
  rc.params.Points.threshold = Math.max(0.01, mainVP.focalDistance * 0.005);
  const hits = rc.intersectObject(target);
  if (hits.length > 0) { const p = hits[0].point; el.textContent = `X: ${p.x.toFixed(4)}  Y: ${p.y.toFixed(4)}  Z: ${p.z.toFixed(4)}`; }
  else { el.textContent = "X: — Y: — Z: —"; }
}


// ═══════════════════════════════════════════════════════════
// POINT SIZE / GRID / AXES
// ═══════════════════════════════════════════════════════════

function setMaterialSize(mat, sz) {
  if (mat.uniforms && mat.uniforms.size) mat.uniforms.size.value = sz;
  else mat.size = sz;
}
function getMaterialSize(mat) {
  if (mat.uniforms && mat.uniforms.size) return mat.uniforms.size.value;
  return mat.size || 2;
}
function setPtSize(sz) {
  if (mainPoints) setMaterialSize(mainPoints.material, sz);
  if (rawPoints) setMaterialSize(rawPoints.material, sz);
  Object.values(isolatedMeshes).forEach(m => { setMaterialSize(m.material, sz); });
  if (clusterPoints) setMaterialSize(clusterPoints.material, sz);
  linRows.forEach(r => setMaterialSize(r.points.material, sz));
  document.getElementById("ptSlider").value = sz;
  document.getElementById("ptVal").textContent = sz.toFixed(1);
}
function toggleGrid() {
  showGrid = !showGrid;
  if (showGrid && !gridHelper) { gridHelper = new THREE.GridHelper(50, 50, 0x444444, 0x333333); scene.add(gridHelper); }
  if (gridHelper) gridHelper.visible = showGrid;
}
function toggleAxes() { showAxes = !showAxes; if (axesHelper) axesHelper.visible = showAxes; }
function toggleLighting() {
  lightingEnabled = !lightingEnabled;
  // Update all point materials
  const allMeshes = [];
  if (mainPoints) allMeshes.push(mainPoints);
  if (rawPoints) allMeshes.push(rawPoints);
  if (clusterPoints) allMeshes.push(clusterPoints);
  Object.values(isolatedMeshes).forEach(m => allMeshes.push(m));
  linRows.forEach(r => allMeshes.push(r.points));
  allMeshes.forEach(m => {
    if (m.material && m.material.uniforms && m.material.uniforms.useLighting) {
      m.material.uniforms.useLighting.value = lightingEnabled;
    }
  });
  const btn = document.getElementById("tbLighting");
  btn.classList.toggle("active", lightingEnabled);
  btn.title = lightingEnabled ? "Lighting ON (L)" : "Lighting OFF (L)";
  status(lightingEnabled ? "Lighting enabled" : "Lighting disabled");
}


// ═══════════════════════════════════════════════════════════
// UI PANELS
// ═══════════════════════════════════════════════════════════

function updateDBTree() {
  const tree = document.getElementById("dbTree");
  if (!cloudData) { tree.innerHTML = '<div class="empty">No point clouds loaded.<br/><b>File → Open</b></div>'; return; }
  const m = cloudData.meta;
  let html = '';
  if (isRawMode) {
    html = `<div class="dbi sel"><span class="dbi-icon">☁️</span><span class="dbi-name" title="${cloudData.name}">${cloudData.name}</span><span class="dbi-badge">raw</span><span class="dbi-del" onclick="event.stopPropagation();window._clearAll()">✕</span></div>
    <div class="dbi" style="padding-left:22px;"><span class="dbi-icon">📊</span><span class="dbi-name">Original (${(cloudData.displayed || m.num_points || 0).toLocaleString()} pts)</span></div>`;
  } else {
    const linDisp = cloudData.linearized ? (cloudData.linearized.displayed || 0) : 0;
    const clsDisp = cloudData.clustered ? (cloudData.clustered.displayed || 0) : 0;
    html = `<div class="dbi sel"><span class="dbi-icon">☁️</span><span class="dbi-name" title="${cloudData.name}">${cloudData.name}</span><span class="dbi-badge">${m.n_clusters || 0} cls</span><span class="dbi-del" onclick="event.stopPropagation();window._clearAll()">✕</span></div>
    <div class="dbi" style="padding-left:22px;"><span class="dbi-icon">📊</span><span class="dbi-name">Linearized (${linDisp.toLocaleString()} pts)</span></div>
    <div class="dbi" style="padding-left:22px;"><span class="dbi-icon">🔬</span><span class="dbi-name">Clustered (${clsDisp.toLocaleString()} pts)</span></div>`;
  }
  // Show annotation files if present (linearized mode: from positions, raw mode: from upload data)
  if (annotationPositions && annotationPositions.length > 0) {
    const annFiles = [...new Set(annotationPositions.map(a => a.file))];
    const globalOn = annotationVisible;
    html += `<div class="dbi ann-header" style="margin-top:4px;border-top:1px solid var(--bd);padding-top:4px;">
      <span class="dbi-eye ${globalOn ? 'on' : 'off'}" onclick="event.stopPropagation();window._toggleAllAnnotations()" title="Toggle all annotations">${globalOn ? '👁' : '👁‍🗨'}</span>
      <span class="dbi-icon">📋</span><span class="dbi-name">Annotations (${annFiles.length} trees)</span>
      <span class="dbi-badge ann-badge">${annotationPositions.length}</span></div>`;
    annFiles.forEach(fn => {
      const vis = annotationFileVisibility[fn] !== false;
      const shortName = fn.replace(/\.[^.]+$/, '').replace(/^.*?_(\d+)$/, 'Tree #$1');
      const inst = annotationPositions.find(a => a.file === fn);
      const instLabel = inst ? inst.instance : '?';
      html += `<div class="dbi ann-file" style="padding-left:28px;">
        <span class="dbi-eye ${vis ? 'on' : 'off'}" onclick="event.stopPropagation();window._toggleAnnFile('${fn}')" title="Toggle visibility">${vis ? '👁' : '👁‍🗨'}</span>
        <span class="dbi-icon" style="color:#ff69b4;">●</span><span class="dbi-name" title="${fn}">${shortName} (${instLabel})</span></div>`;
    });
  } else if (cloudData._annotationTrees && cloudData._annotationTrees.length > 0) {
    // Raw mode: show uploaded annotation files (markers appear after clustering)
    const trees = cloudData._annotationTrees;
    html += `<div class="dbi ann-header" style="margin-top:4px;border-top:1px solid var(--bd);padding-top:4px;">
      <span class="dbi-icon">📋</span><span class="dbi-name">Annotations (${trees.length} trees)</span>
      <span class="dbi-badge ann-badge">${trees.length}</span></div>`;
    trees.forEach(t => {
      const shortName = t.file.replace(/\.[^.]+$/, '').replace(/^.*?_(\d+)$/, 'Tree #$1');
      html += `<div class="dbi ann-file" style="padding-left:28px;">
        <span class="dbi-icon" style="color:#ff69b4;">●</span><span class="dbi-name" title="${t.file}">${shortName} (${t.instance})</span>
        <span style="font-size:9px;color:var(--txd);">${t.count.toLocaleString()} pts</span></div>`;
    });
  }
  tree.innerHTML = html;
}
window._clearAll = () => { clearScene(); annotationFileVisibility = {}; annotationVisible = true; clickedPoints = []; clickIdCounter = 0; updateClickCount(); updateDBTree(); showEmptyProps(); showEmptyClusterProps(); document.getElementById("btnRecluster").textContent = "Cluster & Linearize"; document.getElementById("btnApplyOverlap").disabled = true; status("Cleared"); };
window._toggleAllAnnotations = () => { toggleAnnotationVisibility(!annotationVisible); updateDBTree(); };
window._toggleAnnFile = (fn) => { toggleAnnotationFile(fn, annotationFileVisibility[fn] === false); updateDBTree(); };

function showMainProps() {
  const body = document.getElementById("propsBody"); if (!cloudData) { showEmptyProps(); return; }
  const m = cloudData.meta;
  let html = `<div class="ps"><div class="pst">General</div><div class="pr"><span class="pk">Name</span><span class="pv">${cloudData.name}</span></div><div class="pr"><span class="pk">Format</span><span class="pv">${m.format || '—'}</span></div><div class="pr"><span class="pk">Points</span><span class="pv">${(m.num_points || 0).toLocaleString()}</span></div><div class="pr"><span class="pk">Clusters</span><span class="pv">${m.n_clusters || '—'}</span></div></div><div class="ps"><div class="pst">Bounding Box</div><div class="pr"><span class="pk">Min</span><span class="pv">(${m.min_x}, ${m.min_y}, ${m.min_z})</span></div><div class="pr"><span class="pk">Max</span><span class="pv">(${m.max_x}, ${m.max_y}, ${m.max_z})</span></div></div><div class="ps"><div class="pst">Extent</div><div class="pr"><span class="pk">X</span><span class="pv">${m.extent_x} m</span></div><div class="pr"><span class="pk">Y</span><span class="pv">${m.extent_y} m</span></div><div class="pr"><span class="pk">Z</span><span class="pv">${m.extent_z} m</span></div></div>`;
  if (m.annotation_trees) {
    html += `<div class="ps"><div class="pst">Annotations</div><div class="pr"><span class="pk">Trees</span><span class="pv">${m.annotation_trees}</span></div></div>`;
  }
  body.innerHTML = html;
}
function showEmptyProps() { document.getElementById("propsBody").innerHTML = '<div class="empty">Select an item.</div>'; }

function showClusterProps(stats, colors) {
  const body = document.getElementById("clusterPropsBody");
  if (!stats || !stats.length) { showEmptyClusterProps(); return; }
  let html = '<div style="padding:4px 8px;font-size:11px;color:var(--txd);margin-bottom:4px;">Hover to highlight · Click to isolate</div>';
  stats.forEach(cs => {
    const col = cs.color, rgb = `rgb(${Math.round(col[0] * 255)},${Math.round(col[1] * 255)},${Math.round(col[2] * 255)})`;
    const active = cs.id === activeIsolatedId ? ' active' : '';
    html += `<div class="cli${active}" data-cluster-id="${cs.id}" onclick="window._isolateCluster(${cs.id})"
      onmouseenter="window._highlightCluster(${cs.id})" onmouseleave="window._unhighlightCluster()">
      <div class="cli-swatch" style="background:${rgb}"></div><span class="cli-name">Cluster #${cs.id}</span><span class="cli-count">${cs.count.toLocaleString()} pts · ${cs.height}m</span></div>`;
  });
  html += `<button class="action-btn secondary" style="margin-top:8px;" onclick="window._clearIsolation()">Clear Selection — Show All</button>`;
  body.innerHTML = html;
}
function showEmptyClusterProps() { document.getElementById("clusterPropsBody").innerHTML = '<div class="empty">Upload a point cloud to see clusters.</div>'; }
function highlightClusterItem(id) { document.querySelectorAll(".cli").forEach(el => el.classList.toggle("active", parseInt(el.dataset.clusterId) === id)); }

window._isolateCluster = isolateCluster;
window._clearIsolation = clearIsolation;
window._highlightCluster = (id) => {
  if (activeIsolatedId === null) applyHoverHighlight(id);
};
window._unhighlightCluster = () => {
  if (activeIsolatedId === null) clearHoverHighlight();
};


// ═══════════════════════════════════════════════════════════
// UPLOAD
// ═══════════════════════════════════════════════════════════

let _pendingFile = null;  // file selected but not yet uploaded

function setupUpload() {
  const modal = document.getElementById("uploadModal"), zone = document.getElementById("uploadZone"), fi = document.getElementById("fileInput");
  const annFi = document.getElementById("annFileInput"), annName = document.getElementById("annFileName"), clearAnn = document.getElementById("clearAnnBtn");
  const step2 = document.getElementById("uploadStep2");

  document.getElementById("browseBtn").addEventListener("click", () => fi.click());

  // Step 1: user selects point cloud → show step 2 (annotation option + upload button)
  fi.addEventListener("change", () => {
    if (fi.files.length > 0) {
      _pendingFile = fi.files[0];
      document.getElementById("selectedFileName").textContent = _pendingFile.name;
      zone.style.display = "none";
      step2.style.display = "block";
    }
  });
  zone.addEventListener("dragover", e => { e.preventDefault(); zone.classList.add("dragover"); });
  zone.addEventListener("dragleave", () => zone.classList.remove("dragover"));
  zone.addEventListener("drop", e => {
    e.preventDefault(); zone.classList.remove("dragover");
    if (e.dataTransfer.files.length > 0) {
      _pendingFile = e.dataTransfer.files[0];
      document.getElementById("selectedFileName").textContent = _pendingFile.name;
      zone.style.display = "none";
      step2.style.display = "block";
    }
  });

  // Clear file selection → back to step 1
  document.getElementById("clearFileBtn").addEventListener("click", () => {
    _pendingFile = null; fi.value = ""; annFi.value = "";
    annName.textContent = "No file selected"; clearAnn.style.display = "none";
    step2.style.display = "none"; zone.style.display = "";
  });

  // Annotation file handlers
  document.getElementById("browseAnnBtn").addEventListener("click", () => annFi.click());
  annFi.addEventListener("change", () => {
    if (annFi.files.length > 0) {
      annName.textContent = annFi.files.length === 1 ? annFi.files[0].name : `${annFi.files.length} files`;
      annName.title = Array.from(annFi.files).map(f => f.name).join(', ');
      clearAnn.style.display = "inline";
    } else { annName.textContent = "No file selected"; annName.title = ""; clearAnn.style.display = "none"; }
  });
  clearAnn.addEventListener("click", () => { annFi.value = ""; annName.textContent = "No file selected"; annName.title = ""; clearAnn.style.display = "none"; });

  // Step 2: Upload button → actually upload point cloud + optional annotations
  document.getElementById("btnStartUpload").addEventListener("click", () => {
    if (_pendingFile) doUpload(_pendingFile);
  });

  document.getElementById("closeModal").addEventListener("click", () => { modal.classList.remove("show"); resetModal(); });
  modal.addEventListener("click", e => { if (e.target === modal) { modal.classList.remove("show"); resetModal(); } });
}

function doUpload(file) {
  const prog = document.getElementById("uploadProgress"), fill = document.getElementById("pFill"), st = document.getElementById("uploadStatus");
  prog.style.display = "block"; fill.style.width = "0%"; st.textContent = `Uploading ${file.name}…`;
  const fd = new FormData();
  fd.append("pointcloud", file);
  // Include optional annotation file(s)
  const annFi = document.getElementById("annFileInput");
  if (annFi.files.length > 0) {
    for (let i = 0; i < annFi.files.length; i++) {
      fd.append("annotation", annFi.files[i]);
    }
  }
  const xhr = new XMLHttpRequest(); xhr.open("POST", "/upload_raw");
  xhr.upload.onprogress = e => { if (e.lengthComputable) { const pct = Math.round(e.loaded / e.total * 60); fill.style.width = pct + "%"; st.textContent = `Uploading… ${pct}%`; } };
  xhr.onload = () => {
    if (xhr.status === 200) {
      fill.style.width = "80%"; st.textContent = "Building view…";
      try {
        const data = JSON.parse(xhr.responseText);
        if (data.error) { st.textContent = "Error: " + data.error; return; }
        fill.style.width = "90%";
        setTimeout(() => {
          try {
            loadRawCloud(data);
            fill.style.width = "100%"; st.textContent = "Done!";
            setTimeout(() => { document.getElementById("uploadModal").classList.remove("show"); resetModal(); }, 800);
          } catch (loadErr) {
            console.error("Load error:", loadErr);
            st.textContent = "Load error: " + loadErr.message;
          }
        }, 50);
      } catch (e) { console.error("Parse error:", e, xhr.responseText?.substring(0, 200)); st.textContent = "Parse error: " + e.message; }
    } else {
      try { st.textContent = "Error: " + JSON.parse(xhr.responseText).error; } catch (_) { st.textContent = `Failed (HTTP ${xhr.status})`; }
    }
  };
  xhr.onerror = () => { st.textContent = "Network error"; };
  xhr.send(fd);
}

function resetModal() {
  document.getElementById("uploadProgress").style.display = "none";
  document.getElementById("pFill").style.width = "0%";
  document.getElementById("fileInput").value = "";
  document.getElementById("annFileInput").value = "";
  document.getElementById("annFileName").textContent = "No file selected";
  document.getElementById("clearAnnBtn").style.display = "none";
  // Reset to step 1
  _pendingFile = null;
  document.getElementById("uploadStep2").style.display = "none";
  document.getElementById("uploadZone").style.display = "";
}


// ═══════════════════════════════════════════════════════════
// MENUS + TOOLBAR + KEYBOARD
// ═══════════════════════════════════════════════════════════

function setupMenus() {
  document.getElementById("menuOpen").addEventListener("click", () => document.getElementById("uploadModal").classList.add("show"));
  document.getElementById("menuExport").addEventListener("click", screenshot);
  document.getElementById("menuCloseAll").addEventListener("click", () => window._clearAll());
  document.getElementById("menuToggleGrid").addEventListener("click", toggleGrid);
  document.getElementById("menuToggleAxes").addEventListener("click", toggleAxes);
  document.getElementById("menuBgBlack").addEventListener("click", () => { currentBgMode="black"; setBg("black", scene); setBg("black", cScene); linRows.forEach(r => setBg("black", r.scene)); });
  document.getElementById("menuBgGradient").addEventListener("click", () => { currentBgMode="gradient"; setBg("gradient", scene); setBg("gradient", cScene); linRows.forEach(r => setBg("gradient", r.scene)); });
  document.getElementById("menuBgWhite").addEventListener("click", () => { currentBgMode="white"; setBg("white", scene); setBg("white", cScene); linRows.forEach(r => setBg("white", r.scene)); });
  document.querySelectorAll("[data-view]").forEach(el => el.addEventListener("click", () => setView(el.dataset.view)));
  document.getElementById("menuShortcuts").addEventListener("click", () => document.getElementById("shortcutsModal").classList.add("show"));
  document.getElementById("menuClearClicks").addEventListener("click", clearAllClicks);
  document.getElementById("closeShortcuts").addEventListener("click", () => document.getElementById("shortcutsModal").classList.remove("show"));
  document.getElementById("shortcutsModal").addEventListener("click", e => { if (e.target.id === "shortcutsModal") e.target.classList.remove("show"); });
}

// ═══════════════════════════════════════════════════════════
// NORMAL / CURVATURE DISPLAY
// ═══════════════════════════════════════════════════════════

function _fetchRawNormals() {
  // Background fetch of normals for raw cloud — non-blocking, enables display modes when ready
  if (!cloudId) return;
  const cid = cloudId;
  fetch("/compute_normals", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cloud_id: cid }) })
  .then(r => r.json()).then(data => {
    // Make sure the same cloud is still loaded
    if (cloudId !== cid || !isRawMode) return;
    if (data.error) return;
    normalColorsData = decodeArr(data.normal_colors, 'float32');
    curvatureColorsData = decodeArr(data.curvature_colors, 'float32');
    normalsComputed = true;
    updateDisplayMenuChecks();
    // If user already switched mode, apply it now
    if (displayMode !== 'white') applyDisplayColors();
  }).catch(() => {});
}

function computeNormals() {
  // Fallback: manually request normal computation if not auto-done
  if (!cloudId) { status("No cloud loaded"); return; }
  if (normalsComputed) { status("Normals already computed."); return; }
  status("Computing normals & curvature…");
  fetch("/compute_normals", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cloud_id: cloudId }) })
  .then(r => r.json()).then(data => {
    if (data.error) { status("Normal computation error: " + data.error); return; }
    fetchLinearizedDisplayColors();
    normalsComputed = true;
    status(`Normals computed — ${data.num_points.toLocaleString()} pts.`);
  }).catch(e => { status("Error: " + e.message); });
}

function fetchLinearizedDisplayColors() {
  if (!cloudId) return;
  fetch("/get_display_colors", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cloud_id: cloudId }) })
  .then(r => r.json()).then(data => {
    if (data.error) return;
    normalColorsData = decodeArr(data.normal_colors, 'float32');
    curvatureColorsData = decodeArr(data.curvature_colors, 'float32');
    normalsComputed = true;
    // If current mode is not white, re-apply
    if (displayMode !== 'white') applyDisplayColors();
  }).catch(() => {});
}

function setDisplayMode(mode) {
  if (mode !== 'white' && !normalColorsData) {
    status(isRawMode
      ? "Normals not available for this file."
      : "Normals not yet computed — will be available after clustering.");
    return;
  }
  displayMode = mode;
  applyDisplayColors();
  updateColorScaleBar(mode);
  updateDisplayMenuChecks();
}

function updateDisplayMenuChecks() {
  const chkW = document.getElementById("chkWhite");
  const chkN = document.getElementById("chkNormal");
  const chkC = document.getElementById("chkCurvature");
  if (chkW) chkW.textContent = displayMode === 'white' ? '●' : '○';
  if (chkN) chkN.textContent = displayMode === 'normal' ? '●' : '○';
  if (chkC) chkC.textContent = displayMode === 'curvature' ? '●' : '○';
}

function applyDisplayColors() {
  // Raw mode: update rawPoints directly, no rows/isolation to worry about
  if (isRawMode && rawPoints) {
    const nPts = rawPoints.geometry.attributes.position.count;
    let newColors;
    if (displayMode === 'normal' && normalColorsData) {
      newColors = normalColorsData;
    } else if (displayMode === 'curvature' && curvatureColorsData) {
      newColors = curvatureColorsData;
    } else {
      // Apply white tint: multiply base colors by the chosen tint
      const base = rawWhiteColorsData || new Float32Array(nPts * 3).fill(1.0);
      newColors = new Float32Array(nPts * 3);
      for (let i = 0; i < nPts; i++) {
        newColors[i*3]   = base[i*3]   * whiteTintColor[0];
        newColors[i*3+1] = base[i*3+1] * whiteTintColor[1];
        newColors[i*3+2] = base[i*3+2] * whiteTintColor[2];
      }
    }
    rawPoints.geometry.attributes.color.array.set(newColors);
    rawPoints.geometry.attributes.color.needsUpdate = true;
    return;
  }

  if (!fullLinPositions) return;
  const nPts = fullLinPositions.length / 3;
  let newColors;

  if (displayMode === 'normal' && normalColorsData) {
    newColors = normalColorsData;
  } else if (displayMode === 'curvature' && curvatureColorsData) {
    newColors = curvatureColorsData;
  } else {
    // White with optional tint
    newColors = new Float32Array(nPts * 3);
    for (let i = 0; i < nPts; i++) {
      newColors[i*3]   = whiteTintColor[0];
      newColors[i*3+1] = whiteTintColor[1];
      newColors[i*3+2] = whiteTintColor[2];
    }
  }

  // Update global color arrays
  fullLinColors = new Float32Array(newColors);
  linBaseColors = new Float32Array(newColors);

  // Update mainPoints colors (but only write to its buffer — visibility is unchanged)
  if (mainPoints) {
    mainPoints.geometry.attributes.color.array.set(newColors);
    mainPoints.geometry.attributes.color.needsUpdate = true;
  }

  // Update each row's baseColors and current display
  if (isRowMode && linRows.length > 0) {
    // Rebuild row colors from the global color arrays
    // Each row contains a subset of points — need to re-extract colors
    rebuildRowColors();
  }

  // If a cluster is currently isolated, re-apply isolation dimming on top of the new colors
  // so the view doesn't revert to showing the full cloud
  if (activeIsolatedId !== null) {
    if (isRowMode && linRows.length > 0) {
      linRows.forEach(r => {
        const hasCluster = r.clusterIds.includes(activeIsolatedId);
        const colAttr = r.points.geometry.attributes.color;
        const arr = colAttr.array;
        const n = r.labels.length;
        if (hasCluster) {
          for (let i = 0; i < n; i++) {
            if (r.labels[i] !== activeIsolatedId) {
              arr[i*3] = 0.0; arr[i*3+1] = 0.0; arr[i*3+2] = 0.0;
            }
            // cluster points already have the correct display-mode color from rebuildRowColors
          }
        }
        colAttr.needsUpdate = true;
      });
    } else if (mainPoints && linLabels && linBaseColors) {
      // Single-scene mode: re-apply isolation filter on mainPoints
      const colAttr = mainPoints.geometry.attributes.color;
      const arr = colAttr.array;
      const n = linLabels.length;
      for (let i = 0; i < n; i++) {
        if (linLabels[i] !== activeIsolatedId) {
          arr[i*3] = 0.0; arr[i*3+1] = 0.0; arr[i*3+2] = 0.0;
        }
      }
      colAttr.needsUpdate = true;
    }
  }
}

function rebuildRowColors() {
  // Re-extract per-row colors from the current fullLinColors
  // Rows were built from fullLinPositions/fullLinColors subsets
  // We need to rebuild the color mapping
  if (!isRowMode || linRows.length === 0 || !fullLinColors || !linLabels) return;

  const nPts = linLabels.length;

  // For each row, find its points and set their colors from fullLinColors
  // The row's points are subsets identified by clusterIds
  linRows.forEach(r => {
    const grpSet = new Set(r.clusterIds);
    const colAttr = r.points.geometry.attributes.color;
    const arr = colAttr.array;
    const n = r.labels.length;

    // We need to figure out which global indices map to this row's points
    // Rebuild the index mapping (same logic as buildRowScenes)
    let j = 0;
    for (let i = 0; i < nPts; i++) {
      if (grpSet.has(linLabels[i])) {
        if (j < n) {
          arr[j*3] = fullLinColors[i*3];
          arr[j*3+1] = fullLinColors[i*3+1];
          arr[j*3+2] = fullLinColors[i*3+2];
          j++;
        }
      }
    }
    r.baseColors = new Float32Array(arr);
    colAttr.needsUpdate = true;
  });
}

function updateColorScaleBar(mode) {
  const bar = document.getElementById("colorScaleSidebar");
  const gradient = document.getElementById("colorScaleGradient");
  const labelTop = document.getElementById("colorScaleLabelTop");
  const labelBot = document.getElementById("colorScaleLabelBot");

  if (mode === 'white') {
    bar.style.display = "none";
    return;
  }

  bar.style.display = "block";
  if (mode === 'normal') {
    gradient.style.background = "linear-gradient(to bottom, rgb(0,0,255), rgb(0,255,255), rgb(0,255,0), rgb(255,255,0), rgb(255,0,0))";
    labelTop.textContent = "Z";
    labelBot.textContent = "X";
  } else if (mode === 'curvature') {
    gradient.style.background = "linear-gradient(to bottom, rgb(0,0,255), rgb(0,128,128), rgb(0,255,0))";
    labelTop.textContent = "High";
    labelBot.textContent = "Low";
  }
}

function setupToolbar() {
  document.getElementById("tbOpen").addEventListener("click", () => document.getElementById("uploadModal").classList.add("show"));
  // document.getElementById("tbFit").addEventListener("click", fitAll);
  //document.getElementById("tbReset").addEventListener("click", resetView);
  // document.getElementById("tbTop").addEventListener("click", () => setView("top"));
  //document.getElementById("tbFront").addEventListener("click", () => setView("front"));
  //document.getElementById("tbPtUp").addEventListener("click", () => setPtSize(Math.min(10, parseFloat(document.getElementById("ptSlider").value) + 0.5)));
  //document.getElementById("tbPtDn").addEventListener("click", () => setPtSize(Math.max(0.5, parseFloat(document.getElementById("ptSlider").value) - 0.5)));
  //document.getElementById("tbShot").addEventListener("click", screenshot);
  document.getElementById("tbLighting").addEventListener("click", toggleLighting);
  document.getElementById("ptSlider").addEventListener("input", e => setPtSize(parseFloat(e.target.value)));
  document.getElementById("ptColorPicker").addEventListener("input", e => {
    const hex = e.target.value;
    whiteTintColor = [
      parseInt(hex.slice(1,3),16)/255,
      parseInt(hex.slice(3,5),16)/255,
      parseInt(hex.slice(5,7),16)/255,
    ];
    if (displayMode === 'white') applyDisplayColors();
  });
  // Display mode menu items
  document.getElementById("menuDisplayWhite").addEventListener("click", () => setDisplayMode('white'));
  document.getElementById("menuDisplayNormal").addEventListener("click", () => setDisplayMode('normal'));
  document.getElementById("menuDisplayCurvature").addEventListener("click", () => setDisplayMode('curvature'));
}

function onKeyDown(e) {
  if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA" || e.target.tagName === "SELECT") return;
  if (e.ctrlKey && e.key === "o") { e.preventDefault(); document.getElementById("uploadModal").classList.add("show"); return; }
  switch (e.key) {
    case "f": case "F": fitAll(); break;
    case "r": case "R": resetView(); break;
    case "g": case "G": toggleGrid(); break;
    case "a": case "A": toggleAxes(); break;
    case "l": case "L": toggleLighting(); break;
    // +/- reserved for DBH circle fitting only
    case "1": setView("top"); break; case "2": setView("front"); break; case "3": setView("right"); break;
    case "Escape": clearIsolation(); break;
  }
}

// Render a scene into an offscreen RenderTarget and return a flipped ImageData.
// Does NOT touch the live renderer size — safe to call at any time.
function _renderToImageData(ren, renderFn, w, h) {
  const rt = new THREE.WebGLRenderTarget(w, h, {
    minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
    format: THREE.RGBAFormat, type: THREE.UnsignedByteType,
    antialias: true,
  });
  const savedRT = ren.getRenderTarget();
  const savedVP = new THREE.Vector4(); ren.getViewport(savedVP);
  const savedScissor = new THREE.Vector4(); ren.getScissor(savedScissor);
  const savedScissorTest = ren.getScissorTest();
  const savedAutoClear = ren.autoClear;

  ren.setRenderTarget(rt);
  ren.setViewport(0, 0, w, h);
  ren.setScissorTest(false);
  ren.autoClear = true;
  ren.setClearColor(0x0a0a12, 1);
  ren.clear();

  renderFn(ren, w, h);

  // Read raw RGBA pixels
  const buf = new Uint8Array(w * h * 4);
  ren.readRenderTargetPixels(rt, 0, 0, w, h, buf);

  // Restore renderer state
  ren.setRenderTarget(savedRT);
  ren.setViewport(savedVP.x, savedVP.y, savedVP.z, savedVP.w);
  ren.setScissor(savedScissor.x, savedScissor.y, savedScissor.z, savedScissor.w);
  ren.setScissorTest(savedScissorTest);
  ren.autoClear = savedAutoClear;
  rt.dispose();

  // WebGL reads pixels bottom-up — flip vertically for canvas (top-down)
  const flipped = new Uint8ClampedArray(w * h * 4);
  const rowBytes = w * 4;
  for (let row = 0; row < h; row++) {
    const src = (h - 1 - row) * rowBytes;
    const dst = row * rowBytes;
    flipped.set(buf.subarray(src, src + rowBytes), dst);
  }
  return new ImageData(flipped, w, h);
}

function screenshot() {
  const SCALE = 4; // render at 4× the current CSS pixel size

  const mainCanvas = renderer.domElement;
  const clsCanvas  = cRenderer ? cRenderer.domElement : null;

  const mainW = Math.round(mainCanvas.clientWidth  * SCALE);
  const mainH = Math.round(mainCanvas.clientHeight * SCALE);
  const clsW  = clsCanvas ? Math.round(clsCanvas.clientWidth  * SCALE) : 0;
  const clsH  = clsCanvas ? Math.round(clsCanvas.clientHeight * SCALE) : 0;

  // ── 1. Render main / row view into offscreen target ──────────
  const mainData = _renderToImageData(renderer, (ren, w, h) => {
    if (isRowMode && linRows.length > 0) {
      const nR = linRows.length;
      // Scale row heights proportionally to the hi-res output height
      const displayTotalH = linRows.length * effectiveRowHeight() + (linRows.length - 1) * ROW_GAP;
      const scaleY = h / displayTotalH;
      const rowHPx  = Math.round(effectiveRowHeight() * scaleY);
      const gapPx   = Math.round(ROW_GAP * scaleY);
      ren.setScissorTest(true);
      ren.autoClear = false;
      for (let i = 0; i < nR; i++) {
        const y = h - ((i + 1) * rowHPx + i * gapPx);
        ren.setViewport(0, Math.round(y), w, rowHPx);
        ren.setScissor(0,  Math.round(y), w, rowHPx);
        // Adjust camera aspect for hi-res width
        const savedAspect = linRows[i].camera.aspect;
        linRows[i].camera.aspect = w / Math.max(rowHPx, 1);
        linRows[i].camera.updateProjectionMatrix();
        ren.render(linRows[i].scene, linRows[i].camera);
        linRows[i].camera.aspect = savedAspect;
        linRows[i].camera.updateProjectionMatrix();
      }
      ren.setScissorTest(false);
      ren.autoClear = true;
    } else {
      ren.setViewport(0, 0, w, h);
      // Adjust camera aspect for hi-res canvas
      const savedAspect = camera.aspect;
      camera.aspect = w / Math.max(h, 1);
      camera.updateProjectionMatrix();
      ren.render(scene, camera);
      camera.aspect = savedAspect;
      camera.updateProjectionMatrix();
    }
  }, mainW, mainH);

  // ── 2. Render cluster view into offscreen target ──────────────
  let clsData = null;
  if (cRenderer && cScene && cCamera && clsW > 0 && clsH > 0) {
    clsData = _renderToImageData(cRenderer, (ren, w, h) => {
      const savedAspect = cCamera.aspect;
      cCamera.aspect = w / Math.max(h, 1);
      cCamera.updateProjectionMatrix();
      ren.setViewport(0, 0, w, h);
      ren.render(cScene, cCamera);
      cCamera.aspect = savedAspect;
      cCamera.updateProjectionMatrix();
    }, clsW, clsH);
  }

  // ── 3. Composite onto a 2D canvas and download ───────────────
  const totalW = mainW + (clsData ? clsW : 0);
  const totalH = Math.max(mainH, clsData ? clsH : 0);

  const out = document.createElement('canvas');
  out.width = totalW; out.height = totalH;
  const ctx = out.getContext('2d');
  ctx.fillStyle = '#0a0a12';
  ctx.fillRect(0, 0, totalW, totalH);
  ctx.putImageData(mainData, 0, 0);
  if (clsData) ctx.putImageData(clsData, mainW, 0);

  const a = document.createElement('a');
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  a.download = `pointcloud_${ts}.png`;
  a.href = out.toDataURL('image/png');
  a.click();
  status('High-resolution screenshot saved');
}


// ═══════════════════════════════════════════════════════════
// PANEL RESIZE
// ═══════════════════════════════════════════════════════════

function setupPanelResize() {
  // ── Vertical resizers (between panels in a column) ──
  document.querySelectorAll('.vresizer').forEach(resizer => {
    let dragging = false, startY = 0, startTopH = 0, startBotH = 0, totalH = 0;
    const topId = resizer.dataset.top, botId = resizer.dataset.bottom;
    if (!topId || !botId) return;  // skip resizers without data attrs
    const isViewportResizer = (topId === 'viewportContainer');
    resizer.addEventListener('mousedown', e => {
      e.preventDefault(); dragging = true; startY = e.clientY;
      const topEl = document.getElementById(topId), botEl = document.getElementById(botId);
      startTopH = topEl.offsetHeight;
      startBotH = botEl.offsetHeight;
      totalH = startTopH + startBotH;
      resizer.classList.add('active'); document.body.style.cursor = 'ns-resize';
    });
    document.addEventListener('mousemove', e => {
      if (!dragging) return;
      const delta = e.clientY - startY;
      const topEl = document.getElementById(topId), botEl = document.getElementById(botId);
      const minTop = isViewportResizer ? 120 : 40;
      const minBot = isViewportResizer ? 50 : 40;
      const newTop = Math.max(minTop, Math.min(totalH - minBot, startTopH + delta));
      const newBot = totalH - newTop;
      topEl.style.flex = 'none'; topEl.style.height = newTop + 'px';
      botEl.style.flex = 'none'; botEl.style.height = newBot + 'px';
      if (isViewportResizer) onResize();  // live canvas update for viewport
    });
    document.addEventListener('mouseup', () => {
      if (dragging) { dragging = false; resizer.classList.remove('active'); document.body.style.cursor = ''; onResize(); }
    });
  });

  // ── Horizontal resizers (between columns) ──
  document.querySelectorAll('.hresizer').forEach(resizer => {
    let dragging = false, startX = 0, startW = 0;
    const targetId = resizer.dataset.target, side = resizer.dataset.side;
    resizer.addEventListener('mousedown', e => {
      e.preventDefault(); dragging = true; startX = e.clientX;
      startW = document.getElementById(targetId).offsetWidth;
      resizer.classList.add('active'); document.body.style.cursor = 'ew-resize';
    });
    document.addEventListener('mousemove', e => {
      if (!dragging) return;
      const el = document.getElementById(targetId);
      if (side === 'left') el.style.width = Math.max(160, Math.min(400, startW + (e.clientX - startX))) + 'px';
      else el.style.width = Math.max(200, Math.min(500, startW - (e.clientX - startX))) + 'px';
      onResize();
    });
    document.addEventListener('mouseup', () => {
      if (dragging) { dragging = false; resizer.classList.remove('active'); document.body.style.cursor = ''; onResize(); }
    });
  });
}


// ═══════════════════════════════════════════════════════════
// MISC
// ═══════════════════════════════════════════════════════════

function onResize() {
  const c = document.getElementById("viewportContainer");
  const canvas = renderer.domElement;

  if (isRowMode && linRows.length > 0) {
    const w = c.clientWidth;
    const rowH = effectiveRowHeight();
    const nR = linRows.length;
    const totalH = nR * rowH + (nR - 1) * ROW_GAP;
    if (w > 0 && totalH > 0) {
      renderer.setSize(w, totalH);
      linRows.forEach(r => { r.camera.aspect = w / Math.max(rowH, 1); r.camera.updateProjectionMatrix(); });
      updateRowLabels();
    }
  } else {
    // Non-row mode (raw cloud, or no data)
    // Force layout recalculation: temporarily minimize canvas, read container size, then resize
    const prevW = canvas.style.width, prevH = canvas.style.height;
    canvas.style.width = '1px';
    canvas.style.height = '1px';
    void canvas.offsetHeight;   // force synchronous reflow
    const w = c.clientWidth;
    const h = c.clientHeight;
    canvas.style.width = prevW;
    canvas.style.height = prevH;
    if (w > 0 && h > 0) {
      camera.aspect = w / h; camera.updateProjectionMatrix(); renderer.setSize(w, h);
    }
  }
}
function status(t) { document.getElementById("statusText").textContent = t; }
function showLoading(t) { document.getElementById("loadingText").textContent = t; document.getElementById("loadingOverlay").classList.add("show"); }
function hideLoading() { document.getElementById("loadingOverlay").classList.remove("show"); }

function animate() {
  requestAnimationFrame(animate);

  if (isRowMode && linRows.length > 0) {
    const canvas = renderer.domElement;
    const cW = canvas.width, cH = canvas.height;
    const pr = renderer.getPixelRatio();
    const nR = linRows.length;
    const gapPx = ROW_GAP * pr;
    const rowHPx = effectiveRowHeight() * pr;

    renderer.setScissorTest(false);
    renderer.setClearColor(0x0a0a12, 1);
    renderer.clear();
    renderer.setScissorTest(true);
    renderer.autoClear = false;

    for (let i = 0; i < nR; i++) {
      const y = cH - ((i + 1) * rowHPx + i * gapPx);
      renderer.setViewport(0, Math.round(y), cW, Math.round(rowHPx));
      renderer.setScissor(0, Math.round(y), cW, Math.round(rowHPx));
      renderer.render(linRows[i].scene, linRows[i].camera);
    }

    renderer.setScissorTest(false);
    renderer.autoClear = true;
  } else {
    const canvas = renderer.domElement;
    renderer.setViewport(0, 0, canvas.width, canvas.height);
    renderer.render(scene, camera);
  }

  updateOrientCube();
  if (cRenderer && cScene && cCamera) cRenderer.render(cScene, cCamera);
  // Pulse the hover ring continuously
  if (_hoverRing && _hoverRing.visible) {
    const t = (performance.now() % 1200) / 1200;
    _hoverRing.material.opacity = 0.55 + 0.45 * Math.sin(t * Math.PI * 2);
  }
  fCnt++;
  const now = performance.now();
  if (now - fTime >= 1000) { document.getElementById("fpsEl").textContent = `FPS: ${fCnt}`; fCnt = 0; fTime = now; }
  if (clickMarkers.length > 0 && fCnt % 6 === 0) updateMarkerSizes();
}

document.addEventListener("DOMContentLoaded", init);
})();
