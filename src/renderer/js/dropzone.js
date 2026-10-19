'use strict';

/**
 * Controla la zona de arrastrar/soltar y dibuja el anillo tipo
 * "anillo de apertura de lente" que se ilumina al arrastrar archivos.
 */
(function () {
  const SVG_NS = 'http://www.w3.org/2000/svg';

  function buildApertureTicks(svg, count = 20, cx = 100, cy = 100, rInner = 76, rOuter = 92) {
    for (let i = 0; i < count; i += 1) {
      const angle = (i / count) * Math.PI * 2 - Math.PI / 2;
      const x1 = cx + rInner * Math.cos(angle);
      const y1 = cy + rInner * Math.sin(angle);
      const x2 = cx + rOuter * Math.cos(angle);
      const y2 = cy + rOuter * Math.sin(angle);

      const line = document.createElementNS(SVG_NS, 'line');
      line.setAttribute('x1', x1.toFixed(2));
      line.setAttribute('y1', y1.toFixed(2));
      line.setAttribute('x2', x2.toFixed(2));
      line.setAttribute('y2', y2.toFixed(2));
      line.classList.add('tick');
      line.style.transitionDelay = `${(i / count) * 0.3}s`;
      svg.appendChild(line);
    }
  }

  function init({ onFilesDropped }) {
    const dropzone = document.getElementById('dropzone');
    const ring = document.getElementById('apertureRing');
    buildApertureTicks(ring);

    // Todo el cuerpo de la ventana acepta soltar archivos, no solo el recuadro
    // punteado. Antes, soltar una foto un poco fuera del recuadro hacia que
    // Electron NAVEGARA a ese archivo (la ventana de la app se convertia en
    // un visor de la imagen y habia que reiniciar). preventDefault() en
    // dragover/drop de todo el documento lo impide, y de paso es mas comodo.
    // Solo se reacciona a arrastres de ARCHIVOS (no a seleccionar texto).
    let dragDepth = 0;
    const hasFiles = (e) => !!e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files');

    document.addEventListener('dragenter', (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      dragDepth += 1;
      dropzone.classList.add('dragover');
    });

    document.addEventListener('dragover', (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    });

    document.addEventListener('dragleave', (e) => {
      if (!hasFiles(e)) return;
      dragDepth = Math.max(0, dragDepth - 1);
      if (dragDepth === 0) dropzone.classList.remove('dragover');
    });

    document.addEventListener('drop', (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      dragDepth = 0;
      dropzone.classList.remove('dragover');

      const files = Array.from(e.dataTransfer.files || []);
      const paths = files
        .map((file) => {
          try {
            return window.api.getPathForFile(file);
          } catch {
            return null;
          }
        })
        .filter(Boolean);

      if (paths.length > 0) onFilesDropped(paths);
    });

    // OJO: "Elegir archivos" y "Elegir carpeta" son <button> DENTRO de esta
    // zona, y keydown burbujea desde ellos hasta aqui. Sin el chequeo de
    // `e.target`, enfocar "Elegir carpeta" y pulsar espacio para activarla
    // terminaba, por burbujeo, disparando SIEMPRE chooseFilesBtn (el boton
    // equivocado) en vez del que de verdad tenia el foco. Este manejador es
    // solo para cuando la zona en si (el contenedor, no un boton suyo) es lo
    // que tiene el foco -- el caso de tabular hasta ella como "un boton
    // grande" gracias a su role="button".
    dropzone.addEventListener('keydown', (e) => {
      if (e.target !== dropzone) return;
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        document.getElementById('chooseFilesBtn').click();
      }
    });
  }

  window.Dropzone = { init };
})();
