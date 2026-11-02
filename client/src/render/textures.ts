import * as THREE from 'three';

/** Small procedural textures (no image files to load). */
export function canvasTexture(
  size: number,
  draw: (g: CanvasRenderingContext2D, size: number) => void,
  srgb = true,
): THREE.CanvasTexture {
  const cv = document.createElement('canvas');
  cv.width = cv.height = size;
  draw(cv.getContext('2d')!, size);
  const t = new THREE.CanvasTexture(cv);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** Soft radial glow, white on transparent (tinted by the material colour). */
export const glowTexture = (): THREE.CanvasTexture =>
  canvasTexture(
    128,
    (g) => {
      const gr = g.createRadialGradient(64, 64, 0, 64, 64, 64);
      gr.addColorStop(0, 'rgba(255,255,255,1)');
      gr.addColorStop(0.22, 'rgba(255,255,255,0.75)');
      gr.addColorStop(0.55, 'rgba(255,255,255,0.18)');
      gr.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = gr;
      g.fillRect(0, 0, 128, 128);
    },
    false,
  );

/** Seeded random so the ground looks the same for everyone. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

export function groundTexture(): THREE.CanvasTexture {
  const r = rng(7);
  return canvasTexture(512, (g, s) => {
    g.fillStyle = '#4c5f34';
    g.fillRect(0, 0, s, s);
    const blobs = ['#57703b', '#43572e', '#5f6a38', '#6b6240', '#3c4f2b', '#62763f'];
    for (let i = 0; i < 300; i++) {
      const x = r() * s;
      const y = r() * s;
      const rad = 6 + r() * 42;
      const rot = r() * 3;
      g.globalAlpha = 0.32;
      g.fillStyle = blobs[i % blobs.length]!;
      for (const dx of [-s, 0, s])
        for (const dy of [-s, 0, s]) {
          g.beginPath();
          g.ellipse(x + dx, y + dy, rad, rad * 0.7, rot, 0, Math.PI * 2);
          g.fill();
        }
    }
    g.lineWidth = 1.2;
    for (let i = 0; i < 3200; i++) {
      const x = r() * s;
      const y = r() * s;
      g.globalAlpha = 0.45;
      g.strokeStyle = r() < 0.5 ? '#7f9b4e' : '#33452a';
      g.beginPath();
      g.moveTo(x, y);
      g.lineTo(x + (r() * 4 - 2), y - (3 + r() * 4));
      g.stroke();
    }
    g.globalAlpha = 1;
  });
}

export function dirtTexture(): THREE.CanvasTexture {
  const r = rng(11);
  return canvasTexture(256, (g, s) => {
    const c = s / 2;
    const gr = g.createRadialGradient(c, c, 0, c, c, c);
    gr.addColorStop(0, 'rgba(120,98,68,1)');
    gr.addColorStop(0.55, 'rgba(110,90,62,0.85)');
    gr.addColorStop(1, 'rgba(100,84,58,0)');
    g.fillStyle = gr;
    g.fillRect(0, 0, s, s);
    for (let i = 0; i < 400; i++) {
      const a = r() * 6.28;
      const rad = r() * c * 0.8;
      g.fillStyle = r() < 0.5 ? 'rgba(80,64,44,0.5)' : 'rgba(150,128,95,0.4)';
      g.fillRect(c + Math.cos(a) * rad, c + Math.sin(a) * rad, 2, 2);
    }
  });
}

export function ringGlowTexture(): THREE.CanvasTexture {
  return canvasTexture(
    256,
    (g, s) => {
      const c = s / 2;
      const gr = g.createRadialGradient(c, c, c * 0.6, c, c, c);
      gr.addColorStop(0, 'rgba(255,255,255,0)');
      gr.addColorStop(0.75, 'rgba(255,255,255,1)');
      gr.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = gr;
      g.fillRect(0, 0, s, s);
    },
    false,
  );
}
