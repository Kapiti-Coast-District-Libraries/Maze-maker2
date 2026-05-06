import React, { useState, useRef, useEffect, useCallback } from 'react';
import * as THREE from 'three';
import { OrbitControls, STLLoader, STLExporter, mergeBufferGeometries as mergeGeometries } from 'three-stdlib';
import { 
  Download, 
  Trash2, 
  MousePointer2, 
  PenTool,
  Box,
  Layers,
  Circle,
  Undo2,
  Info,
  Spline
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';

// Constants
const WALL_THICKNESS = 2.0; // mm
const WALL_HEIGHT = 7.0; // mm
const GRID_SIZE = 5; // mm (default grid cell size)

interface Wall {
  id: string;
  start: { x: number; y: number };
  end: { x: number; y: number };
  control?: { x: number; y: number }; // Optional control point for curves
}

interface Hole {
  id: string;
  x: number;
  y: number;
}

export default function App() {
  const [baseMesh, setBaseMesh] = useState<THREE.Mesh | null>(null);
  const [walls, setWalls] = useState<Wall[]>([]);
  const [holes, setHoles] = useState<Hole[]>([]);
  const [isDrawing, setIsDrawing] = useState(false);
  const [curveStep, setCurveStep] = useState<0 | 1 | 2>(0); // 0: Start, 1: End, 2: Control
  const [selectedHoleId, setSelectedHoleId] = useState<string | null>(null);
  const [selectedWallId, setSelectedWallId] = useState<string | null>(null);
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [dragStartPoint, setDragStartPoint] = useState<{ x: number; y: number } | null>(null);
  const [currentWall, setCurrentWall] = useState<Wall | null>(null);
  const [activeTool, setActiveTool] = useState<'select' | 'draw' | 'curve' | 'hole'>('select');
  const [snapToGrid, setSnapToGrid] = useState(true);
  const [gridVisible, setGridVisible] = useState(true);
  const [history, setHistory] = useState<{ walls: Wall[], holes: Hole[] }[]>([]);
  const [showClearConfirm, setShowClearConfirm] = useState(false);

  const saveToHistory = useCallback(() => {
    setHistory(prev => [...prev, { walls: [...walls], holes: [...holes] }].slice(-30));
  }, [walls, holes]);

  const undo = () => {
    if (history.length === 0) return;
    const lastState = history[history.length - 1];
    setWalls(lastState.walls);
    setHoles(lastState.holes);
    setHistory(prev => prev.slice(0, -1));
  };
  
  const containerRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<THREE.Scene | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const controlsRef = useRef<OrbitControls | null>(null);
  const wallsGroupRef = useRef<THREE.Group | null>(null);
  const holesGroupRef = useRef<THREE.Group | null>(null);
  const gridHelperRef = useRef<THREE.GridHelper | null>(null);
  const raycasterRef = useRef(new THREE.Raycaster());
  const mouseRef = useRef(new THREE.Vector2());
  const drawingPlaneRef = useRef<THREE.Mesh | null>(null);

  const [debugInfo, setDebugInfo] = useState({ width: 0, height: 0, ready: false, frames: 0 });

  // HELPER: Generates 3D mesh for a curved wall segment
  const createCurvedGeometry = (wall: Wall) => {
    if (!wall.control) return new THREE.BoxGeometry(0,0,0);
    
    // Create the mathematical curve
    const curve = new THREE.QuadraticBezierCurve(
      new THREE.Vector2(wall.start.x, wall.start.y),
      new THREE.Vector2(wall.control.x, wall.control.y),
      new THREE.Vector2(wall.end.x, wall.end.y)
    );

    const points = curve.getPoints(32);
    const shape = new THREE.Shape();
    
    // Generate offset points for wall thickness
    const leftPoints: THREE.Vector2[] = [];
    const rightPoints: THREE.Vector2[] = [];

    points.forEach((pt, i) => {
      const t = i / 32;
      const tangent = curve.getTangent(t);
      const normal = new THREE.Vector2(-tangent.y, tangent.x).normalize();
      leftPoints.push(pt.clone().add(normal.clone().multiplyScalar(WALL_THICKNESS / 2)));
      rightPoints.push(pt.clone().sub(normal.clone().multiplyScalar(WALL_THICKNESS / 2)));
    });

    shape.moveTo(leftPoints[0].x, leftPoints[0].y);
    leftPoints.forEach(p => shape.lineTo(p.x, p.y));
    for (let i = rightPoints.length - 1; i >= 0; i--) shape.lineTo(rightPoints[i].x, rightPoints[i].y);
    shape.closePath();

    const geometry = new THREE.ExtrudeGeometry(shape, { depth: WALL_HEIGHT, bevelEnabled: false });
    geometry.rotateX(-Math.PI / 2); // Orient for Three.js scene
    return geometry;
  };

  // Handle OrbitControls configuration based on active tool
  useEffect(() => {
    if (!controlsRef.current) return;
    if (activeTool !== 'select') {
      controlsRef.current.mouseButtons = { LEFT: null, MIDDLE: THREE.MOUSE.PAN, RIGHT: THREE.MOUSE.ROTATE };
    } else {
      controlsRef.current.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.PAN, RIGHT: THREE.MOUSE.ROTATE };
    }
  }, [activeTool]);

  // Initialize Scene
  useEffect(() => {
    if (!containerRef.current) return;
    const container = containerRef.current;
    
    const updateDebug = () => {
      setDebugInfo(prev => ({ ...prev, width: container.clientWidth, height: container.clientHeight, ready: true }));
    };

    container.innerHTML = '';
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0xf0f2f5);
    sceneRef.current = scene;

    const width = container.clientWidth || 800;
    const height = container.clientHeight || 600;
    updateDebug();

    const camera = new THREE.PerspectiveCamera(50, width / height, 0.1, 2000);
    camera.position.set(120, 120, 120);
    cameraRef.current = camera;

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.setSize(width, height);
    renderer.shadowMap.enabled = true;
    container.appendChild(renderer.domElement);
    rendererRef.current = renderer;

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controlsRef.current = controls;

    const ambientLight = new THREE.AmbientLight(0xffffff, 0.8);
    scene.add(ambientLight);
    const dirLight = new THREE.DirectionalLight(0xffffff, 1.0);
    dirLight.position.set(100, 200, 100);
    dirLight.castShadow = true;
    scene.add(dirLight);

    const gridHelper = new THREE.GridHelper(400, 80, 0xcccccc, 0xeeeeee);
    scene.add(gridHelper);
    gridHelperRef.current = gridHelper;

    const planeGeom = new THREE.PlaneGeometry(2000, 2000);
    const drawingPlane = new THREE.Mesh(planeGeom, new THREE.MeshBasicMaterial({ visible: false }));
    drawingPlane.rotation.x = -Math.PI / 2;
    scene.add(drawingPlane);
    drawingPlaneRef.current = drawingPlane;

    const wallsGroup = new THREE.Group();
    scene.add(wallsGroup);
    wallsGroupRef.current = wallsGroup;

    const holesGroup = new THREE.Group();
    scene.add(holesGroup);
    holesGroupRef.current = holesGroup;

    const loader = new STLLoader();
    loader.load(`${import.meta.env.BASE_URL}base.stl`, (geometry) => {
      const material = new THREE.MeshStandardMaterial({ color: 0xaaaaaa, flatShading: true });
      const mesh = new THREE.Mesh(geometry, material);
      geometry.computeBoundingBox();
      const center = new THREE.Vector3();
      geometry.boundingBox?.getCenter(center);
      mesh.position.sub(center);
      mesh.position.y = - (geometry.boundingBox?.min.y || 0);
      scene.add(mesh);
      setBaseMesh(mesh);
    });

    let frameCount = 0;
    const animate = () => {
      requestAnimationFrame(animate);
      frameCount++;
      if (frameCount % 60 === 0) setDebugInfo(prev => ({ ...prev, frames: frameCount }));
      if (controlsRef.current) controlsRef.current.update();
      if (rendererRef.current && sceneRef.current && cameraRef.current) {
        rendererRef.current.render(sceneRef.current, cameraRef.current);
      }
    };
    animate();

    const resizeObserver = new ResizeObserver(() => {
      if (!cameraRef.current || !rendererRef.current || !container) return;
      const rect = container.getBoundingClientRect();
      cameraRef.current.aspect = rect.width / rect.height;
      cameraRef.current.updateProjectionMatrix();
      rendererRef.current.setSize(rect.width, rect.height);
      updateDebug();
    });
    resizeObserver.observe(container);

    return () => {
      resizeObserver.disconnect();
      if (rendererRef.current) rendererRef.current.dispose();
    };
  }, []);

  // Update Walls and Holes Meshes
  useEffect(() => {
    if (!wallsGroupRef.current || !holesGroupRef.current) return;
    
    // Cleanup
    [wallsGroupRef.current, holesGroupRef.current].forEach(group => {
      while(group.children.length > 0){ 
        const child = group.children[0] as THREE.Mesh;
        child.geometry.dispose();
        (child.material as THREE.Material).dispose();
        group.remove(child); 
      }
    });

    const wallMaterial = new THREE.MeshStandardMaterial({ color: 0x3b82f6 });
    const selectedWallMaterial = new THREE.MeshStandardMaterial({ color: 0x10b981, emissive: 0x10b981, emissiveIntensity: 0.2 });

    const renderWall = (wall: Wall, isPreview = false) => {
      const isSelected = wall.id === selectedWallId;
      const isHovered = wall.id === hoveredId;
      const material = isPreview 
        ? new THREE.MeshStandardMaterial({ color: 0x3b82f6, transparent: true, opacity: 0.5 }) 
        : (isSelected ? selectedWallMaterial : (isHovered ? new THREE.MeshStandardMaterial({ color: 0x60a5fa }) : wallMaterial));

      let mesh: THREE.Mesh;

      if (wall.control) {
        // Render Curved Wall
        mesh = new THREE.Mesh(createCurvedGeometry(wall), material);
      } else {
        // Render Straight Wall
        const dx = wall.end.x - wall.start.x;
        const dz = wall.end.y - wall.start.y;
        const length = Math.sqrt(dx * dx + dz * dz);
        if (length < 0.1) return;
        const geometry = new THREE.BoxGeometry(length, WALL_HEIGHT, WALL_THICKNESS);
        mesh = new THREE.Mesh(geometry, material);
        mesh.rotation.y = -Math.atan2(dz, dx);
        mesh.position.set((wall.start.x + wall.end.x) / 2, WALL_HEIGHT / 2, (wall.start.y + wall.end.y) / 2);
      }
      
      wallsGroupRef.current?.add(mesh);

      // Connectors
      const pillarGeom = new THREE.CylinderGeometry(WALL_THICKNESS / 2, WALL_THICKNESS / 2, WALL_HEIGHT, 16);
      [wall.start, wall.end].forEach(pos => {
        const p = new THREE.Mesh(pillarGeom, material);
        p.position.set(pos.x, WALL_HEIGHT/2, pos.y);
        wallsGroupRef.current?.add(p);
      });
    };

    walls.forEach(w => renderWall(w));
    if (currentWall) renderWall(currentWall, true);

    holes.forEach(hole => {
      const isSelected = hole.id === selectedHoleId;
      const mat = new THREE.MeshStandardMaterial({ color: isSelected ? 0xffff00 : 0xef4444, transparent: true, opacity: 0.8 });
      const mesh = new THREE.Mesh(new THREE.CylinderGeometry(2.25, 2.25, 20, 32), mat);
      mesh.position.set(hole.x, 0, hole.y);
      holesGroupRef.current?.add(mesh);
    });

  }, [walls, holes, currentWall, selectedHoleId, selectedWallId, hoveredId]);

  const getMousePoint = useCallback((e: React.MouseEvent | MouseEvent) => {
    if (!containerRef.current || !cameraRef.current || !drawingPlaneRef.current) return null;
    const rect = containerRef.current.getBoundingClientRect();
    mouseRef.current.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    mouseRef.current.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    raycasterRef.current.setFromCamera(mouseRef.current, cameraRef.current);
    const intersects = raycasterRef.current.intersectObject(drawingPlaneRef.current);
    if (intersects.length > 0) {
      const pt = { x: intersects[0].point.x, y: intersects[0].point.z };
      if (snapToGrid) {
        pt.x = Math.round(pt.x / GRID_SIZE) * GRID_SIZE;
        pt.y = Math.round(pt.y / GRID_SIZE) * GRID_SIZE;
      }
      return pt;
    }
    return null;
  }, [snapToGrid]);

  const handleMouseDown = (e: React.MouseEvent) => {
    if (e.button !== 0) return; 
    const point = getMousePoint(e);
    if (!point) return;

    if (activeTool === 'draw') {
      setIsDrawing(true);
      setCurrentWall({ id: crypto.randomUUID(), start: point, end: point });
      if (controlsRef.current) controlsRef.current.enabled = false;
    } else if (activeTool === 'curve') {
      if (curveStep === 0) {
        setCurrentWall({ id: crypto.randomUUID(), start: point, end: point, control: point });
        setCurveStep(1);
      } else if (curveStep === 1) {
        setCurveStep(2);
      } else {
        saveToHistory();
        if (currentWall) setWalls([...walls, currentWall]);
        setCurrentWall(null);
        setCurveStep(0);
      }
    } else if (activeTool === 'hole') {
      saveToHistory();
      setHoles([...holes, { id: crypto.randomUUID(), x: point.x, y: point.y }]);
    } else if (activeTool === 'select') {
      // (Select logic same as before)
      const clickedHole = holes.find(h => Math.sqrt((h.x - point.x) ** 2 + (h.y - point.y) ** 2) < 8);
      if (clickedHole) {
        setSelectedHoleId(clickedHole.id); setSelectedWallId(null); setDragStartPoint(point);
        if (controlsRef.current) controlsRef.current.enabled = false;
        return;
      }
      setSelectedHoleId(null); setSelectedWallId(null);
    }
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    const point = getMousePoint(e);
    if (!point) return;

    if (activeTool === 'draw' && isDrawing && currentWall) {
      setCurrentWall({ ...currentWall, end: point });
    } else if (activeTool === 'curve' && currentWall) {
      if (curveStep === 1) {
        setCurrentWall({ ...currentWall, end: point, control: { x: (currentWall.start.x + point.x)/2, y: (currentWall.start.y + point.y)/2 } });
      } else if (curveStep === 2) {
        setCurrentWall({ ...currentWall, control: point });
      }
    }
  };

  const handleMouseUp = () => {
    if (activeTool === 'draw' && isDrawing && currentWall) {
      saveToHistory();
      setWalls([...walls, currentWall]);
      setCurrentWall(null);
      setIsDrawing(false);
      if (controlsRef.current) controlsRef.current.enabled = true;
    }
    setDragStartPoint(null);
  };

  const clearWalls = () => { saveToHistory(); setWalls([]); setHoles([]); setShowClearConfirm(false); };

  const exportSTL = async () => {
    if (!sceneRef.current) return;
    setIsExporting(true);
    await new Promise(r => setTimeout(r, 50));
    const exporter = new STLExporter();
    
    try {
      const solidGeometries: THREE.BufferGeometry[] = [];
      if (baseMesh) {
        const g = baseMesh.geometry.clone(); g.applyMatrix4(baseMesh.matrixWorld);
        solidGeometries.push(g);
      }
      wallsGroupRef.current?.traverse((c) => {
        if (c instanceof THREE.Mesh) {
          const g = c.geometry.clone(); c.updateWorldMatrix(true, false); g.applyMatrix4(c.matrixWorld);
          solidGeometries.push(g);
        }
      });

      const merged = mergeGeometries(solidGeometries, false);
      const exportGroup = new THREE.Group();
      if (merged) exportGroup.add(new THREE.Mesh(merged));
      
      const stlResult = exporter.parse(exportGroup, { binary: true });
      const link = document.createElement('a');
      link.href = URL.createObjectURL(new Blob([stlResult]));
      link.download = 'maze_architect_export.stl';
      link.click();
    } finally { setIsExporting(false); }
  };

  return (
    <div className="flex flex-col h-screen bg-white font-sans text-neutral-900 overflow-hidden">
      <header className="flex items-center justify-between px-6 py-4 border-b border-neutral-200 z-20 bg-white">
        <div className="flex items-center gap-3">
          <div className="p-2 bg-blue-600 rounded-lg"><Layers className="w-6 h-6 text-white" /></div>
          <div>
            <h1 className="text-xl font-semibold tracking-tight">Maze Architect</h1>
            <p className="text-[10px] text-neutral-400 font-bold uppercase tracking-widest">3D Print Generator • <span className="text-green-500">Active</span></p>
          </div>
        </div>
        
        <div className="flex items-center gap-4">
          <div className="flex bg-neutral-100 p-1 rounded-xl border border-neutral-200">
            <button onClick={() => setActiveTool('select')} className={`flex items-center gap-2 px-4 py-2 rounded-lg ${activeTool === 'select' ? 'bg-white shadow-sm text-blue-600' : 'text-neutral-500'}`}><MousePointer2 className="w-4 h-4" /> <span className="text-sm font-semibold">Select</span></button>
            <button onClick={() => setActiveTool('draw')} className={`flex items-center gap-2 px-4 py-2 rounded-lg ${activeTool === 'draw' ? 'bg-white shadow-sm text-blue-600' : 'text-neutral-500'}`}><PenTool className="w-4 h-4" /> <span className="text-sm font-semibold">Walls</span></button>
            <button onClick={() => setActiveTool('curve')} className={`flex items-center gap-2 px-4 py-2 rounded-lg ${activeTool === 'curve' ? 'bg-white shadow-sm text-blue-600' : 'text-neutral-500'}`}><Spline className="w-4 h-4" /> <span className="text-sm font-semibold">Curves</span></button>
            <button onClick={() => setActiveTool('hole')} className={`flex items-center gap-2 px-4 py-2 rounded-lg ${activeTool === 'hole' ? 'bg-white shadow-sm text-blue-600' : 'text-neutral-500'}`}><Circle className="w-4 h-4" /> <span className="text-sm font-semibold">Hole</span></button>
          </div>
          <button onClick={undo} disabled={history.length === 0} className="flex items-center gap-2 px-4 py-2 rounded-xl border bg-white disabled:opacity-30"><Undo2 className="w-4 h-4" /> <span className="text-sm font-semibold">Undo</span></button>
          <button onClick={exportSTL} disabled={isExporting} className="flex items-center gap-2 px-6 py-2 bg-blue-600 text-white rounded-xl font-bold shadow-md active:scale-95">
            {isExporting ? <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" /> : <Download className="w-4 h-4" />}
            <span>{isExporting ? 'Processing...' : 'Export STL'}</span>
          </button>
        </div>
      </header>

      <main className="flex flex-1 relative overflow-hidden">
        <aside className="w-72 bg-white border-r border-neutral-200 flex flex-col z-20 shadow-xl p-6 space-y-8 overflow-y-auto">
          <section className="space-y-4">
            <h2 className="text-[10px] font-black text-neutral-400 uppercase tracking-widest">Wall Specs</h2>
            <div className="grid grid-cols-2 gap-3">
              <div className="p-4 bg-neutral-50 rounded-2xl border border-neutral-100">
                <p className="text-[9px] font-black text-neutral-400 uppercase">Thickness</p>
                <p className="text-lg font-mono font-bold text-neutral-800">{WALL_THICKNESS}mm</p>
              </div>
              <div className="p-4 bg-neutral-50 rounded-2xl border border-neutral-100">
                <p className="text-[9px] font-black text-neutral-400 uppercase">Height</p>
                <p className="text-lg font-mono font-bold text-neutral-800">{WALL_HEIGHT}mm</p>
              </div>
            </div>
          </section>

          <section className="space-y-4">
            <h2 className="text-[10px] font-black text-neutral-400 uppercase tracking-widest">Editor</h2>
            <div className="space-y-2">
              <label className="flex items-center justify-between p-4 bg-neutral-50 rounded-2xl border border-neutral-100 cursor-pointer">
                <span className="text-xs font-bold text-neutral-600">Snap to Grid</span>
                <input type="checkbox" checked={snapToGrid} onChange={(e) => setSnapToGrid(e.target.checked)} className="w-4 h-4 text-blue-600" />
              </label>
              <label className="flex items-center justify-between p-4 bg-neutral-50 rounded-2xl border border-neutral-100 cursor-pointer">
                <span className="text-xs font-bold text-neutral-600">Show Grid</span>
                <input type="checkbox" checked={gridVisible} onChange={(e) => { setGridVisible(e.target.checked); if (gridHelperRef.current) gridHelperRef.current.visible = e.target.checked; }} className="w-4 h-4 text-blue-600" />
              </label>
            </div>
            <button onClick={() => setShowClearConfirm(true)} className="w-full flex items-center justify-center gap-2 p-4 bg-red-50 text-red-600 rounded-2xl border border-red-100 font-bold text-xs">
              <Trash2 className="w-4 h-4" /> Clear All
            </button>
          </section>
        </aside>

        <div className="flex-1 relative bg-[#f8f9fa] overflow-hidden">
          <div ref={containerRef} className="absolute inset-0" onMouseDown={handleMouseDown} onMouseMove={handleMouseMove} onMouseUp={handleMouseUp} />
          
          <div className="absolute top-4 right-4 bg-black/80 text-white p-2 rounded text-xs font-mono z-50 pointer-events-none">
            Viewport: {debugInfo.width}x{debugInfo.height} | F: {debugInfo.frames}
          </div>

          <AnimatePresence>
            {activeTool === 'curve' && (
              <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} className="absolute bottom-10 left-1/2 -translate-x-1/2 bg-blue-600 text-white px-8 py-4 rounded-2xl shadow-2xl flex items-center gap-4 z-10 pointer-events-none">
                <Spline className="w-5 h-5" />
                <span className="text-sm font-black uppercase tracking-widest">
                  {curveStep === 0 && "Click to Start Curve"}
                  {curveStep === 1 && "Click to Set End Point"}
                  {curveStep === 2 && "Move to Curve, Click to Finish"}
                </span>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </main>
    </div>
  );
}
