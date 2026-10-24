"use client";

// The 3D paper scene (three.js, timed with GSAP): sheets that curl, fold,
// snap together, split, turn, flip and take a seal. The home hero cycles
// through the actions; a tool page loops its own while files are worked on.
// Loaded only where wants3d() allows (src/lib/paper.ts); PaperStage shows
// the 2D version until then and in its place elsewhere.

import { useEffect, useRef } from "react";
import * as THREE from "three";
import { gsap } from "gsap";
import { onThemeChange, paperColors, type PaperAction, type PaperColors, type PaperMode } from "@/lib/paper";

const W = 0.86;
const H = 1.12;

type State = { x: number; y: number; z: number; rx: number; ry: number; rz: number; s: number; curl: number; fold: number; o: number };
const REST: State = { x: 0, y: 0, z: 0, rx: 0, ry: 0, rz: 0, s: 1, curl: 0, fold: 0, o: 1 };
const HIDDEN: State = { ...REST, o: 0, s: 0.9 };

// A page drawn on a canvas: title bar, text lines, a picture block and the
// folded corner. "table" is the converted look; ink (0-1) is how much of the
// text is written, for the write action.
function drawPage(ctx: CanvasRenderingContext2D, c: PaperColors, variant: "page" | "table", ink = 1) {
  const w = ctx.canvas.width;
  const h = ctx.canvas.height;
  ctx.fillStyle = c.surface;
  ctx.fillRect(0, 0, w, h);
  const pad = w * 0.11;
  ctx.fillStyle = c.ink;
  ctx.globalAlpha = 0.85;
  ctx.fillRect(pad, pad, w * 0.42, h * 0.045);
  ctx.globalAlpha = 1;
  ctx.fillStyle = c.line;
  if (variant === "table") {
    for (let r = 0; r < 9; r++) for (let col = 0; col < 3; col++) {
      ctx.globalAlpha = r === 0 ? 0.9 : 0.55;
      ctx.fillRect(pad + col * (w - pad * 2) / 3 + 4, h * 0.16 + r * h * 0.075, (w - pad * 2) / 3 - 8, h * 0.035);
    }
  } else {
    const lines = [0.96, 0.9, 0.94, 0.7, 0, 0, 0, 0.92, 0.85, 0.6];
    const shown = Math.round(lines.length * ink);
    lines.forEach((len, i) => {
      if (!len || i >= shown) return;
      ctx.globalAlpha = 0.6;
      ctx.fillRect(pad, h * 0.17 + i * h * 0.062, (w - pad * 2) * len, h * 0.022);
    });
    ctx.globalAlpha = 1;
    ctx.fillStyle = c.surface2;
    ctx.fillRect(pad, h * 0.42, w - pad * 2, h * 0.2);
  }
  ctx.globalAlpha = 1;
  // The folded corner, as on the logo.
  const k = w * 0.2;
  ctx.fillStyle = c.accent;
  ctx.beginPath();
  ctx.moveTo(w - k, 0);
  ctx.lineTo(w, k);
  ctx.lineTo(w - k, k);
  ctx.fill();
  ctx.fillStyle = c.bg;
  ctx.beginPath();
  ctx.moveTo(w - k, 0);
  ctx.lineTo(w, 0);
  ctx.lineTo(w, k);
  ctx.fill();
}

class Sheet {
  mesh: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshStandardMaterial>;
  st: State = { ...HIDDEN };
  canvas = document.createElement("canvas");
  ctx = this.canvas.getContext("2d")!;
  tex: THREE.CanvasTexture;
  base: Float32Array;
  variant: "page" | "table" = "page";
  ink = 1;
  drawn = "";
  constructor(segments: number) {
    this.canvas.width = 256;
    this.canvas.height = 334;
    this.tex = new THREE.CanvasTexture(this.canvas);
    this.tex.colorSpace = THREE.SRGBColorSpace;
    this.tex.anisotropy = 4;
    const geo = new THREE.PlaneGeometry(W, H, segments, Math.round(segments * 1.3));
    this.base = Float32Array.from(geo.attributes.position.array);
    const mat = new THREE.MeshStandardMaterial({ map: this.tex, side: THREE.DoubleSide, roughness: 0.92, metalness: 0, transparent: true });
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.castShadow = true;
  }
  paint(c: PaperColors) {
    const key = `${c.surface}${c.accent}${this.variant}${Math.round(this.ink * 10)}`;
    if (key === this.drawn) return;
    this.drawn = key;
    drawPage(this.ctx, c, this.variant, this.ink);
    this.tex.needsUpdate = true;
  }
  // Curl lifts the right edge; fold turns the top half over the middle.
  apply() {
    const { st, mesh } = this;
    const pos = mesh.geometry.attributes.position;
    const a = pos.array as Float32Array;
    for (let i = 0; i < a.length; i += 3) {
      const x0 = this.base[i];
      const y0 = this.base[i + 1];
      const t = (x0 + W / 2) / W;
      let y = y0;
      let z = st.curl * t * t * 0.42;
      if (st.fold && y0 > 0) {
        y = y0 * Math.cos(st.fold);
        z += y0 * Math.sin(st.fold) * 1.02;
      }
      a[i + 1] = y;
      a[i + 2] = z;
    }
    pos.needsUpdate = true;
    mesh.geometry.computeVertexNormals();
    mesh.position.set(st.x, st.y, st.z);
    mesh.rotation.set(st.rx, st.ry, st.rz);
    mesh.scale.setScalar(st.s);
    mesh.material.opacity = st.o;
    mesh.visible = st.o > 0.01;
  }
  dispose() {
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
    this.tex.dispose();
  }
}

// One action as a GSAP timeline over the sheets' states. Every action starts
// and ends with sheet 0 at rest and the others hidden, so they chain.
function action(name: PaperAction, s: Sheet[], extra: { cut: THREE.Mesh; seal: THREE.Mesh; stamp: THREE.Mesh; scan: THREE.Mesh }) {
  const [a, b, c] = s.map((x) => x.st);
  const tl = gsap.timeline({ defaults: { ease: "power3.inOut" } });
  const reset = () => {
    Object.assign(a, REST);
    Object.assign(b, HIDDEN);
    Object.assign(c, HIDDEN);
  };
  tl.call(reset);
  switch (name) {
    case "merge":
      tl.set(b, { ...REST, x: -1.25, rz: -0.25, o: 0 }).set(c, { ...REST, x: 1.25, rz: 0.25, o: 0 }).set(a, { s: 0.92, o: 0 })
        .to(b, { x: -0.18, rz: -0.08, o: 1, duration: 0.7, ease: "power3.out" })
        .to(c, { x: 0.18, rz: 0.08, o: 1, duration: 0.7, ease: "power3.out" }, "<0.08")
        .to([b, c], { x: 0, rz: 0, z: 0.01, duration: 0.35, ease: "power4.in" }, "+=0.15")
        .set(a, { o: 1 })
        .to([b, c], { o: 0, duration: 0.01 })
        .to(a, { s: 1.04, duration: 0.12, ease: "power2.out" })
        .to(a, { s: 1, duration: 0.6, ease: "elastic.out(1, 0.45)" });
      break;
    case "split":
      tl.to(extra.cut.scale, { x: 1, duration: 0.5, ease: "power2.out" }, 0.2)
        .set(b, { ...REST }, ">")
        .set(c, { ...REST })
        .set(a, { o: 0 })
        .to(extra.cut.scale, { x: 0.0001, duration: 0.2 })
        .to(b, { x: -0.52, y: 0.06, rz: -0.14, s: 0.86, duration: 0.7, ease: "back.out(1.6)" }, "<")
        .to(c, { x: 0.52, y: -0.06, rz: 0.14, s: 0.86, duration: 0.7, ease: "back.out(1.6)" }, "<")
        .to([b, c], { x: 0, y: 0, rz: 0, s: 1, duration: 0.5 }, "+=0.7")
        .set(a, { o: 1 })
        .set([b, c], { o: 0 });
      break;
    case "compress":
      tl.to(a, { fold: Math.PI * 0.96, duration: 0.7 }, 0.2)
        .to(a, { s: 0.58, y: -0.1, duration: 0.45, ease: "power2.inOut" })
        .to(a, { curl: 0.5, duration: 0.25, yoyo: true, repeat: 1 })
        .to(a, { s: 1, y: 0, duration: 0.5, ease: "power2.out" }, "+=0.35")
        .to(a, { fold: 0, duration: 0.6, ease: "back.out(1.4)" }, "<0.15");
      break;
    case "seal":
      tl.set(extra.stamp, { visible: true })
        .set(extra.stamp.position, { y: 1.15, z: 0.28 })
        .set(extra.stamp.scale, { x: 1, y: 1, z: 1 })
        .to(extra.stamp.position, { y: -0.12, duration: 0.55, ease: "power3.in" }, 0.2)
        .to(extra.stamp.scale, { y: 0.6, duration: 0.08 }, ">")
        .to(a, { z: -0.04, duration: 0.08 }, "<")
        .to(extra.seal.scale, { x: 1, y: 1, z: 1, duration: 0.3, ease: "back.out(2)" }, ">")
        .to(extra.stamp.scale, { y: 1, duration: 0.2 }, "<")
        .to(a, { z: 0, duration: 0.3 }, "<")
        .to(extra.stamp.position, { y: 3, duration: 0.6, ease: "power2.in" }, ">0.1")
        .set(extra.stamp, { visible: false })
        .to(extra.seal.scale, { x: 0.0001, y: 0.0001, z: 0.0001, duration: 0.35 }, "+=0.9");
      break;
    case "turn":
      tl.to(a, { rz: -Math.PI / 2, duration: 0.7, ease: "back.inOut(1.4)" }, 0.2)
        .to(a, { rz: -Math.PI, duration: 0.7, ease: "back.inOut(1.4)" }, "+=0.35")
        .set(a, { rz: 0 }, "+=0.35");
      break;
    case "convert":
      tl.to(a, { ry: Math.PI / 2, curl: 0.3, duration: 0.45, ease: "power2.in" }, 0.2)
        .call(() => { s[0].variant = s[0].variant === "page" ? "table" : "page"; })
        .set(a, { ry: -Math.PI / 2 })
        .to(a, { ry: 0, curl: 0, duration: 0.6, ease: "back.out(1.5)" })
        .to(a, { ry: Math.PI / 2, duration: 0.45, ease: "power2.in" }, "+=0.9")
        .call(() => { s[0].variant = "page"; })
        .set(a, { ry: -Math.PI / 2 })
        .to(a, { ry: 0, duration: 0.6, ease: "back.out(1.5)" });
      break;
    case "write":
      tl.call(() => { s[0].ink = 0; })
        .to(s[0], { ink: 1, duration: 1.8, ease: "steps(10)" }, 0.2)
        .to(a, { rx: -0.12, duration: 0.9, yoyo: true, repeat: 1, ease: "sine.inOut" }, 0.2)
        .to({}, { duration: 0.6 });
      break;
    case "read":
      tl.set(extra.scan.position, { y: H / 2 })
        .set(extra.scan.scale, { x: 1, y: 1, z: 1 })
        .to(a, { z: 0.06, duration: 0.3 }, 0.1)
        .to(extra.scan.position, { y: -H / 2, duration: 1.4, ease: "sine.inOut" })
        .to(extra.scan.position, { y: H / 2, duration: 1.1, ease: "sine.inOut" })
        .set(extra.scan.scale, { x: 0.0001, y: 0.0001, z: 0.0001 })
        .to(a, { z: 0, duration: 0.3 });
      break;
  }
  tl.to({}, { duration: 0.5 });
  return tl;
}

const HERO_CYCLE: PaperAction[] = ["merge", "compress", "seal", "split", "convert", "turn", "write"];

export default function PaperScene({ mode, onReady }: { mode: PaperMode; onReady?: () => void }) {
  const host = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const hero = mode === "hero";
    let colors = paperColors();

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: "low-power" });
    renderer.setPixelRatio(Math.min(devicePixelRatio, 1.75));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFShadowMap;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    el.appendChild(renderer.domElement);
    renderer.domElement.setAttribute("aria-hidden", "true");
    renderer.domElement.style.cssText = "width:100%;height:100%;display:block";

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(32, 1, 0.1, 20);
    camera.position.set(0, 0.15, hero ? 3.3 : 2.25);
    camera.lookAt(0, 0, 0);

    const hemi = new THREE.HemisphereLight(0xffffff, 0x8a7a66, 2.4);
    scene.add(hemi);
    const sun = new THREE.DirectionalLight(0xffffff, 1.25);
    sun.position.set(-1.6, 2.4, 3);
    sun.castShadow = true;
    sun.shadow.mapSize.set(1024, 1024);
    sun.shadow.radius = 6;
    sun.shadow.camera.left = -2;
    sun.shadow.camera.right = 2;
    sun.shadow.camera.top = 2;
    sun.shadow.camera.bottom = -2;
    scene.add(sun);

    // A wall behind the paper that only shows shadows.
    const wall = new THREE.Mesh(new THREE.PlaneGeometry(8, 8), new THREE.ShadowMaterial({ opacity: 0.14 }));
    wall.position.z = -0.32;
    wall.receiveShadow = true;
    scene.add(wall);

    const group = new THREE.Group();
    scene.add(group);
    const sheets = [0, 1, 2].map(() => new Sheet(hero ? 20 : 14));
    sheets.forEach((s, i) => {
      s.mesh.renderOrder = i;
      group.add(s.mesh);
    });

    // The hero's resting stack: two sheets fanned behind the working one.
    const stack = hero
      ? [0, 1].map((i) => {
          const m = new THREE.Mesh(
            new THREE.PlaneGeometry(W, H),
            new THREE.MeshStandardMaterial({ color: colors.surface, roughness: 0.95 }),
          );
          m.position.set(i ? 0.09 : -0.08, i ? -0.03 : 0.02, -0.08 - i * 0.06);
          m.rotation.z = i ? 0.09 : -0.07;
          m.castShadow = true;
          group.add(m);
          return m;
        })
      : [];

    const accent = () => new THREE.Color(colors.accent);
    const cut = new THREE.Mesh(new THREE.PlaneGeometry(W * 1.1, 0.012), new THREE.MeshBasicMaterial({ color: accent() }));
    cut.position.z = 0.02;
    cut.scale.x = 0.0001;
    const seal = new THREE.Mesh(new THREE.CircleGeometry(0.11, 40), new THREE.MeshStandardMaterial({ color: accent(), roughness: 0.6 }));
    seal.position.set(0.18, -0.3, 0.012);
    seal.scale.setScalar(0.0001);
    const stamp = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.13, 0.16, 40), new THREE.MeshStandardMaterial({ color: accent(), roughness: 0.5 }));
    stamp.rotation.x = Math.PI / 2;
    // Parked out of sight (and out of the shadow) between seals.
    stamp.position.set(0.18, 3, 0.28);
    stamp.visible = false;
    stamp.castShadow = true;
    const scan = new THREE.Mesh(new THREE.PlaneGeometry(W * 1.08, 0.025), new THREE.MeshBasicMaterial({ color: accent(), transparent: true, opacity: 0.8 }));
    scan.position.z = 0.03;
    scan.scale.setScalar(0.0001);
    group.add(cut, seal, stamp, scan);
    const extra = { cut, seal, stamp, scan };

    const recolor = () => {
      colors = paperColors();
      for (const m of [cut, scan]) (m.material as THREE.MeshBasicMaterial).color.set(colors.accent);
      for (const m of [seal, stamp]) (m.material as THREE.MeshStandardMaterial).color.set(colors.accent);
      for (const m of stack) (m.material as THREE.MeshStandardMaterial).color.set(colors.surface);
      hemi.groundColor.set(colors.line);
      (wall.material as THREE.ShadowMaterial).opacity = document.documentElement.dataset.theme === "dark" || (!document.documentElement.dataset.theme && matchMedia("(prefers-color-scheme: dark)").matches) ? 0.35 : 0.14;
    };
    recolor();
    const offTheme = onThemeChange(recolor);

    // The timeline: one action on repeat, or the hero's cycle through them.
    const master = gsap.timeline({ repeat: -1, paused: true });
    if (hero) HERO_CYCLE.forEach((name) => master.add(action(name, sheets, extra)));
    else master.add(action(mode, sheets, extra));

    // Pointer tilt and, for the hero, a fan-out as it scrolls away.
    const tilt = { x: 0, y: 0, tx: 0, ty: 0 };
    const onPointer = (e: PointerEvent) => {
      tilt.tx = (e.clientX / innerWidth - 0.5) * 0.35;
      tilt.ty = (e.clientY / innerHeight - 0.5) * 0.25;
    };
    addEventListener("pointermove", onPointer, { passive: true });

    const resize = () => {
      const { width, height } = el.getBoundingClientRect();
      if (!width || !height) return;
      renderer.setSize(width, height, false);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
    };
    const ro = new ResizeObserver(resize);
    ro.observe(el);
    resize();

    // Runs only while on screen and the tab is visible.
    let frame = 0;
    let visible = true;
    const t0 = performance.now();
    const tick = () => {
      frame = requestAnimationFrame(tick);
      const t = (performance.now() - t0) / 1000;
      tilt.x += (tilt.tx - tilt.x) * 0.06;
      tilt.y += (tilt.ty - tilt.y) * 0.06;
      let spread = 0;
      if (hero) {
        const r = el.getBoundingClientRect();
        spread = Math.min(1, Math.max(0, -r.top / (r.height || 1)));
      }
      group.rotation.y = tilt.x + Math.sin(t * 0.5) * 0.05;
      group.rotation.x = -0.08 + tilt.y + Math.sin(t * 0.4) * 0.025;
      group.position.y = Math.sin(t * 0.8) * 0.025;
      stack.forEach((m, i) => {
        m.position.x = (i ? 0.09 : -0.08) + (i ? 1 : -1) * spread * 0.5;
        m.rotation.z = (i ? 0.09 : -0.07) + (i ? 1 : -1) * spread * 0.25;
      });
      for (const s of sheets) {
        s.paint(colors);
        s.apply();
      }
      renderer.render(scene, camera);
    };
    const start = () => {
      if (frame || !visible || document.hidden) return;
      master.play();
      tick();
    };
    const stop = () => {
      cancelAnimationFrame(frame);
      frame = 0;
      master.pause();
    };
    const io = new IntersectionObserver(([e]) => {
      visible = e.isIntersecting;
      if (visible) start();
      else stop();
    });
    io.observe(el);
    const onVisibility = () => (document.hidden ? stop() : start());
    document.addEventListener("visibilitychange", onVisibility);

    // First frame drawn: the stage cross-fades from the 2D version.
    for (const s of sheets) {
      s.paint(colors);
      s.apply();
    }
    renderer.render(scene, camera);
    onReady?.();
    start();

    return () => {
      stop();
      io.disconnect();
      ro.disconnect();
      offTheme();
      removeEventListener("pointermove", onPointer);
      document.removeEventListener("visibilitychange", onVisibility);
      master.kill();
      sheets.forEach((s) => s.dispose());
      scene.traverse((o) => {
        if (o instanceof THREE.Mesh && !sheets.some((s) => s.mesh === o)) {
          o.geometry.dispose();
          (o.material as THREE.Material).dispose();
        }
      });
      renderer.dispose();
      renderer.domElement.remove();
    };
  }, [mode, onReady]);

  return <div ref={host} className="absolute inset-0" />;
}
