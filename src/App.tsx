import React, { useState, useRef, useEffect, useCallback } from 'react';
import * as THREE from 'three';
import { OrbitControls, STLLoader, STLExporter, mergeVertices } from 'three-stdlib';
// Use the more robust BVH-CSG library
import { Evaluator, Operation, ADDITION, SUBTRACTION } from 'three-bvh-csg';
import { 
  Upload, 
  Download, 
  Trash2, 
  Grid3X3, 
  MousePointer2, 
  PenTool,
  Box,
  Layers,
  Settings2,
  Maximize2,
  Info,
  Circle,
  Undo2
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

  // Handle OrbitControls configuration based on active tool
  useEffect(() => {
    if (!controlsRef.current) return;
    
    if (activeTool === 'draw' || activeTool === 'hole') {
      controlsRef.current.mouseButtons = {
        LEFT: null,
        MIDDLE: THREE.MOUSE.PAN,
        RIGHT: THREE.MOUSE.ROTATE
      };
    } else {
      controlsRef.current.mouseButtons = {
        LEFT: THREE.MOUSE.ROTATE,
        MIDDLE: THREE.MOUSE.PAN,
        RIGHT: THREE.MOUSE.ROTATE
      };
    }
  }, [activeTool]);

  // Initialize Scene
  useEffect(() => {
    if (!containerRef.current) return;

    const container = containerRef.current;
    
    const updateDebug = () => {
      setDebugInfo(prev => ({
        ...prev,
        width: container.clientWidth,
        height: container.clientHeight,
        ready: true
      }));
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
    renderer.domElement.style.display = 'block';
    container.appendChild(renderer.domElement);
    rendererRef.current = renderer;

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.05;
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
    const planeMat = new THREE.MeshBasicMaterial({ visible: false });
    const drawingPlane = new THREE.Mesh(planeGeom, planeMat);
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
    let frameCount = 0;
    const animate = () => {
      animationId = requestAnimationFrame(animate);
      frameCount++;
      if (frameCount % 60 === 0) {
        setDebugInfo(prev => ({ ...prev, frames: frameCount }));
      }
      if (controlsRef.current) controlsRef.current.update();
      if (rendererRef.current && sceneRef.current && cameraRef.current) {
        rendererRef.current.render(sceneRef.current, cameraRef.current);
      }
    };
    animate();

    const resizeObserver = new ResizeObserver(() => {
      if (!cameraRef.current || !rendererRef.current || !container) return;
      const rect = container.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return;
      
      cameraRef.current.aspect = rect.width / rect.height;
      cameraRef.current.updateProjectionMatrix();
      rendererRef.current.setSize(rect.width, rect.height);
      updateDebug();
    });
    resizeObserver.observe(container);

    return () => {
      cancelAnimationFrame(animationId);
      resizeObserver.disconnect();
      if (rendererRef.current) rendererRef.current.dispose();
      if (container.contains(renderer.domElement)) container.removeChild(renderer.domElement);
    };
  }, []);

  // Update Visuals
  useEffect(() => {
    if (!wallsGroupRef.current || !holesGroupRef.current) return;
    
    [wallsGroupRef.current, holesGroupRef.current].forEach(group => {
      while(group.children.length > 0){ 
        const child = group.children[0] as THREE.Mesh;
        child.geometry.dispose();
        if (Array.isArray(child.material)) child.material.forEach(m => m.dispose());
        else child.material.dispose();
        group.remove(child); 
      }
    });

    const wallMaterial = new THREE.MeshStandardMaterial({ color: 0x3b82f6 });
    const selectedWallMaterial = new THREE.MeshStandardMaterial({ color: 0x10b981, emissive: 0x10b981, emissiveIntensity: 0.2 });
    const holeMaterial = new THREE.MeshStandardMaterial({ color: 0xef4444, transparent: true, opacity: 0.8 });

    walls.forEach(wall => {
      const dx = wall.end.x - wall.start.x;
      const dz = wall.end.y - wall.start.y;
      const length = Math.sqrt(dx * dx + dz * dz);
      if (length < 0.1) return;

      const isSelected = wall.id === selectedWallId;
      const material = isSelected ? selectedWallMaterial : wallMaterial;

      const geometry = new THREE.BoxGeometry(length, WALL_HEIGHT, WALL_THICKNESS);
      const mesh = new THREE.Mesh(geometry, material);
      mesh.rotation.y = -Math.atan2(dz, dx);
      mesh.position.set((wall.start.x + wall.end.x) / 2, WALL_HEIGHT / 2, (wall.start.y + wall.end.y) / 2);
      wallsGroupRef.current?.add(mesh);

      const pillarGeom = new THREE.CylinderGeometry(WALL_THICKNESS / 2, WALL_THICKNESS / 2, WALL_HEIGHT, 16);
      [wall.start, wall.end].forEach(pos => {
        const pillar = new THREE.Mesh(pillarGeom, material);
        pillar.position.set(pos.x, WALL_HEIGHT / 2, pos.y);
        wallsGroupRef.current?.add(pillar);
      });
    });

    holes.forEach(hole => {
      const geometry = new THREE.CylinderGeometry(2.25, 2.25, 20, 32);
      const isSelected = hole.id === selectedHoleId;
      const material = isSelected 
        ? new THREE.MeshStandardMaterial({ color: 0xffff00, emissive: 0xffff00, emissiveIntensity: 0.5 }) 
        : holeMaterial;
      const mesh = new THREE.Mesh(geometry, material);
      mesh.position.set(hole.x, 0, hole.y);
      holesGroupRef.current?.add(mesh);
    });

    if (currentWall) {
      const dx = currentWall.end.x - currentWall.start.x;
      const dz = currentWall.end.y - currentWall.start.y;
      const length = Math.sqrt(dx * dx + dz * dz);
      if (length > 0.1) {
        const previewMat = new THREE.MeshStandardMaterial({ color: 0x3b82f6, transparent: true, opacity: 0.5 });
        const mesh = new THREE.Mesh(new THREE.BoxGeometry(length, WALL_HEIGHT, WALL_THICKNESS), previewMat);
        mesh.rotation.y = -Math.atan2(dz, dx);
        mesh.position.set((currentWall.start.x + currentWall.end.x) / 2, WALL_HEIGHT / 2, (currentWall.start.y + currentWall.end.y) / 2);
        wallsGroupRef.current?.add(mesh);
      }
    }
  }, [walls, holes, currentWall, selectedHoleId, selectedWallId]);

  // File Handlers
  const handleFileUpload = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (e) => {
      const loader = new STLLoader();
      const geometry = loader.parse(e.target?.result as ArrayBuffer);
      if (baseMesh) sceneRef.current?.remove(baseMesh);
      
      const mesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ color: 0xaaaaaa, flatShading: true }));
      geometry.computeBoundingBox();
      const center = new THREE.Vector3();
      geometry.boundingBox?.getCenter(center);
      mesh.position.sub(center);
      mesh.position.y = - (geometry.boundingBox?.min.y || 0);

      sceneRef.current?.add(mesh);
      setBaseMesh(mesh);
      
      const size = new THREE.Vector3();
      geometry.boundingBox?.getSize(size);
      const maxDim = Math.max(size.x, size.y, size.z);
      cameraRef.current?.position.set(maxDim * 1.5, maxDim * 1.5, maxDim * 1.5);
      controlsRef.current?.target.set(0, size.y / 2, 0);
    };
    reader.readAsArrayBuffer(file);
  };

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

  // Mouse Handlers
  const handleMouseDown = (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    const point = getMousePoint(e);
    if (!point) return;

    if (activeTool === 'draw') {
      setIsDrawing(true);
      setCurrentWall({ start: point, end: point });
      if (controlsRef.current) controlsRef.current.enabled = false;
    } else if (activeTool === 'hole') {
      saveToHistory();
      setHoles(prev => [...prev, { id: crypto.randomUUID(), x: point.x, y: point.y }]);
    }
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    const point = getMousePoint(e);
    if (isDrawing && currentWall && point) {
      setCurrentWall(prev => prev ? { ...prev, end: point } : null);
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

  const [isExporting, setIsExporting] = useState(false);

  // ROBUST EXPORT LOGIC
  const exportSTL = async () => {
    if (!sceneRef.current) return;
    setIsExporting(true);
    await new Promise(resolve => setTimeout(resolve, 100));

    const exporter = new STLExporter();
    const evaluator = new Evaluator();
    
    try {
      let baseToCut: THREE.Mesh;
      
      // 1. Prepare Base
      if (baseMesh) {
        baseToCut = baseMesh.clone();
        // Ensure geometry is indexed and cleaned for boolean math
        baseToCut.geometry = mergeVertices(baseToCut.geometry);
      } else {
        const floorGeom = new THREE.BoxGeometry(200, 2, 200);
        baseToCut = new THREE.Mesh(floorGeom, new THREE.MeshStandardMaterial());
      }
      baseToCut.updateMatrixWorld();

      // 2. Perform Hole Subtraction
      let finalBase = baseToCut;
      if (holes.length > 0) {
        console.log(`Processing ${holes.length} holes using BVH-CSG...`);
        for (const hole of holes) {
          // Create a cylinder long enough to definitely punch through
          const holeGeom = new THREE.CylinderGeometry(2.25, 2.25, 100, 32);
          const holeMesh = new THREE.Mesh(holeGeom);
          holeMesh.position.set(hole.x, 0, hole.y);
          holeMesh.updateMatrixWorld();
          
          // Use Evaluator for clean subtraction
          finalBase = evaluator.evaluate(finalBase, holeMesh, SUBTRACTION);
        }
      }

      // 3. Combine with Walls
      const exportGroup = new THREE.Group();
      exportGroup.add(finalBase);
      
      if (wallsGroupRef.current) {
        const wallsClone = wallsGroupRef.current.clone();
        exportGroup.add(wallsClone);
      }

      // 4. Export
      const result = exporter.parse(exportGroup, { binary: true });
      const blob = new Blob([result], { type: 'application/octet-stream' });
      const link = document.createElement('a');
      link.href = URL.createObjectURL(blob);
      link.download = 'maze_with_holes.stl';
      link.click();
      
    } catch (error) {
      console.error('Export error:', error);
      alert('Hole subtraction failed. This usually happens if the base STL is not "watertight". Exporting group without cuts instead.');
      const fallback = new THREE.Group();
      if (baseMesh) fallback.add(baseMesh.clone());
      if (wallsGroupRef.current) fallback.add(wallsGroupRef.current.clone());
      const result = exporter.parse(fallback, { binary: true });
      const blob = new Blob([result], { type: 'application/octet-stream' });
      const link = document.createElement('a');
      link.href = URL.createObjectURL(blob);
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
          <div className="p-2 bg-blue-600 rounded-lg">
            <Layers className="w-6 h-6 text-white" />
          </div>
          <div>
            <h1 className="text-xl font-semibold tracking-tight">Maze Architect</h1>
            <p className="text-[10px] text-neutral-400 font-bold uppercase tracking-widest">3D Print Generator</p>
          </div>
        </div>
        
        <div className="flex items-center gap-4">
          <div className="flex bg-neutral-100 p-1 rounded-xl border border-neutral-200">
            <button onClick={() => setActiveTool('select')} className={`px-4 py-2 rounded-lg text-sm font-semibold transition-all ${activeTool === 'select' ? 'bg-white shadow-sm text-blue-600' : 'text-neutral-500'}`}>Select</button>
            <button onClick={() => setActiveTool('draw')} className={`px-4 py-2 rounded-lg text-sm font-semibold transition-all ${activeTool === 'draw' ? 'bg-white shadow-sm text-blue-600' : 'text-neutral-500'}`}>Walls</button>
            <button onClick={() => setActiveTool('hole')} className={`px-4 py-2 rounded-lg text-sm font-semibold transition-all ${activeTool === 'hole' ? 'bg-white shadow-sm text-blue-600' : 'text-neutral-500'}`}>Hole</button>
          </div>

          <button onClick={undo} disabled={history.length === 0} className="flex items-center gap-2 px-4 py-2 rounded-xl border bg-white text-neutral-700 disabled:opacity-30">
            <Undo2 className="w-4 h-4" />
            <span className="text-sm font-semibold">Undo</span>
          </button>
          
          <button onClick={exportSTL} disabled={isExporting} className="flex items-center gap-2 px-6 py-2 bg-blue-600 text-white rounded-xl font-bold active:scale-95 disabled:bg-blue-300">
            <Download className="w-4 h-4" />
            <span>{isExporting ? 'Cutting Holes...' : 'Export STL'}</span>
          </button>
        </div>
      </header>

      <main className="flex flex-1 relative overflow-hidden">
        <aside className="w-72 bg-white border-r border-neutral-200 p-6 space-y-8 z-20">
          <section className="space-y-4">
            <h2 className="text-[10px] font-black text-neutral-400 uppercase tracking-widest">Base Model</h2>
            <div className="relative border-2 border-dashed border-neutral-200 rounded-2xl p-8 text-center bg-neutral-50/50">
              <input type="file" accept=".stl" onChange={handleFileUpload} className="absolute inset-0 opacity-0 cursor-pointer" />
              <Upload className="w-8 h-8 text-neutral-300 mx-auto mb-2" />
              <p className="text-xs font-bold text-neutral-500">{baseMesh ? 'Change Base' : 'Import STL'}</p>
            </div>
          </section>

          <section className="space-y-4">
            <h2 className="text-[10px] font-black text-neutral-400 uppercase tracking-widest">Wall Specs</h2>
            <div className="grid grid-cols-2 gap-3 text-center">
              <div className="p-3 bg-neutral-50 rounded-xl border">
                <p className="text-[9px] text-neutral-400 uppercase">Thickness</p>
                <p className="font-bold">{WALL_THICKNESS}mm</p>
              </div>
              <div className="p-3 bg-neutral-50 rounded-xl border">
                <p className="text-[9px] text-neutral-400 uppercase">Height</p>
                <p className="font-bold">{WALL_HEIGHT}mm</p>
              </div>
            </div>
          </section>
        </aside>

        <div className="flex-1 relative bg-[#f8f9fa]">
          <div 
            ref={containerRef} 
            className="absolute inset-0"
            onMouseDown={handleMouseDown}
            onMouseMove={handleMouseMove}
            onMouseUp={handleMouseUp}
          />
        </div>
      </main>
    </div>
  );
}
