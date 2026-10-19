'use strict';
const { app } = require('electron');

async function run() {
  await app.whenReady();
  // Datos AISLADOS: sin esto, esta prueba usaba la carpeta Documentos REAL del equipo, y
  // con "Omitir duplicados" una segunda ejecucion (mismas fotos) no importaba nada y
  // esperaba para siempre un evento que nunca llegaba. (Dentro de Electron, paths.js usa
  // app.getPath('documents'), no COMPACTA_TEST_BASE_DIR, que es solo para Node a secas.)
  app.setPath('documents', require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'compacta-smoke-')));
  const { ensureBaseFolders, getOutputDir } = require('../src/main/paths');
  const { importPaths } = require('../src/main/importer');
  const { listBatches, findUnprocessedFiles, getOutputPathFor } = require('../src/main/file-manager');
  const queueManager = require('../src/main/queue-manager');
  const sharp = require('sharp');
  const fs = require('fs/promises');

  ensureBaseFolders();
  console.log('Concurrencia elegida para esta maquina:', queueManager.concurrency);

  await fs.mkdir('/tmp/lote/Cumpleaños', { recursive: true });
  for (let i = 0; i < 12; i++) {
    const w = 1200, h = 900;
    const buf = Buffer.alloc(w * h * 3);
    for (let p = 0; p < buf.length; p++) buf[p] = (p * (i + 1)) % 256;
    await sharp(buf, { raw: { width: w, height: h, channels: 3 } })
      .jpeg({ quality: 95 })
      .toFile(`/tmp/lote/Cumpleaños/foto_${String(i).padStart(2, '0')}.jpg`);
  }

  const t0 = Date.now();
  const { importedFiles } = await importPaths(['/tmp/lote/Cumpleaños']);
  const pairs = importedFiles.map((inputPath) => ({ inputPath, outputPath: getOutputPathFor(inputPath) }));

  await new Promise((resolve) => {
    queueManager.on('queue-idle', resolve);
    queueManager.addJobs(pairs);
  });
  const totalMs = Date.now() - t0;

  const snapshot = queueManager.getSnapshot();
  const errores = snapshot.jobs.filter((j) => j.status === 'error');
  console.log(`Procesadas ${snapshot.jobs.length} imagenes en ${totalMs}ms (concurrencia=${queueManager.concurrency})`);
  console.log('Errores:', errores.length);
  console.log('Total ahorrado:', (snapshot.totalSavedBytes / 1024).toFixed(1), 'KB');

  const outputFiles = await fs.readdir(getOutputDir(), { recursive: true });
  const tempLeftovers = outputFiles.filter((f) => f.includes('.tmp-'));
  console.log('Archivos temporales huerfanos encontrados:', tempLeftovers.length, tempLeftovers);

  let allValid = true;
  for (const job of snapshot.jobs) {
    if (job.status === 'done' && job.report) {
      const stat = await fs.stat(job.report.output).catch(() => null);
      if (!stat || stat.size === 0) {
        allValid = false;
        console.log('¡ARCHIVO INVALIDO!', job.report.output);
      }
    }
  }
  console.log('Todos los archivos de salida son validos:', allValid);

  await fs.copyFile(
    '/tmp/lote/Cumpleaños/foto_00.jpg',
    '/tmp/lote/Cumpleaños/foto_nueva_sin_procesar.jpg'
  );
  await importPaths(['/tmp/lote/Cumpleaños/foto_nueva_sin_procesar.jpg']);
  const batches = await listBatches();
  const pendientes = await findUnprocessedFiles(batches);
  console.log('Archivos pendientes detectados tras agregar uno nuevo:', pendientes.length, pendientes.map(p => require('path').basename(p)));

  app.exit(0);
}

run().catch((e) => { console.error('ERROR E2E', e); app.exit(1); });
