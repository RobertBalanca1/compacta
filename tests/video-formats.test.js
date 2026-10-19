'use strict';

// "Que funcione con todo tipo de video": un clip real de CADA contenedor y
// codec soportado pasa por el compresor de verdad (no por una simulacion).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { FORMATS, makeClip, hostFfmpegCrashesReading } = require('./helpers/make-video-formats');
const { optimizeVideo } = require('../src/main/processor/video-optimizer');
const { probeVideo } = require('../src/main/processor/ffmpeg');
const { VIDEO_EXTENSIONS, RAW_VIDEO_EXTENSIONS, isSupportedVideo } = require('../src/main/processor/formats');

test('la tabla de pruebas cubre TODAS las extensiones de video soportadas', () => {
  const covered = new Set(FORMATS.map((f) => f.ext));
  const missing = [...VIDEO_EXTENSIONS].filter((ext) => !covered.has(ext));
  assert.deepEqual(missing, [], 'hay extensiones soportadas sin prueba real');
});

for (const format of FORMATS) {
  test(`video ${format.ext}: se reconoce, se comprime y sale como .mp4 valido`, async (t) => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'compacta-fmt-'));
    try {
      const input = path.join(dir, `clip${format.ext}`);
      if (!makeClip(format, input)) {
        if (format.optional) return t.skip('este ffmpeg no sabe crear este formato (solo leerlo)');
        assert.fail(`no se pudo preparar el clip de prueba ${format.ext}`);
      }
      assert.equal(isSupportedVideo(input), true, 'la app lo reconoce por su extension');
      if (hostFfmpegCrashesReading(input)) return t.skip('el ffmpeg de este equipo se cierra al leer este contenedor (verificado con el ffmpeg.exe de Windows)');

      const before = await probeVideo(input);
      assert.equal(before.hasVideo, true, 'ffmpeg ve una pista de video');

      const report = await optimizeVideo(input, path.join(dir, 'out', `clip${format.ext}`), { quality: 90 });
      const after = await probeVideo(report.output);
      assert.equal(after.hasVideo, true, 'la salida tiene video');
      // Un flujo de video "crudo" (.m2v) no declara su duracion: no hay con que comparar.
      if (RAW_VIDEO_EXTENSIONS.has(format.ext)) assert.ok(after.durationSec > 0.5, 'el MP4 de salida si declara su duracion');
      else if (before.durationSec > 0) assert.ok(Math.abs(after.durationSec - before.durationSec) < 0.6, `misma duracion (${before.durationSec} -> ${after.durationSec})`);
      assert.equal(after.height, before.height, 'misma altura');
      assert.ok(report.skipped ? report.output.endsWith(format.ext) : report.output.endsWith('.mp4'), 'sale como .mp4, o intacto si no habia mejora');
      assert.ok(report.newBytes <= report.originalBytes, 'nunca pesa mas que el original');
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
}
