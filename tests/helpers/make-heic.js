'use strict';

// Fabrica fotos HEIC REALES con Python + pillow-heif (si no estan instalados, `makeHeic` devuelve false y la
// prueba se omite, igual que con los comprimidos). Sin binarios en el repositorio.

const { spawnSync } = require('child_process');

const AVAILABLE = spawnSync('python3', ['-c', 'import pillow_heif, PIL'], { stdio: 'ignore' }).status === 0;

/**
 * kind: 'halves' (mitad roja, mitad azul: sirve para comprobar colores y que no se gira) |
 *       'noise' (ruido: pesa mucho, un JPEG de menos calidad si lo aligera) |
 *       'smooth' (degradado suave: HEIC de poca calidad, un JPEG pesa MAS)
 */
function makeHeic(outPath, { width = 320, height = 200, kind = 'halves', quality = 80, iccPath = '' } = {}) {
  if (!AVAILABLE) return false;
  const script = `
import sys, random
from PIL import Image, ImageDraw
import pillow_heif
pillow_heif.register_heif_opener()
out, w, h, kind, q, icc = sys.argv[1], int(sys.argv[2]), int(sys.argv[3]), sys.argv[4], int(sys.argv[5]), sys.argv[6]
im = Image.new('RGB', (w, h))
if kind == 'halves':
    d = ImageDraw.Draw(im); d.rectangle([0, 0, w // 2 - 1, h], fill=(220, 20, 20)); d.rectangle([w // 2, 0, w, h], fill=(20, 20, 220))
elif kind == 'noise':
    random.seed(3); im.putdata([(random.randint(0, 255), random.randint(0, 255), random.randint(0, 255)) for _ in range(w * h)])
else:
    d = ImageDraw.Draw(im)
    for y in range(h): d.line([0, y, w, y], fill=(y * 255 // h, 120, 255 - y * 255 // h))
im.save(out, quality=q, icc_profile=open(icc, 'rb').read() if icc else None)
`;
  return spawnSync('python3', ['-c', script, outPath, String(width), String(height), kind, String(quality), iccPath], { encoding: 'utf8' }).status === 0;
}

module.exports = { makeHeic, HEIC_AVAILABLE: AVAILABLE };
