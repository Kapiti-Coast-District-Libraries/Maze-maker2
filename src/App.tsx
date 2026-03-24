import React, { useState, useRef, useEffect, useCallback } from 'react';
import * as THREE from 'three';
import { OrbitControls, STLLoader, STLExporter, mergeVertices } from 'three-stdlib';
import { SUBTRACTION, Brush, Evaluator } from 'three-bvh-csg'; // Switched to BVH-CSG for clean holes
import { 
  Download, 
  Trash2, 
  MousePointer2, 
  PenTool,
  Box,
  Layers,
  Info,
  Circle,
  Undo2
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';

// Constants
const WALL_THICKNESS = 2.0; // mm
const WALL_HEIGHT = 7.0; // mm
const GRID_SIZE = 5; // mm

interface Wall {
  id: string;
  start: { x: number; y: number };
  end: { x: number; y: number };
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
  const [selectedHoleId, setSelectedHoleId] = useState<string | null>(null);
  const [selectedWallId, setSelectedWallId] = useState<string | null>(null);
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [dragStartPoint, setDragStartPoint] = useState<{ x: number; y: number } | null>(null);
  const [currentWall, setCurrentWall] = useState<{ start: { x: number; y: number }, end: { x: number; y: number } } | null>(null);
  const [activeTool, setActiveTool] = useState<'select' | 'draw' | 'hole'>('select');
  const [snapToGrid, setSnapToGrid] = useState(true);
  const [gridVisible, setGridVisible] = useState(true);
  const [history, setHistory] = useState<{ walls: Wall[], holes: Hole[] }[]>([]);
  const [showClearConfirm, setShowClearConfirm] = useState(false);

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

  // Preload and Clean Base STL
  useEffect(() => {
    if (!sceneRef.current || !debugInfo.ready || baseMesh) return;

    const loader = new STLLoader();
    loader.load('./maze-base.stl', (geometry) => {
      // Critical: Merge vertices to make the geometry manifold for clean CSG operations
      const cleanedGeometry = mergeVertices(geometry);
      cleanedGeometry.computeVertexNormals();

      const material = new THREE.MeshStandardMaterial({ color: 0xaaaaaa, flatShading: true });
      const mesh = new THREE.Mesh(cleanedGeometry, material);
      
      cleanedGeometry.computeBoundingBox();
      const center = new THREE.Vector3();
      cleanedGeometry.boundingBox?.getCenter(center);
      mesh.position.sub(center);
      mesh.position.y = - (cleanedGeometry.boundingBox?.min.y || 0);

      sceneRef.current?.add(mesh);
      setBaseMesh(mesh);
      
      const size = new THREE.Vector3();
      cleanedGeometry.boundingBox?.getSize(size);
      const maxDim = Math.max(size.x, size.y, size.z);
      cameraRef.current?.position.set(maxDim * 1.5, maxDim * 1.5, maxDim * 1.5);
      controlsRef.current?.target.set(0, size.y / 2, 0);
      controlsRef.current?.update();
    });
  }, [debugInfo.ready]);

  useEffect(() => {
    if (!controlsRef.current) return;
    controlsRef.current.mouseButtons = (activeTool === 'draw' || activeTool === 'hole') 
      ? { LEFT: null, MIDDLE: THREE.MOUSE.PAN, RIGHT: THREE.MOUSE.ROTATE }
      : { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.PAN, RIGHT: THREE.MOUSE.ROTATE };
  }, [activeTool]);

  useEffect(() => {
    if (!containerRef.current) return;
    const container = containerRef.current;
    container.innerHTML = '';
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0xf0f2f5);
    sceneRef.current = scene;
    const width = container.clientWidth || 800;
    const height = container.clientHeight || 600;
    setDebugInfo(prev => ({ ...prev, width, height, ready: true }));

    const camera = new THREE.PerspectiveCamera(50, width / height, 0.1, 2000);
    camera.position.set(120, 120, 120);
    cameraRef.current = camera;

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.setSize(width, height);
    container.appendChild(renderer.domElement);
    rendererRef.current = renderer;

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controlsRef.current = controls;

    scene.add(new THREE.AmbientLight(0xffffff, 0.8));
    const dirLight = new THREE.DirectionalLight(0xffffff, 1.0);
    dirLight.position.set(100, 200, 100);
    scene.add(dirLight);

    const gridHelper = new THREE.GridHelper(400, 80, 0xcccccc, 0xeeeeee);
    scene.add(gridHelper);
    gridHelperRef.current = gridHelper;

    const drawingPlane = new THREE.Mesh(new THREE.PlaneGeometry(2000, 2000), new THREE.MeshBasicMaterial({ visible: false }));
    drawingPlane.rotation.x = -Math.PI / 2;
    scene.add(drawingPlane);
    drawingPlaneRef.current = drawingPlane;

    const wallsGroup = new THREE.Group();
    scene.add(wallsGroup);
    wallsGroupRef.current = wallsGroup;

    const holesGroup = new THREE.Group();
    scene.add(holesGroup);
    holesGroupRef.current = holesGroup;

    let animationId: number;
    const animate = () => {
      animationId = requestAnimationFrame(animate);
      if (controlsRef.current) controlsRef.current.update();
      if (rendererRef.current && sceneRef.current && cameraRef.current) {
        rendererRef.current.render(sceneRef.current, cameraRef.current);
      }
    };
    animate();
    return () => cancelAnimationFrame(animationId);
  }, []);

  useEffect(() => {
    if (!wallsGroupRef.current || !holesGroupRef.current) return;
    wallsGroupRef.current.clear();
    holesGroupRef.current.clear();

    const wallMaterial = new THREE.MeshStandardMaterial({ color: 0x3b82f6 });
    const holeMaterial = new THREE.MeshStandardMaterial({ color: 0xef4444, transparent: true, opacity: 0.8 });

    walls.forEach(wall => {
      const dx = wall.end.x - wall.start.x;
      const dz = wall.end.y - wall.start.y;
      const length = Math.sqrt(dx * dx + dz * dz);
      if (length < 0.1) return;
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(length, WALL_HEIGHT, WALL_THICKNESS), wallMaterial);
      mesh.rotation.y = -Math.atan2(dz, dx);
      mesh.position.set((wall.start.x + wall.end.x) / 2, WALL_HEIGHT / 2, (wall.start.y + wall.end.y) / 2);
      wallsGroupRef.current?.add(mesh);
      const pillar = new THREE.Mesh(new THREE.CylinderGeometry(WALL_THICKNESS/2, WALL_THICKNESS/2, WALL_HEIGHT, 16), wallMaterial);
      pillar.position.set(wall.start.x, WALL_HEIGHT/2, wall.start.y);
      wallsGroupRef.current?.add(pillar);
      const pillarEnd = pillar.clone();
      pillarEnd.position.set(wall.end.x, WALL_HEIGHT/2, wall.end.y);
      wallsGroupRef.current?.add(pillarEnd);
    });

    holes.forEach(hole => {
      const mesh = new THREE.Mesh(new THREE.CylinderGeometry(2.25, 2.25, 20, 32), holeMaterial);
      mesh.position.set(hole.x, 0, hole.y);
      holesGroupRef.current?.add(mesh);
    });

    if (currentWall) {
      const dx = currentWall.end.x - currentWall.start.x;
      const dz = currentWall.end.y - currentWall.start.y;
      const length = Math.sqrt(dx * dx + dz * dz);
      if (length > 0.1) {
        const preview = new THREE.Mesh(new THREE.BoxGeometry(length, WALL_HEIGHT, WALL_THICKNESS), new THREE.MeshStandardMaterial({ color: 0x3b82f6, transparent: true, opacity: 0.5 }));
        preview.rotation.y = -Math.atan2(dz, dx);
        preview.position.set((currentWall.start.x + currentWall.end.x) / 2, WALL_HEIGHT / 2, (currentWall.start.y + currentWall.end.y) / 2);
        wallsGroupRef.current?.add(preview);
      }
    }
  }, [walls, holes, currentWall]);

  const getMousePoint = useCallback((e: React.MouseEvent | MouseEvent) => {
    if (!containerRef.current || !cameraRef.current || !drawingPlaneRef.current) return null;
    const rect = containerRef.current.getBoundingClientRect();
    mouseRef.current.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    mouseRef.current.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    raycasterRef.current.setFromCamera(mouseRef.current, cameraRef.current);
    const intersects = raycasterRef.current.intersectObject(drawingPlaneRef.current);
    if (intersects.length > 0) {
      const pt = { x: intersects[0].point.x, y: intersects[0].point.z };
      if (baseMesh) {
        const check = new THREE.Raycaster(new THREE.Vector3(pt.x, 1000, pt.y), new THREE.Vector3(0, -1, 0));
        if (check.intersectObject(baseMesh).length === 0) return null;
      }
      if (snapToGrid) {
        pt.x = Math.round(pt.x / GRID_SIZE) * GRID_SIZE;
        pt.y = Math.round(pt.y / GRID_SIZE) * GRID_SIZE;
      }
      return pt;
    }
    return null;
  }, [snapToGrid, baseMesh]);

  const handleMouseDown = (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    const pt = getMousePoint(e);
    if (!pt) return;
    if (activeTool === 'draw') {
      setIsDrawing(true);
      setCurrentWall({ start: pt, end: pt });
      if (controlsRef.current) controlsRef.current.enabled = false;
    } else if (activeTool === 'hole') {
      saveToHistory();
      setHoles(prev => [...prev, { id: crypto.randomUUID(), x: pt.x, y: pt.y }]);
    } else if (activeTool === 'select') {
      const clickedHole = holes.find(h => Math.sqrt((h.x - pt.x)**2 + (h.y - pt.y)**2) < 8);
      if (clickedHole) {
        setSelectedHoleId(clickedHole.id);
        setDragStartPoint(pt);
        if (controlsRef.current) controlsRef.current.enabled = false;
      }
    }
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    const pt = getMousePoint(e);
    if (!pt) return;
    if (isDrawing && currentWall) setCurrentWall(prev => prev ? { ...prev, end: pt } : null);
    else if (selectedHoleId) setHoles(prev => prev.map(h => h.id === selectedHoleId ? { ...h, x: pt.x, y: pt.y } : h));
  };

  const handleMouseUp = () => {
    if (isDrawing && currentWall) {
      if (Math.sqrt((currentWall.end.x-currentWall.start.x)**2 + (currentWall.end.y-currentWall.start.y)**2) > 0.5) {
        saveToHistory();
        setWalls(prev => [...prev, { id: crypto.randomUUID(), ...currentWall }]);
      }
      setIsDrawing(false);
      setCurrentWall(null);
    }
    setSelectedHoleId(null);
    if (controlsRef.current) controlsRef.current.enabled = true;
  };

  const exportSTL = async () => {
    if (!sceneRef.current || !baseMesh) return;
    setIsExporting(true);
    await new Promise(r => setTimeout(r, 100));

    const exporter = new STLExporter();
    const evaluator = new Evaluator(); // Use the high-performance BVH-CSG evaluator
    const exportGroup = new THREE.Group();

    try {
      // 1. Prepare Base Brush
      const baseBrush = new Brush(baseMesh.geometry.clone(), baseMesh.material);
      baseBrush.updateMatrixWorld();

      let resultBrush = baseBrush;

      // 2. Subtract Holes cleanly
      for (const hole of holes) {
        const holeGeom = new THREE.CylinderGeometry(2.25, 2.25, 100, 32);
        const holeBrush = new Brush(holeGeom, new THREE.MeshBasicMaterial());
        holeBrush.position.set(hole.x, 0, hole.y);
        holeBrush.updateMatrixWorld();
        
        // Subtract hole from the current result
        resultBrush = evaluator.evaluate(resultBrush, holeBrush, SUBTRACTION);
      }

      resultBrush.geometry.computeVertexNormals();
      exportGroup.add(resultBrush);

      // 3. Add Walls
      if (wallsGroupRef.current) exportGroup.add(wallsGroupRef.current.clone());

      const result = exporter.parse(exportGroup, { binary: true });
      const link = document.createElement('a');
      link.href = URL.createObjectURL(new Blob([result], { type: 'application/octet-stream' }));
      link.download = 'clean_maze.stl';
      link.click();
    } catch (e) {
      console.error("Export failed", e);
      alert("Export error. Ensure no holes are overlapping edges excessively.");
    } finally {
      setIsExporting(false);
    }
  };

  const [isExporting, setIsExporting] = useState(false);

  return (
    <div className="flex flex-col h-screen bg-white font-sans text-neutral-900 overflow-hidden">
      <header className="flex items-center justify-between px-6 py-4 border-b border-neutral-200 z-20 bg-white">
        <div className="flex items-center gap-3">
          <div className="p-2 bg-blue-600 rounded-lg"><Layers className="w-6 h-6 text-white" /></div>
          <div>
            <h1 className="text-xl font-semibold tracking-tight">Maze Architect</h1>
            <p className="text-[10px] text-neutral-400 font-bold uppercase tracking-widest">Clean Hole Mode • BVH-CSG Active</p>
          </div>
        </div>
        <div className="flex items-center gap-4">
          <div className="flex bg-neutral-100 p-1 rounded-xl border border-neutral-200">
            <button onClick={() => setActiveTool('select')} className={`px-4 py-2 rounded-lg ${activeTool === 'select' ? 'bg-white text-blue-600' : 'text-neutral-500'}`}><MousePointer2 className="inline w-4 h-4 mr-2" />Select</button>
            <button onClick={() => setActiveTool('draw')} className={`px-4 py-2 rounded-lg ${activeTool === 'draw' ? 'bg-white text-blue-600' : 'text-neutral-500'}`}><PenTool className="inline w-4 h-4 mr-2" />Walls</button>
            <button onClick={() => setActiveTool('hole')} className={`px-4 py-2 rounded-lg ${activeTool === 'hole' ? 'bg-white text-blue-600' : 'text-neutral-500'}`}><Circle className="inline w-4 h-4 mr-2" />Hole</button>
          </div>
          <button onClick={undo} disabled={history.length === 0} className="px-4 py-2 rounded-xl border bg-white disabled:opacity-30"><Undo2 className="w-4 h-4" /></button>
          <button onClick={exportSTL} disabled={isExporting} className="px-6 py-2 bg-blue-600 text-white rounded-xl font-bold">{isExporting ? 'Processing...' : 'Export STL'}</button>
        </div>
      </header>
      <main className="flex flex-1 relative overflow-hidden">
        <aside className="w-72 bg-white border-r border-neutral-200 p-6 space-y-8 z-20 shadow-xl">
          <section className="space-y-4">
            <h2 className="text-[10px] font-black text-neutral-400 uppercase tracking-widest">Settings</h2>
            <label className="flex items-center justify-between p-4 bg-neutral-50 rounded-2xl border cursor-pointer">
              <span className="text-xs font-bold">Snap to Grid</span>
              <input type="checkbox" checked={snapToGrid} onChange={e => setSnapToGrid(e.target.checked)} />
            </label>
            <button onClick={() => { setWalls([]); setHoles([]); }} className="w-full p-4 bg-red-50 text-red-600 rounded-2xl font-bold text-xs">Clear All</button>
          </section>
        </aside>
        <div className="flex-1 relative bg-[#f8f9fa]">
          <div ref={containerRef} className="absolute inset-0" onMouseDown={handleMouseDown} onMouseMove={handleMouseMove} onMouseUp={handleMouseUp} />
        </div>
      </main>
    </div>
  );
}
