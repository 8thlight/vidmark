"use client";

import { useEffect, useRef, useState } from "react";
import type { ConceptGraph } from "./concept-graph-types";

const domainColors: Record<string, number> = {
  architecture: 0xff654c,
  tools: 0x5d9ce6,
  code: 0x43b2a4,
  prompting: 0xe9aa31,
  context: 0xa98cdf,
};
const fallbackColors = [0xff654c, 0x5d9ce6, 0x43b2a4, 0xe9aa31, 0xa98cdf, 0xe66fa9, 0x79b85a];
const domainColor = (domainId: string) => domainColors[domainId] ?? fallbackColors[[...domainId].reduce((sum, character) => sum + character.charCodeAt(0), 0) % fallbackColors.length];

export function ConceptGraph3D({ graph }: { graph: ConceptGraph }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [selectedId, setSelectedId] = useState(() => graph.nodes.find((node) => node.kind === "concept")?.id ?? graph.nodes[0]?.id ?? "");
  const selected = (graph.nodes.find((node) => node.id === selectedId) ?? graph.nodes.find((node) => node.kind === "concept") ?? graph.nodes[0])!;
  const connections = graph.edges
    .filter((edge) => edge.type !== "contains" && (edge.source === selected.id || edge.target === selected.id))
    .sort((a, b) => b.weight - a.weight)
    .slice(0, 5)
    .map((edge) => ({
      ...edge,
      node: graph.nodes.find((node) => node.id === (edge.source === selected.id ? edge.target : edge.source)),
    }));

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let disposed = false;
    let frame = 0;
    let cleanup = () => {};

    void (async () => {
      const THREE = await import("three");
      const { OrbitControls } = await import("three/examples/jsm/controls/OrbitControls.js");
      if (disposed || !hostRef.current) return;

      const width = host.clientWidth;
      const height = host.clientHeight;
      const scene = new THREE.Scene();
      scene.background = new THREE.Color(0x071a31);
      scene.fog = new THREE.FogExp2(0x071a31, 0.006);
      const camera = new THREE.PerspectiveCamera(52, width / height, 0.1, 1500);
      camera.position.set(0, 30, 150);
      const renderer = new THREE.WebGLRenderer({ antialias: true });
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
      renderer.setSize(width, height);
      renderer.domElement.setAttribute("aria-label", "Traversable three-dimensional concept relationship graph");
      host.appendChild(renderer.domElement);

      scene.add(new THREE.AmbientLight(0xffffff, 1.4));
      const keyLight = new THREE.DirectionalLight(0xffffff, 2.2);
      keyLight.position.set(40, 80, 100);
      scene.add(keyLight);

      const controls = new OrbitControls(camera, renderer.domElement);
      controls.enableDamping = true;
      controls.minDistance = 55;
      controls.maxDistance = 280;

      const positions = new Map<string, InstanceType<typeof THREE.Vector3>>();
      const clickable: InstanceType<typeof THREE.Mesh>[] = [];
      const conceptNodes = graph.nodes.filter((node) => node.kind === "concept");
      const domains = [...new Set(conceptNodes.map((node) => node.domainId))];
      conceptNodes.forEach((node, index) => {
        const domainIndex = domains.indexOf(node.domainId);
        const groupItems = conceptNodes.filter((item) => item.domainId === node.domainId);
        const localIndex = groupItems.findIndex((item) => item.id === node.id);
        const domainAngle = (domainIndex / domains.length) * Math.PI * 2;
        const localAngle = (localIndex / groupItems.length) * Math.PI * 2;
        const centerRadius = 48;
        const position = new THREE.Vector3(
          Math.cos(domainAngle) * centerRadius + Math.cos(localAngle) * 24,
          Math.sin(localAngle * 1.7) * 25,
          Math.sin(domainAngle) * centerRadius + Math.sin(localAngle) * 24,
        );
        positions.set(node.id, position);
        const geometry = new THREE.SphereGeometry(2.5, 22, 18);
        const material = new THREE.MeshStandardMaterial({ color: domainColor(node.domainId), roughness: 0.36, metalness: 0.08 });
        const mesh = new THREE.Mesh(geometry, material);
        mesh.position.copy(position);
        mesh.userData.nodeId = node.id;
        mesh.userData.baseScale = 1;
        scene.add(mesh);
        clickable.push(mesh);

        if (index % 2 === 0 || node.id === "tool-contract-design") {
          const canvas = document.createElement("canvas");
          canvas.width = 384; canvas.height = 72;
          const context = canvas.getContext("2d");
          if (context) {
            context.font = "600 28px Arial";
            context.fillStyle = "white";
            context.textAlign = "center";
            context.fillText(node.label, 192, 42, 360);
          }
          const texture = new THREE.CanvasTexture(canvas);
          const label = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, transparent: true, depthWrite: false }));
          label.position.copy(position).add(new THREE.Vector3(0, 6, 0));
          label.scale.set(25, 4.7, 1);
          scene.add(label);
        }
      });

      const lineMaterial = new THREE.LineBasicMaterial({ color: 0x7894af, transparent: true, opacity: 0.32 });
      graph.edges.filter((edge) => edge.type !== "contains").forEach((edge) => {
        const source = positions.get(edge.source);
        const target = positions.get(edge.target);
        if (!source || !target) return;
        const geometry = new THREE.BufferGeometry().setFromPoints([source, target]);
        scene.add(new THREE.Line(geometry, lineMaterial));
      });

      const grid = new THREE.GridHelper(220, 22, 0x31506e, 0x18344f);
      grid.position.y = -34;
      scene.add(grid);

      const raycaster = new THREE.Raycaster();
      const pointer = new THREE.Vector2();
      const onPointer = (event: PointerEvent) => {
        const rect = renderer.domElement.getBoundingClientRect();
        pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
        pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
        raycaster.setFromCamera(pointer, camera);
        const hit = raycaster.intersectObjects(clickable)[0];
        if (hit?.object.userData.nodeId) setSelectedId(hit.object.userData.nodeId as string);
      };
      renderer.domElement.addEventListener("pointerdown", onPointer);

      const resizeObserver = new ResizeObserver(() => {
        if (!hostRef.current) return;
        const nextWidth = hostRef.current.clientWidth;
        const nextHeight = hostRef.current.clientHeight;
        camera.aspect = nextWidth / nextHeight;
        camera.updateProjectionMatrix();
        renderer.setSize(nextWidth, nextHeight);
      });
      resizeObserver.observe(host);

      const animate = () => {
        controls.update();
        renderer.render(scene, camera);
        frame = requestAnimationFrame(animate);
      };
      animate();

      cleanup = () => {
        cancelAnimationFrame(frame);
        resizeObserver.disconnect();
        renderer.domElement.removeEventListener("pointerdown", onPointer);
        controls.dispose();
        scene.traverse((object) => {
          if (object instanceof THREE.Mesh || object instanceof THREE.Line || object instanceof THREE.Sprite) {
            object.geometry?.dispose?.();
            const material = object.material as InstanceType<typeof THREE.Material> | InstanceType<typeof THREE.Material>[];
            (Array.isArray(material) ? material : [material]).forEach((item) => item?.dispose());
          }
        });
        renderer.dispose();
        renderer.domElement.remove();
      };
    })();

    return () => { disposed = true; cleanup(); };
  }, [graph]);

  return (
    <section className="concept-map-card">
      <header><div><span>{graph.nodes.filter((node) => node.kind === "concept").length} CONCEPTS · {graph.edges.filter((edge) => edge.type !== "contains").length} RELATIONSHIPS</span><h2>{graph.title ?? "Concept map"}</h2></div><div className="graph-hints"><span>↻ Orbit</span><span>＋ Zoom</span><span>⌖ Select</span></div></header>
      <div className="concept-map-layout">
        <div ref={hostRef} className="concept-canvas" />
        <aside className="concept-detail">
          <span>SELECTED CONCEPT</span>
          <h3>{selected.label}</h3>
          <p>{selected.summary}</p>
          <h4>Strongest connections</h4>
          <ul>{connections.map((connection) => <li key={`${connection.source}-${connection.target}-${connection.type}`}><button type="button" onClick={() => connection.node && setSelectedId(connection.node.id)}><i style={{ background: `#${domainColor(connection.node?.domainId ?? "default").toString(16).padStart(6, "0")}` }} />{connection.node?.label}</button><b>{Math.round(connection.weight * 100)}%</b></li>)}</ul>
          <small>Connections express learning relevance, not live-exam probability.</small>
        </aside>
      </div>
    </section>
  );
}
