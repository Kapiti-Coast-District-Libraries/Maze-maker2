import React, { useState, useRef, useEffect, useCallback } from 'react';
import * as THREE from 'three';
import { OrbitControls, STLLoader, STLExporter, mergeVertices } from 'three-stdlib';
import { Evaluator, SUBTRACTION } from 'three-bvh-csg'; // Robust CSG Engine
import { 
  Upload, 
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
  const [isExporting, setIsExporting] = useState(false);

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

  // Scene Initialization
  useEffect(() => {
    if (!containerRef.current) return;
    const container = containerRef.current;
    container.innerHTML = '';

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0xf0f2f5);
    sceneRef.current = scene;

    const camera = new THREE.PerspectiveCamera(50, container.clientWidth / container.clientHeight, 0.1, 2000);
    camera.position.set(120, 120, 120);
    cameraRef.current = camera;

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.setSize(container.clientWidth, container.clientHeight);
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

    wallsGroupRef.current = new THREE.Group();
    holesGroupRef.current = new THREE.Group();
    scene.add(wallsGroupRef.current, holesGroupRef.current);

    const animate = () => {
      requestAnimationFrame(animate);
      if (controlsRef.current) controlsRef.current.update();
      if (rendererRef.current && sceneRef.current && cameraRef.current) {
        rendererRef.current.render(sceneRef.current, cameraRef.current);
      }
    };
    animate();

    const resizeObserver = new ResizeObserver(() => {
      if (!cameraRef.current || !rendererRef.current) return;
      cameraRef.current.aspect = container.clientWidth / container.clientHeight;
      cameraRef.current.updateProjectionMatrix();
      rendererRef.current.setSize(container.clientWidth, container.clientHeight);
    });
    resizeObserver.observe(container);

    return () => {
      resizeObserver.disconnect();
      renderer.dispose();
    };
  }, []);

  // Sync Walls and Holes to Scene
  useEffect(() => {
    if (!wallsGroupRef.current || !holesGroupRef.current) return;
    
    [wallsGroupRef.current, holesGroupRef.current].forEach(g => {
      while(g.children.length > 0) {
        const c = g.children[0] as THREE.Mesh;
        c.geometry.dispose();
        (c.material as THREE.Material).dispose();
        g.remove(c);
      }
    });

    walls.forEach(wall => {
      const dx = wall.end.x - wall.start.x;
      const dz = wall.end.y - wall.start.y;
      const length = Math.sqrt(dx * dx + dz * dz);
      if (length < 0.1) return;

      const mat = new THREE.MeshStandardMaterial({ color: wall.id === selectedWallId ? 0x10b981 : 0x3b82f6 });
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(length, WALL_HEIGHT, WALL_THICKNESS), mat);
      mesh.rotation.y = -Math.atan2(dz, dx);
      mesh.position.set((wall.start.x + wall.end.x) / 2, WALL_HEIGHT / 2, (wall.start.y + wall.end.y) / 2);
      wallsGroupRef.current?.add(mesh);

      const pGeom = new THREE.CylinderGeometry(WALL_THICKNESS/2, WALL_THICKNESS/2, WALL_HEIGHT, 16);
      [wall.start, wall.end].forEach(p => {
        const pillar = new THREE.Mesh(pGeom, mat);
        pillar.position.set(p.x, WALL_HEIGHT / 2, p.y);
        wallsGroupRef.current?.add(pillar);
      });
    });

    holes.forEach(hole => {
      const mat = new THREE.MeshStandardMaterial({ color: hole.id === selectedHoleId ? 0xffff00 : 0xef4444, transparent: true, opacity: 0.8 });
      const mesh = new THREE.Mesh(new THREE.CylinderGeometry(2.25, 2.25, 20, 32), mat);
      mesh.position.set(hole.x, 0, hole.y);
      holesGroupRef.current?.add(mesh);
    });

    if (currentWall) {
      const dx = currentWall.end.x - currentWall.start.x;
      const dz = currentWall.end.y - currentWall.start.y;
      const length = Math.sqrt(dx * dx + dz * dz);
      if (length > 0.1) {
        const previewMesh = new THREE.Mesh(new THREE.BoxGeometry(length, WALL_HEIGHT, WALL_THICKNESS), new THREE.MeshStandardMaterial({ color: 0x3b82f6, transparent: true, opacity: 0.5 }));
        previewMesh.rotation.y = -Math.atan2(dz, dx);
        previewMesh.position.set((currentWall.start.x + currentWall.end.x) / 2, WALL_HEIGHT / 2, (currentWall.start.y + currentWall.end.y) / 2);
        wallsGroupRef.current?.add(previewMesh);
      }
    }
  }, [walls, holes, currentWall, selectedWallId, selectedHoleId]);

  // File Upload
  const handleFileUpload = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (e) => {
      const loader = new STLLoader();
      const geom = loader.parse(e.target?.result as ArrayBuffer);
      if (baseMesh) sceneRef.current?.remove(baseMesh);
      
      const mesh = new THREE.Mesh(geom, new THREE.MeshStandardMaterial({ color: 0xaaaaaa, flatShading: true }));
      geom.computeBoundingBox();
      const center = new THREE.Vector3();
      geom.boundingBox?.getCenter(center);
      mesh.position.sub(center);
      mesh.position.y = -(geom.boundingBox?.min.y || 0);

      sceneRef.current?.add(mesh);
      setBaseMesh(mesh);
      
      const size = new THREE.Vector3();
      geom.boundingBox?.getSize(size);
      cameraRef.current?.position.set(size.x * 1.5, size.y * 5, size.z * 1.5);
      controlsRef.current?.target.set(0, 0, 0);
    };
    reader.readAsArrayBuffer(file);
  };

  // Interaction Logic
  const getMousePoint = useCallback((e: React.MouseEvent) => {
    if (!containerRef.current || !cameraRef.current || !drawingPlaneRef.current) return null;
    const rect = containerRef.current.getBoundingClientRect();
    mouseRef.current.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    mouseRef.current.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    raycasterRef.current.setFromCamera(mouseRef.current, cameraRef.current);
    const intersects = raycasterRef.current.intersectObject(drawingPlaneRef.current);
    if (intersects.length > 0) {
      let pt = { x: intersects[0].point.x, y: intersects[0].point.z };
      if (snapToGrid) {
        pt.x = Math.round(pt.x / GRID_SIZE) * GRID_SIZE;
        pt.y = Math.round(pt.y / GRID_SIZE) * GRID_SIZE;
      }
      return pt;
    }
    return null;
  }, [snapToGrid]);

  const handleMouseDown = (e: React.MouseEvent) => {
    const pt = getMousePoint(e);
    if (!pt || e.button !== 0) return;

    if (activeTool === 'draw') {
      setIsDrawing(true);
      setCurrentWall({ start: pt, end: pt });
      if (controlsRef.current) controlsRef.current.enabled = false;
    } else if (activeTool === 'hole') {
      saveToHistory();
      setHoles(prev => [...prev, { id: crypto.randomUUID(), x: pt.x, y: pt.y }]);
    }
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    const pt = getMousePoint(e);
    if (isDrawing && currentWall && pt) {
      setCurrentWall(prev => prev ? { ...prev, end: pt } : null);
    }
  };

  const handleMouseUp = () => {
    if (isDrawing && currentWall) {
      if (Math.sqrt((currentWall.end.x - currentWall.start.x)**2 + (currentWall.end.y - currentWall.start.y)**2) > 0.5) {
        saveToHistory();
        setWalls(prev => [...prev, { id: crypto.randomUUID(), ...currentWall }]);
      }
      setIsDrawing(false);
      setCurrentWall(null);
    }
    if (controlsRef.current) controlsRef.current.enabled = true;
  };

  // ROBUST REPLICA EXPORT LOGIC
  const exportSTL = async () => {
    if (!sceneRef.current) return;
    setIsExporting(true);
    
    // UI Update delay
    await new Promise(resolve => setTimeout(resolve, 100));

    const exporter = new STLExporter();
    const evaluator = new Evaluator();
    
    try {
      // 1. Create a replica of the base
      let baseReplica: THREE.Mesh;
      if (baseMesh) {
        baseReplica = baseMesh.clone();
        // Index and clean vertices to ensure boolean math succeeds
        baseReplica.geometry = mergeVertices(baseReplica.geometry);
      } else {
        // Fallback floor if no mesh is loaded
        const floorGeom = new THREE.BoxGeometry(200, 2, 200);
        baseReplica = new THREE.Mesh(floorGeom, new THREE.MeshStandardMaterial());
      }
      baseReplica.updateMatrixWorld();

      // 2. Perform Subtractions using BVH-CSG
      let finalBase = baseReplica;
      if (holes.length > 0) {
        for (const hole of holes) {
          // Use a long cylinder to ensure it punches through both top and bottom
          const holeGeom = new THREE.CylinderGeometry(2.25, 2.25, 100, 32);
          const holeMesh = new THREE.Mesh(holeGeom);
          holeMesh.position.set(hole.x, 0, hole.y);
          holeMesh.updateMatrixWorld();
          
          // Construct the new geometry by subtracting the hole from the base
          finalBase = evaluator.evaluate(finalBase, holeMesh, SUBTRACTION);
        }
      }

      // 3. Add walls to the final assembly
      const exportAssembly = new THREE.Group();
      exportAssembly.add(finalBase);
      
      if (wallsGroupRef.current) {
        exportAssembly.add(wallsGroupRef.current.clone());
      }

      // 4. Generate file
      const result = exporter.parse(exportAssembly, { binary: true });
      const blob = new Blob([result], { type: 'application/octet-stream' });
      const link = document.createElement('a');
      link.href = URL.createObjectURL(blob);
      link.download = 'maze_output_bored.stl';
      link.click();
      
    } catch (error) {
      console.error('CSG Error:', error);
      alert('Could not bore holes. The model might have topological errors. Exporting group without cuts.');
      const fallback = new THREE.Group();
      if (baseMesh) fallback.add(baseMesh.clone());
      if (wallsGroupRef.current) fallback.add(wallsGroupRef.current.clone());
      const res = exporter.parse(fallback, { binary: true });
      const link = document.createElement('a');
      link.href = URL.createObjectURL(new Blob([res]));
      link.download = 'maze_fallback.stl';
      link.click();
    } finally {
      setIsExporting(false);
    }
  };

  return (
    <div className="flex flex-col h-screen bg-white font-sans text-neutral-900 overflow-hidden">
      <header className="flex items-center justify-between px-6 py-4 border-b border-neutral-200 z-20 bg-white">
        <div className="flex items-center gap-3">
          <div className="p-2 bg-blue-600 rounded-lg"><Layers className="w-6 h-6 text-white" /></div>
          <div>
            <h1 className="text-xl font-semibold tracking-tight">Maze Architect</h1>
            <p className="text-[10px] text-neutral-400 font-bold uppercase tracking-widest">Replica Export Engine v2</p>
          </div>
        </div>
        
        <div className="flex items-center gap-4">
          <div className="flex bg-neutral-100 p-1 rounded-xl border border-neutral-200">
            <button onClick={() => setActiveTool('select')} className={`px-4 py-2 rounded-lg text-sm font-semibold transition-all ${activeTool === 'select' ? 'bg-white shadow-sm text-blue-600' : 'text-neutral-500'}`}>Select</button>
            <button onClick={() => setActiveTool('draw')} className={`px-4 py-2 rounded-lg text-sm font-semibold transition-all ${activeTool === 'draw' ? 'bg-white shadow-sm text-blue-600' : 'text-neutral-500'}`}>Walls</button>
            <button onClick={() => setActiveTool('hole')} className={`px-4 py-2 rounded-lg text-sm font-semibold transition-all ${activeTool === 'hole' ? 'bg-white shadow-sm text-blue-600' : 'text-neutral-500'}`}>Hole</button>
          </div>
          <button onClick={undo} disabled={history.length === 0} className="flex items-center gap-2 px-4 py-2 rounded-xl border bg-white disabled:opacity-30"><Undo2 className="w-4 h-4" /> <span className="text-sm font-semibold">Undo</span></button>
          <button onClick={exportSTL} disabled={isExporting} className="flex items-center gap-2 px-6 py-2 bg-blue-600 text-white rounded-xl font-bold active:scale-95 disabled:bg-blue-300">
            <Download className="w-4 h-4" /> <span>{isExporting ? 'Boring Holes...' : 'Export STL'}</span>
          </button>
        </div>
      </header>

      <main className="flex flex-1 relative overflow-hidden">
        <aside className="w-72 bg-white border-r border-neutral-200 p-6 space-y-8 z-20 shadow-xl">
          <section className="space-y-4">
            <h2 className="text-[10px] font-black text-neutral-400 uppercase tracking-widest">Base Model</h2>
            <div className="relative border-2 border-dashed border-neutral-200 rounded-2xl p-8 text-center bg-neutral-50/50">
              <input type="file" accept=".stl" onChange={handleFileUpload} className="absolute inset-0 opacity-0 cursor-pointer" />
              <Upload className="w-8 h-8 text-neutral-300 mx-auto mb-2" />
              <p className="text-xs font-bold text-neutral-500">{baseMesh ? 'Change Base' : 'Import STL'}</p>
            </div>
          </section>
          <section className="space-y-4">
            <h2 className="text-[10px] font-black text-neutral-400 uppercase tracking-widest">Status</h2>
            <div className="p-4 bg-neutral-50 rounded-2xl border border-neutral-100">
              <p className="text-[9px] font-black text-neutral-400 uppercase">Elements</p>
              <p className="text-sm font-bold text-neutral-800">{walls.length} Walls / {holes.length} Holes</p>
            </div>
          </section>
        </aside>

        <div className="flex-1 relative bg-[#f8f9fa]">
          <div 
            ref={containerRef} 
            className="absolute inset-0"
            style={{ cursor: activeTool === 'draw' ? 'crosshair' : 'default' }}
            onMouseDown={handleMouseDown}
            onMouseMove={handleMouseMove}
            onMouseUp={handleMouseUp}
          />
        </div>
      </main>
    </div>
  );
}
