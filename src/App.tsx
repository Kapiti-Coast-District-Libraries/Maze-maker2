import React, { useState, useRef, useEffect, useCallback } from 'react';
import * as THREE from 'three';
import { OrbitControls, GLTFLoader, STLExporter } from 'three-stdlib';
import { Brush, Evaluator, SUBTRACTION } from 'three-bvh-csg';
import { 
  Download, 
  Trash2, 
  MousePointer2, 
  PenTool,
  Box,
  Layers,
  Circle,
  Undo2,
  Info
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
      // Disable left-click rotation for drawing tools
      controlsRef.current.mouseButtons = {
        LEFT: null,
        MIDDLE: THREE.MOUSE.PAN,
        RIGHT: THREE.MOUSE.ROTATE
      };
    } else {
      // Restore default controls for select/view mode
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

    // Clean up any existing canvas
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

    // Lights
    const ambientLight = new THREE.AmbientLight(0xffffff, 0.8);
    scene.add(ambientLight);

    const dirLight = new THREE.DirectionalLight(0xffffff, 1.0);
    dirLight.position.set(100, 200, 100);
    dirLight.castShadow = true;
    scene.add(dirLight);

    // Grid
    const gridHelper = new THREE.GridHelper(400, 80, 0xcccccc, 0xeeeeee);
    scene.add(gridHelper);
    gridHelperRef.current = gridHelper;

    // Drawing Plane
    const planeGeom = new THREE.PlaneGeometry(2000, 2000);
    const planeMat = new THREE.MeshBasicMaterial({ visible: false });
    const drawingPlane = new THREE.Mesh(planeGeom, planeMat);
    drawingPlane.rotation.x = -Math.PI / 2;
    scene.add(drawingPlane);
    drawingPlaneRef.current = drawingPlane;

    // Walls Group
    const wallsGroup = new THREE.Group();
    scene.add(wallsGroup);
    wallsGroupRef.current = wallsGroup;

    // Holes Group
    const holesGroup = new THREE.Group();
    scene.add(holesGroup);
    holesGroupRef.current = holesGroup;

    // Load default GLB file instead of STL
    const loader = new GLTFLoader();
    const glbUrl = `${import.meta.env.BASE_URL}base.glb`;
    
    loader.load(glbUrl, (gltf) => {
      // Find the first mesh in the GLTF scene
      let loadedMesh: THREE.Mesh | null = null;
      gltf.scene.traverse((child) => {
        if ((child as THREE.Mesh).isMesh && !loadedMesh) {
          loadedMesh = child as THREE.Mesh;
        }
      });

      if (loadedMesh) {
        const geometry = loadedMesh.geometry.clone();
        const material = new THREE.MeshStandardMaterial({ color: 0xaaaaaa, flatShading: true });
        const mesh = new THREE.Mesh(geometry, material);
        
        // Center the mesh
        geometry.computeBoundingBox();
        const center = new THREE.Vector3();
        geometry.boundingBox?.getCenter(center);
        mesh.position.sub(center);
        
        // Ensure it sits on the ground
        mesh.position.y = - (geometry.boundingBox?.min.y || 0);

        scene.add(mesh);
        setBaseMesh(mesh);
        
        // Adjust camera to fit
        const size = new THREE.Vector3();
        geometry.boundingBox?.getSize(size);
        const maxDim = Math.max(size.x, size.y, size.z);
        camera.position.set(maxDim * 1.5, maxDim * 1.5, maxDim * 1.5);
        controls.target.set(0, size.y / 2, 0);
        controls.update();
      }
    }, undefined, (error) => {
      console.error('Error loading base.glb:', error);
      alert("Please ensure you have placed a 'base.glb' file in your public folder!");
    });

    // Animation Loop
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

    // Resize Observer
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
      if (rendererRef.current) {
        rendererRef.current.dispose();
      }
      if (container.contains(renderer.domElement)) {
        container.removeChild(renderer.domElement);
      }
    };
  }, []);

  // Update Walls and Holes in Scene
  useEffect(() => {
    if (!wallsGroupRef.current || !holesGroupRef.current) return;
    
    // Clear existing walls
    while(wallsGroupRef.current.children.length > 0){ 
      const child = wallsGroupRef.current.children[0] as THREE.Mesh;
      child.geometry.dispose();
      (child.material as THREE.Material).dispose();
      wallsGroupRef.current.remove(child); 
    }

    // Clear existing holes
    while(holesGroupRef.current.children.length > 0){ 
      const child = holesGroupRef.current.children[0] as THREE.Mesh;
      child.geometry.dispose();
      (child.material as THREE.Material).dispose();
      holesGroupRef.current.remove(child); 
    }

    const wallMaterial = new THREE.MeshStandardMaterial({ color: 0x3b82f6 });
    const selectedWallMaterial = new THREE.MeshStandardMaterial({ color: 0x10b981, emissive: 0x10b981, emissiveIntensity: 0.2 });
    const holeMaterial = new THREE.MeshStandardMaterial({ color: 0xef4444, transparent: true, opacity: 0.8 });

    walls.forEach(wall => {
      const dx = wall.end.x - wall.start.x;
      const dz = wall.end.y - wall.start.y;
      const length = Math.sqrt(dx * dx + dz * dz);
      if (length < 0.1) return;

      const isSelected = wall.id === selectedWallId;
      const isHovered = wall.id === hoveredId;
      const material = isSelected ? selectedWallMaterial : (isHovered ? new THREE.MeshStandardMaterial({ color: 0x60a5fa }) : wallMaterial);

      // Wall segment
      const geometry = new THREE.BoxGeometry(length, WALL_HEIGHT, WALL_THICKNESS);
      const mesh = new THREE.Mesh(geometry, material);
      const angle = Math.atan2(dz, dx);
      mesh.rotation.y = -angle;
      mesh.position.set(
        (wall.start.x + wall.end.x) / 2,
        WALL_HEIGHT / 2,
        (wall.start.y + wall.end.y) / 2
      );
      wallsGroupRef.current?.add(mesh);

      // Corner pillars (joints)
      const pillarGeom = new THREE.CylinderGeometry(WALL_THICKNESS / 2, WALL_THICKNESS / 2, WALL_HEIGHT, 16);
      
      const startPillar = new THREE.Mesh(pillarGeom, material);
      startPillar.position.set(wall.start.x, WALL_HEIGHT / 2, wall.start.y);
      wallsGroupRef.current?.add(startPillar);

      const endPillar = new THREE.Mesh(pillarGeom, material);
      endPillar.position.set(wall.end.x, WALL_HEIGHT / 2, wall.end.y);
      wallsGroupRef.current?.add(endPillar);
    });

    holes.forEach(hole => {
      const geometry = new THREE.CylinderGeometry(2.25, 2.25, 20, 32);
      const isSelected = hole.id === selectedHoleId;
      const isHovered = hole.id === hoveredId;
      const material = isSelected 
        ? new THREE.MeshStandardMaterial({ color: 0xffff00, emissive: 0xffff00, emissiveIntensity: 0.5 }) 
        : (isHovered ? new THREE.MeshStandardMaterial({ color: 0xfca5a5 }) : holeMaterial);
      const mesh = new THREE.Mesh(geometry, material);
      mesh.position.set(hole.x, 0, hole.y);
      holesGroupRef.current?.add(mesh);
    });

    // Add current wall being drawn
    if (currentWall) {
      const dx = currentWall.end.x - currentWall.start.x;
      const dz = currentWall.end.y - currentWall.start.y;
      const length = Math.sqrt(dx * dx + dz * dz);
      if (length > 0.1) {
        const previewMat = new THREE.MeshStandardMaterial({ color: 0x3b82f6, transparent: true, opacity: 0.5 });
        
        // Preview segment
        const geometry = new THREE.BoxGeometry(length, WALL_HEIGHT, WALL_THICKNESS);
        const mesh = new THREE.Mesh(geometry, previewMat);
        const angle = Math.atan2(dz, dx);
        mesh.rotation.y = -angle;
        mesh.position.set(
          (currentWall.start.x + currentWall.end.x) / 2,
          WALL_HEIGHT / 2,
          (currentWall.start.y + currentWall.end.y) / 2
        );
        wallsGroupRef.current?.add(mesh);

        // Preview pillars
        const pillarGeom = new THREE.CylinderGeometry(WALL_THICKNESS / 2, WALL_THICKNESS / 2, WALL_HEIGHT, 16);
        const startPillar = new THREE.Mesh(pillarGeom, previewMat);
        startPillar.position.set(currentWall.start.x, WALL_HEIGHT / 2, currentWall.start.y);
        wallsGroupRef.current?.add(startPillar);
        const endPillar = new THREE.Mesh(pillarGeom, previewMat);
        endPillar.position.set(currentWall.end.x, WALL_HEIGHT / 2, currentWall.end.y);
        wallsGroupRef.current?.add(endPillar);
      }
    }
  }, [walls, holes, currentWall, selectedHoleId, selectedWallId, hoveredId]);

  // Drawing Logic
  const getMousePoint = useCallback((e: React.MouseEvent | MouseEvent) => {
    if (!containerRef.current || !cameraRef.current || !drawingPlaneRef.current) return null;
    
    const rect = containerRef.current.getBoundingClientRect();
    mouseRef.current.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    mouseRef.current.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;

    raycasterRef.current.setFromCamera(mouseRef.current, cameraRef.current);
    const intersects = raycasterRef.current.intersectObject(drawingPlaneRef.current);
    
    if (intersects.length > 0) {
      const rawPoint = { x: intersects[0].point.x, y: intersects[0].point.z };
      
      // Check if raw point is inside
      if (baseMesh) {
        const checkRaycaster = new THREE.Raycaster();
        checkRaycaster.set(new THREE.Vector3(rawPoint.x, 1000, rawPoint.y), new THREE.Vector3(0, -1, 0));
        const meshIntersects = checkRaycaster.intersectObject(baseMesh);
        if (meshIntersects.length === 0) return null;
      }

      if (snapToGrid) {
        const snappedX = Math.round(rawPoint.x / GRID_SIZE) * GRID_SIZE;
        const snappedY = Math.round(rawPoint.y / GRID_SIZE) * GRID_SIZE;
        
        // Check if snapped point is inside
        if (baseMesh) {
          const checkRaycaster = new THREE.Raycaster();
          checkRaycaster.set(new THREE.Vector3(snappedX, 1000, snappedY), new THREE.Vector3(0, -1, 0));
          const meshIntersects = checkRaycaster.intersectObject(baseMesh);
          if (meshIntersects.length > 0) {
            return { x: snappedX, y: snappedY };
          }
        } else {
          return { x: snappedX, y: snappedY };
        }
      }
      
      return rawPoint;
    }
    return null;
  }, [snapToGrid, baseMesh]);

  const getDistanceToWall = (p: { x: number, y: number }, wall: Wall) => {
    const { start, end } = wall;
    const l2 = (start.x - end.x) ** 2 + (start.y - end.y) ** 2;
    if (l2 === 0) return Math.sqrt((p.x - start.x) ** 2 + (p.y - start.y) ** 2);
    let t = ((p.x - start.x) * (end.x - start.x) + (p.y - start.y) * (end.y - start.y)) / l2;
    t = Math.max(0, Math.min(1, t));
    return Math.sqrt((p.x - (start.x + t * (end.x - start.x))) ** 2 + (p.y - (start.y + t * (end.y - start.y))) ** 2);
  };

  const handleMouseDown = (e: React.MouseEvent) => {
    if (e.button !== 0) return; // Only left click
    const point = getMousePoint(e);
    if (!point) return;

    if (activeTool === 'draw') {
      setIsDrawing(true);
      setCurrentWall({ start: point, end: point });
      if (controlsRef.current) controlsRef.current.enabled = false;
    } else if (activeTool === 'hole') {
      saveToHistory();
      setHoles(prev => [...prev, { id: crypto.randomUUID(), x: point.x, y: point.y }]);
    } else if (activeTool === 'select') {
      // Check if clicked on a hole
      const clickedHole = holes.find(h => {
        const d = Math.sqrt((h.x - point.x) ** 2 + (h.y - point.y) ** 2);
        return d < 8; // Increased from 5mm to 8mm radius for easier selection
      });
      
      if (clickedHole) {
        saveToHistory();
        setSelectedHoleId(clickedHole.id);
        setDragStartPoint(point);
        if (controlsRef.current) controlsRef.current.enabled = false;
        return;
      }

      // Check if clicked on a wall
      const clickedWall = walls.find(w => getDistanceToWall(point, w) < 5); // Increased from 3mm to 5mm
      if (clickedWall) {
        saveToHistory();
        setSelectedWallId(clickedWall.id);
        setDragStartPoint(point);
        if (controlsRef.current) controlsRef.current.enabled = false;
      }
    }
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    const point = getMousePoint(e);
    if (!point) {
      setHoveredId(null);
      return;
    }

    if (isDrawing && currentWall) {
      setCurrentWall(prev => prev ? { ...prev, end: point } : null);
    } else if (selectedHoleId && dragStartPoint) {
      setHoles(prev => prev.map(h => h.id === selectedHoleId ? { ...h, x: point.x, y: point.y } : h));
    } else if (selectedWallId && dragStartPoint) {
      const dx = point.x - dragStartPoint.x;
      const dy = point.y - dragStartPoint.y;
      
      setWalls(prev => prev.map(w => {
        if (w.id === selectedWallId) {
          // Check if new position is valid (both ends inside)
          const newStart = { x: w.start.x + dx, y: w.start.y + dy };
          const newEnd = { x: w.end.x + dx, y: w.end.y + dy };
          
          if (baseMesh) {
            const checkRaycaster = new THREE.Raycaster();
            
            checkRaycaster.set(new THREE.Vector3(newStart.x, 1000, newStart.y), new THREE.Vector3(0, -1, 0));
            const startIntersects = checkRaycaster.intersectObject(baseMesh);
            
            checkRaycaster.set(new THREE.Vector3(newEnd.x, 1000, newEnd.y), new THREE.Vector3(0, -1, 0));
            const endIntersects = checkRaycaster.intersectObject(baseMesh);
            
            if (startIntersects.length === 0 || endIntersects.length === 0) {
              return w; // Don't move if it goes outside
            }
          }
          
          return { ...w, start: newStart, end: newEnd };
        }
        return w;
      }));
      setDragStartPoint(point);
    } else if (activeTool === 'select') {
      // Hover detection
      const hoveredHole = holes.find(h => Math.sqrt((h.x - point.x) ** 2 + (h.y - point.y) ** 2) < 8);
      if (hoveredHole) {
        setHoveredId(hoveredHole.id);
        return;
      }
      const hoveredWall = walls.find(w => getDistanceToWall(point, w) < 5);
      if (hoveredWall) {
        setHoveredId(hoveredWall.id);
        return;
      }
      setHoveredId(null);
    }
  };

  const handleMouseUp = () => {
    if (isDrawing && currentWall) {
      const dx = currentWall.end.x - currentWall.start.x;
      const dy = currentWall.end.y - currentWall.start.y;
      const length = Math.sqrt(dx * dx + dy * dy);
      
      if (length > 0.5) {
        saveToHistory();
        setWalls(prev => [...prev, { id: crypto.randomUUID(), ...currentWall }]);
      }
      
      setIsDrawing(false);
      setCurrentWall(null);
    }

    setSelectedHoleId(null);
    setSelectedWallId(null);
    setDragStartPoint(null);

    if (controlsRef.current) controlsRef.current.enabled = true;
  };

  const clearWalls = () => {
    saveToHistory();
    setWalls([]);
    setHoles([]);
    setShowClearConfirm(false);
  };

  const deleteSelected = () => {
    if (selectedHoleId) {
      saveToHistory();
      setHoles(prev => prev.filter(h => h.id !== selectedHoleId));
      setSelectedHoleId(null);
    } else if (selectedWallId) {
      saveToHistory();
      setWalls(prev => prev.filter(w => w.id !== selectedWallId));
      setSelectedWallId(null);
    }
    if (controlsRef.current) controlsRef.current.enabled = true;
  };

  // Keyboard Listeners
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.key === 'Delete' || e.key === 'Backspace') && (selectedHoleId || selectedWallId)) {
        deleteSelected();
      }
      if ((e.ctrlKey || e.metaKey) && e.key === 'z') {
        e.preventDefault();
        undo();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [selectedHoleId, selectedWallId, history]);

  const [isExporting, setIsExporting] = useState(false);

  const exportSTL = async () => {
    if (!sceneRef.current) return;
    setIsExporting(true);
    
    await new Promise(resolve => setTimeout(resolve, 100));

    const exporter = new STLExporter();
    const exportGroup = new THREE.Group();

    try {
      console.log('Starting Mold & Cast CSG Export...');
      let currentBrush: Brush | null = null;
      const evaluator = new Evaluator();
      evaluator.useGroups = false;
      
      if (baseMesh) {
        console.log('Step 1: Reading original base shape...');
        const originalGeom = baseMesh.geometry.clone();
        
        // Strip UVs in case the GLTF had them, so it perfectly matches our BoxGeometry
        originalGeom.deleteAttribute('uv'); 
        originalGeom.computeVertexNormals();
        
        const originalBrush = new Brush(originalGeom, new THREE.MeshStandardMaterial());
        originalBrush.position.copy(baseMesh.position);
        originalBrush.rotation.copy(baseMesh.rotation);
        originalBrush.scale.copy(baseMesh.scale);
        originalBrush.updateMatrixWorld();

        console.log('Step 2: Creating the Mould...');
        const box3 = new THREE.Box3().setFromObject(baseMesh);
        const size = new THREE.Vector3();
        box3.getSize(size);
        const center = new THREE.Vector3();
        box3.getCenter(center);

        // Natively indexed BoxGeometry
        const moldGeom = new THREE.BoxGeometry(size.x + 2, size.y + 2, size.z + 2);
        moldGeom.deleteAttribute('uv');
        
        const moldBlock1 = new Brush(moldGeom, new THREE.MeshStandardMaterial());
        moldBlock1.position.copy(center);
        moldBlock1.updateMatrixWorld();

        const moldBlock2 = new Brush(moldGeom.clone(), new THREE.MeshStandardMaterial());
        moldBlock2.position.copy(center);
        moldBlock2.updateMatrixWorld();

        // Create the negative mold (Block - Original)
        const negativeMold = evaluator.evaluate(moldBlock1, originalBrush, SUBTRACTION);
        negativeMold.updateMatrixWorld();

        console.log('Step 3: Casting a completely new replacement part...');
        currentBrush = evaluator.evaluate(moldBlock2, negativeMold, SUBTRACTION);
        currentBrush.updateMatrixWorld();
        
      } else if (holes.length > 0 || walls.length > 0) {
        // Fallback Floor
        let minX = -50, maxX = 50, minZ = -50, maxZ = 50;
        walls.forEach(w => {
          minX = Math.min(minX, w.start.x, w.end.x); maxX = Math.max(maxX, w.start.x, w.end.x);
          minZ = Math.min(minZ, w.start.y, w.end.y); maxZ = Math.max(maxZ, w.start.y, w.end.y);
        });
        holes.forEach(h => {
          minX = Math.min(minX, h.x - 10); maxX = Math.max(maxX, h.x + 10);
          minZ = Math.min(minZ, h.y - 10); maxZ = Math.max(maxZ, h.y + 10);
        });

        const floorGeom = new THREE.BoxGeometry((maxX - minX) + 20, 2, (maxZ - minZ) + 20);
        floorGeom.deleteAttribute('uv');
        
        currentBrush = new Brush(floorGeom, new THREE.MeshStandardMaterial());
        currentBrush.position.set((minX + maxX) / 2, 1, (minZ + maxZ) / 2);
        currentBrush.updateMatrixWorld();
      }

      // 4. Subtract Holes
      if (currentBrush && holes.length > 0) {
        console.log('Step 4: Drilling holes into the new pristine part...');
        for (const hole of holes) {
          const holeGeom = new THREE.CylinderGeometry(2.25, 2.25, 200, 32);
          holeGeom.deleteAttribute('uv');
          
          const holeBrush = new Brush(holeGeom, new THREE.MeshStandardMaterial());
          holeBrush.position.set(hole.x, 0, hole.y);
          holeBrush.updateMatrixWorld();
          
          currentBrush = evaluator.evaluate(currentBrush, holeBrush, SUBTRACTION);
          currentBrush.updateMatrixWorld();
        }
      }

      // 5. Prep the final cut object for export
      if (currentBrush) {
        // We convert to nonIndexed at the very end just for the STLExporter
        const finalGeom = currentBrush.geometry.toNonIndexed();
        finalGeom.clearGroups();
        finalGeom.computeVertexNormals();
        
        const finalMesh = new THREE.Mesh(finalGeom, new THREE.MeshStandardMaterial());
        exportGroup.add(finalMesh);
      }
      
      // 6. Add the walls
      if (wallsGroupRef.current) {
        exportGroup.add(wallsGroupRef.current.clone());
      }
      
      exportGroup.updateMatrixWorld(true);
      const result = exporter.parse(exportGroup, { binary: true });
      const blob = new Blob([result], { type: 'application/octet-stream' });
      
      const link = document.createElement('a');
      link.href = URL.createObjectURL(blob);
      link.download = 'maze_with_perfect_features.stl';
      link.click();
      
    } catch (error) {
      console.error('CSG Export Error:', error);
      alert('Error during export check console.');
    } finally {
      setIsExporting(false);
    }
  };

  return (
    <div className="flex flex-col h-screen bg-white font-sans text-neutral-900 overflow-hidden">
      {/* Header */}
      <header className="flex items-center justify-between px-6 py-4 border-b border-neutral-200 z-20 bg-white">
        <div className="flex items-center gap-3">
          <div className="p-2 bg-blue-600 rounded-lg">
            <Layers className="w-6 h-6 text-white" />
          </div>
          <div>
            <h1 className="text-xl font-semibold tracking-tight">Maze Architect</h1>
            <p className="text-[10px] text-neutral-400 font-bold uppercase tracking-widest">3D Print Generator • <span className="text-green-500">Active</span></p>
          </div>
        </div>
        
        <div className="flex items-center gap-4">
          <div className="flex bg-neutral-100 p-1 rounded-xl border border-neutral-200">
            <button 
              onClick={() => setActiveTool('select')}
              className={`flex items-center gap-2 px-4 py-2 rounded-lg transition-all ${activeTool === 'select' ? 'bg-white shadow-sm text-blue-600' : 'text-neutral-500 hover:text-neutral-700'}`}
            >
              <MousePointer2 className="w-4 h-4" />
              <span className="text-sm font-semibold">Select</span>
            </button>
            <button 
              onClick={() => {
                setActiveTool('draw');
                if (cameraRef.current && controlsRef.current) {
                  cameraRef.current.position.set(0, 150, 0);
                  controlsRef.current.target.set(0, 0, 0);
                  controlsRef.current.update();
                }
              }}
              className={`flex items-center gap-2 px-4 py-2 rounded-lg transition-all ${activeTool === 'draw' ? 'bg-white shadow-sm text-blue-600' : 'text-neutral-500 hover:text-neutral-700'}`}
            >
              <PenTool className="w-4 h-4" />
              <span className="text-sm font-semibold">Walls</span>
            </button>
            <button 
              onClick={() => {
                setActiveTool('hole');
                if (cameraRef.current && controlsRef.current) {
                  cameraRef.current.position.set(0, 150, 0);
                  controlsRef.current.target.set(0, 0, 0);
                  controlsRef.current.update();
                }
              }}
              className={`flex items-center gap-2 px-4 py-2 rounded-lg transition-all ${activeTool === 'hole' ? 'bg-white shadow-sm text-blue-600' : 'text-neutral-500 hover:text-neutral-700'}`}
            >
              <Circle className="w-4 h-4" />
              <span className="text-sm font-semibold">Hole</span>
            </button>
          </div>

          <button 
            onClick={undo}
            disabled={history.length === 0}
            className={`flex items-center gap-2 px-4 py-2 rounded-xl transition-all border ${history.length > 0 ? 'bg-white border-neutral-200 text-neutral-700 hover:bg-neutral-50 shadow-sm' : 'bg-neutral-50 border-neutral-100 text-neutral-300 cursor-not-allowed'}`}
            title="Undo (Ctrl+Z)"
          >
            <Undo2 className="w-4 h-4" />
            <span className="text-sm font-semibold">Undo</span>
          </button>
          
          <button 
            onClick={exportSTL}
            disabled={isExporting}
            className="flex items-center gap-2 px-6 py-2 bg-blue-600 hover:bg-blue-700 disabled:bg-blue-400 text-white rounded-xl font-bold transition-all shadow-md active:scale-95"
          >
            {isExporting ? (
              <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
            ) : (
              <Download className="w-4 h-4" />
            )}
            <span>{isExporting ? 'Processing...' : 'Export STL'}</span>
          </button>
        </div>
      </header>

      <main className="flex flex-1 relative overflow-hidden">
        {/* Sidebar */}
        <aside className="w-72 bg-white border-r border-neutral-200 flex flex-col z-20 shadow-xl">
          <div className="p-6 space-y-8 overflow-y-auto">
            {/* Wall Settings */}
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

            {/* Editor Settings */}
            <section className="space-y-4">
              <h2 className="text-[10px] font-black text-neutral-400 uppercase tracking-widest">Editor</h2>
              
              {activeTool === 'select' && (
                <div className="p-4 bg-blue-50 border border-blue-100 rounded-2xl flex gap-3 animate-in fade-in slide-in-from-top-2 duration-300">
                  <Info className="w-4 h-4 text-blue-500 shrink-0 mt-0.5" />
                  <p className="text-[11px] leading-relaxed text-blue-700 font-medium">
                    <strong className="block mb-0.5">Select Mode</strong>
                    Click and drag walls or holes to move them. Use Delete/Backspace to remove selected items.
                  </p>
                </div>
              )}

              <div className="space-y-2">
                <label className="flex items-center justify-between p-4 bg-neutral-50 rounded-2xl border border-neutral-100 cursor-pointer hover:bg-neutral-100 transition-all">
                  <span className="text-xs font-bold text-neutral-600">Snap to Grid</span>
                  <input 
                    type="checkbox" 
                    checked={snapToGrid} 
                    onChange={(e) => setSnapToGrid(e.target.checked)}
                    className="w-4 h-4 text-blue-600 rounded-full focus:ring-blue-500"
                  />
                </label>
                <label className="flex items-center justify-between p-4 bg-neutral-50 rounded-2xl border border-neutral-100 cursor-pointer hover:bg-neutral-100 transition-all">
                  <span className="text-xs font-bold text-neutral-600">Show Grid</span>
                  <input 
                    type="checkbox" 
                    checked={gridVisible} 
                    onChange={(e) => {
                      setGridVisible(e.target.checked);
                      if (gridHelperRef.current) gridHelperRef.current.visible = e.target.checked;
                    }}
                    className="w-4 h-4 text-blue-600 rounded-full focus:ring-blue-500"
                  />
                </label>
              </div>
              
              {showClearConfirm ? (
                <div className="flex gap-2">
                  <button 
                    onClick={clearWalls}
                    className="flex-1 p-4 bg-red-600 text-white rounded-2xl font-bold text-xs active:scale-95 transition-transform"
                  >
                    Confirm Clear
                  </button>
                  <button 
                    onClick={() => setShowClearConfirm(false)}
                    className="p-4 bg-neutral-200 text-neutral-600 rounded-2xl font-bold text-xs active:scale-95 transition-transform"
                  >
                    Cancel
                  </button>
                </div>
              ) : (
                <button 
                  onClick={() => setShowClearConfirm(true)}
                  className="w-full flex items-center justify-center gap-2 p-4 bg-red-50 hover:bg-red-100 text-red-600 rounded-2xl border border-red-100 transition-all font-bold text-xs active:scale-95"
                >
                  <Trash2 className="w-4 h-4" />
                  <span>Clear All</span>
                </button>
              )}
            </section>

            {/* Stats */}
            <section className="pt-6 border-t border-neutral-100">
              <div className="flex flex-col gap-2">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <PenTool className="w-3 h-3 text-neutral-400" />
                    <span className="text-xs font-bold text-neutral-400">Walls: <span className="text-neutral-900">{walls.length}</span></span>
                  </div>
                  <div className="flex items-center gap-2">
                    <Circle className="w-3 h-3 text-neutral-400" />
                    <span className="text-xs font-bold text-neutral-400">Holes: <span className="text-neutral-900">{holes.length}</span></span>
                  </div>
                </div>
                
                { (selectedHoleId || selectedWallId) && (
                  <button 
                    onClick={deleteSelected}
                    className="w-full flex items-center justify-center gap-2 p-3 bg-red-50 text-red-600 rounded-xl border border-red-100 font-bold text-xs hover:bg-red-100 transition-all mt-2 active:scale-95"
                  >
                    <Trash2 className="w-4 h-4" />
                    Delete Selected {selectedHoleId ? 'Hole' : 'Wall'}
                  </button>
                )}
              </div>
            </section>
          </div>
        </aside>

        {/* 3D Viewport */}
        <div className="flex-1 relative bg-[#f8f9fa] border-2 border-red-500 overflow-hidden">
          <div 
            ref={containerRef} 
            className="absolute inset-0"
            style={{ cursor: hoveredId ? 'pointer' : (activeTool === 'draw' ? 'crosshair' : (activeTool === 'select' ? 'default' : 'grab')) }}
            onMouseDown={handleMouseDown}
            onMouseMove={handleMouseMove}
            onMouseUp={handleMouseUp}
            onMouseLeave={handleMouseUp}
          />
          
          {/* Debug Overlay */}
          <div className="absolute top-4 right-4 bg-black/80 text-white p-2 rounded text-xs font-mono z-50 pointer-events-none">
            Viewport: {debugInfo.width}x{debugInfo.height} {debugInfo.ready ? '(Ready)' : '(Wait)'} | F: {debugInfo.frames} | T: {new Date().toLocaleTimeString()}
          </div>
          {/* View Controls */}
          <div className="absolute top-6 right-6 flex flex-col gap-2 z-10">
             <div className="bg-white/80 backdrop-blur-md p-2 rounded-2xl border border-neutral-200 shadow-xl flex flex-col gap-1">
                <button 
                  onClick={() => {
                    if (cameraRef.current && controlsRef.current) {
                      cameraRef.current.position.set(0, 150, 0);
                      controlsRef.current.target.set(0, 0, 0);
                      controlsRef.current.update();
                    }
                  }}
                  className="p-3 hover:bg-blue-50 hover:text-blue-600 rounded-xl text-neutral-500 transition-all"
                  title="Top View"
                >
                  <Layers className="w-5 h-5" />
                </button>
                <button 
                  onClick={() => {
                    if (cameraRef.current && controlsRef.current) {
                      cameraRef.current.position.set(100, 100, 100);
                      controlsRef.current.target.set(0, 0, 0);
                      controlsRef.current.update();
                    }
                  }}
                  className="p-3 hover:bg-blue-50 hover:text-blue-600 rounded-xl text-neutral-500 transition-all"
                  title="Perspective View"
                >
                  <Box className="w-5 h-5" />
                </button>
             </div>
          </div>

          {/* Active Tool Label */}
          <AnimatePresence>
            {(activeTool === 'draw' || activeTool === 'hole') && (
              <motion.div 
                initial={{ opacity: 0, scale: 0.9, y: 20 }}
                animate={{ opacity: 1, scale: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.9, y: 20 }}
                className="absolute bottom-10 left-1/2 -translate-x-1/2 bg-blue-600 text-white px-8 py-4 rounded-2xl shadow-2xl flex items-center gap-4 pointer-events-none z-10"
              >
                {activeTool === 'draw' ? <PenTool className="w-5 h-5" /> : <Circle className="w-5 h-5" />}
                <span className="text-sm font-black uppercase tracking-widest">
                  {activeTool === 'draw' ? 'Wall Drawing Active' : 'Hole Placement Active'}
                </span>
                <div className="w-2 h-2 bg-white rounded-full animate-pulse" />
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </main>
    </div>
  );
}
