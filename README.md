# Compacta

Compresión de fotos y vídeos por lotes. Arrastra fotos, vídeos, carpetas o comprimidos (zip, rar, 7z, tar…); se procesan de forma
segura, y salen más ligeras sin perder calidad visual — todo en tu propia máquina,
sin conexión a internet ni servicios externos.

## Qué hace exactamente

- **Recompresión inteligente por formato**, no una conversión artística ni un simple "resize":
  - **JPEG**: se recodifica con libjpeg-turbo (rápido); el interruptor "Compresión máxima" de Ajustes activa *mozjpeg* (~7% más de ahorro pero ~10 veces más lento). Es una compresión con pérdida controlada e imperceptible al ojo a la calidad por defecto (90).
  - **Audio** (MP3, M4A, WAV, FLAC, OGG, OPUS, WMA, AMR, AC3, MKA y los de Mac: AIFF, CAF, M4B, M4R… más de 40 extensiones): lo sin pérdida sale como MP3 de calidad transparente (5.1 como M4A; o FLAC/Opus si se elige en Ajustes); lo que ya tiene pérdida solo se recodifica si una prueba real ahorra ≥ 20 %. Estéreo que es mono → mono, modo «Solo voz», portadas reducidas (o copia sin recodificar). Conserva etiquetas, portada y capítulos. Va por su propio carril (hasta 4 a la vez). Ver `src/main/processor/audio-optimizer.js`, `audio-analysis.js` y la sección 7.19 de la documentación.
  - **Vídeo** (MP4, MOV, MKV, AVI, WebM, WMV, FLV, MPG, VOB, 3GP, MTS…): se recodifica con ffmpeg (incluido en el instalador) a calidad constante, sin reescalar ni cambiar fotogramas, con el audio AAC/MP3 copiado intacto y el HDR conservado; sale como `.mp4`. **Los subtítulos se conservan**: los de texto van dentro del MP4; si hay ASS o de imagen (Blu-ray, DVD), el vídeo sale como `.mkv` copiándolos tal cual. Si no ahorra al menos un 5 %, se deja el original.
  - **PNG**: por defecto es **100% sin pérdida** (mismos píxeles exactos, solo mejor compresión y filtrado, verificado con pruebas automatizadas). El "modo agresivo" (opcional, apagado por defecto) permite además reducir la paleta de colores para ahorrar mucho más espacio, a costa de una pérdida que puede ser visible en degradados muy suaves.
  - **WebP / AVIF / TIFF**: recompresión sin pérdida por defecto, con opción de convertir a WebP para ahorro extra.
  - **GIF y WebP animados**: la app detecta si tienen más de un fotograma y **los copia intactos sin tocarlos**, para no arriesgarse a romper la animación.
- **Nunca deja un archivo más pesado que el original.** Si tras optimizar no hay ahorro real, se copia el archivo original tal cual.
- **Conversión a WebP con criterio real**: si la foto de origen ya era JPEG (con pérdida), la conversión a WebP se hace con calidad ajustada, no "sin pérdida" — exigir cero pérdida sobre una imagen que ya la tenía casi siempre da un archivo *más pesado*, no más liviano. Si el origen ya era sin pérdida (PNG/TIFF), la conversión a WebP sigue siendo 100% sin pérdida por defecto.
- **Modo agresivo con efecto real en todos los formatos**, incluido JPEG (el más común en fotos de celular): reduce la calidad efectiva un tramo adicional para lograr más ahorro cuando se activa.
- **Botón Detener / Reanudar**: para el procesamiento en cualquier momento (la imagen que ya está a mitad de proceso termina normalmente, pero no se empieza ninguna nueva). Lo pendiente queda visible en la lista y se retoma con un clic.
- **Pegar con Ctrl+V**: además de arrastrar o usar los botones, se puede copiar una imagen (o un archivo desde el explorador) y pegarla directamente en la ventana.
- **Cola con paralelismo seguro**: procesa varias imágenes a la vez (según núcleos del equipo, entre 1 y 4) en vez de una por una. Cada trabajo es 100% independiente (su propio archivo de entrada y salida), así que no hay riesgo de corrupción por hacerlo en paralelo — solo velocidad extra.
- **Escritura atómica**: cada imagen se escribe primero a un archivo temporal y solo se renombra al nombre final si todo salió bien. Si la app se cierra a la fuerza a mitad de proceso, nunca queda un archivo corrupto con el nombre final.
- **Reanudación automática**: al reabrir la app, retoma sola cualquier imagen que quedó pendiente de una sesión anterior, sin repetir lo ya hecho.
- **Estructura de carpetas espejo**: todo lo que sueltes en `input/` aparece con la misma estructura de subcarpetas en `output/`.

## Cómo se usa

1. Abre la app.
2. Arrastra imágenes sueltas, una o varias carpetas, o archivos ZIP (que se descomprimen solos), sobre la ventana (o usa los botones "Elegir archivos" / "Elegir carpetas" / "Elegir ZIP").
3. La cola empieza a procesar automáticamente, mostrando el tamaño antes/después y el % ahorrado.
4. Pulsa "Abrir carpeta de salida" para ver los resultados.

Las carpetas de trabajo son:

```
Documentos/Compacta/input/    <- lo que arrastras se copia aquí, organizado por lotes
Documentos/Compacta/output/   <- resultado, exactamente la misma estructura de carpetas
```

En Ajustes (icono de engranaje) puedes cambiar la calidad, activar el modo agresivo,
o forzar la conversión de todo a WebP.

## Arquitectura del código

Electron (una ventana web ligera con acceso a Node.js) + [sharp](https://sharp.pixelplumbing.com/)
como motor de compresión nativo. Dividido en módulos pequeños, cada uno con una sola responsabilidad:

```
src/
  main/                        # Proceso principal (Node.js, sin UI)
    index.js                   # Arranque de la app, ventana, limpieza y reanudación al inicio
    paths.js                   # Rutas de input/output/config (independiente de Electron, testeable)
    importer.js                # Importar archivos, varias carpetas y comprimidos
    media-walker.js            # Recorrer carpetas
    zip-extractor.js           # Descompresor de ZIP propio
    system-archive.js          # RAR/7z/tar/gz/bz2/xz con el tar del sistema
    archive-extractor.js       # Reparte cada comprimido a su extractor
    file-manager.js            # Lotes, rutas de salida, pendientes, limpiar temporales
    queue-manager.js           # Cola: fotos en paralelo, video de uno en uno
    system-info.js             # Calcula cuantos trabajos correr en paralelo segun el hardware
    settings-store.js          # Persistencia de ajustes (JSON local)
    protocol.js                # Protocolo seguro para servir miniaturas al renderer
    ipc-handlers.js             # Conecta la UI con toda la lógica anterior
    processor/
      formats.js                # Qué se soporta: imágenes, videos, comprimidos
      index.js                  # Elige el compresor según el tipo de archivo
      raster-optimizer.js       # Imágenes (sharp)
      video-optimizer.js        # Videos (ffmpeg): calidad constante, nunca peor que el original
      ffmpeg.js                 # Localiza ffmpeg, inspecciona y ejecuta con progreso
      output-files.js           # Escritura atómica y nombres de salida

  preload/
    preload.js                 # Única puerta de comunicación UI <-> Node (contextBridge)

  renderer/                    # La interfaz (HTML/CSS/JS planos, sin frameworks ni bundler)
    index.html
    css/
      styles.css                # Tokens de diseño y componentes
      fonts.css                 # Tipografías locales (Space Grotesk + IBM Plex Sans)
    js/
      dropzone.js                # Arrastrar y soltar + anillo animado
      queueView.js                # Renderizado de la lista de la cola
      settingsPanel.js            # Panel de ajustes
      app.js                      # Orquestador que conecta todo lo anterior + manejo de errores
    assets/fonts/                # Archivos de fuente .woff2 embebidos (offline)

tests/
  formats.test.js               # Pruebas del detector de formatos
  audio-optimizer.test.js       # Audio: decisiones, 30+ formatos reales, portada, capitulos, 5.1...
  audio-efficiency.test.js      # Audio 1.0.12: mono real, modo voz, Opus, FLAC bit a bit, portadas, red de seguridad
  audio-analysis.test.js        # Audio 1.1.0: un solo ffmpeg para analizar, mismo resultado que uno por trozo
  i18n.test.js                  # 1.1.0: 6 idiomas con las mismas claves/parametros, plurales, deteccion
  ui-i18n-electron.js           # 1.1.0: idiomas en Electron real (cambio en vivo, RTL, sin textos desbordados)
  heic.test.js                  # 1.1.0: fotos HEIC reales (decodificar, color P3, hilo, vista previa, pasar siempre a JPG)
  zip-password.test.js          # 1.1.0: ZIP cifrados reales (ZipCrypto y AES) con zip y pyzipper; estres de contrasenas malas
  import-merge.test.js          # 1.1.0: carpetas con el mismo nombre se unen (sin «(2)»)
  import-streaming.test.js      # 1.1.0: entrega por tandas, indice compartido de duplicados, nombres previstos
  video-support.test.js         # Video 1.0.12: dos pistas de video, VP9/AV1 a HEVC, extensiones nuevas
  audio-queue.test.js           # Audio en el flujo completo + duplicados (fallos, rendimiento)
  raster-optimizer.test.js      # Pruebas del motor: sin pérdida, salvaguarda, animaciones, atomicidad
  file-manager.test.js          # Pruebas de importación, detección de pendientes, limpieza
  smoke-test-electron.js        # Prueba end-to-end sobre Electron real (lote de 12 fotos)
```

**Por qué está así:** cada archivo se puede leer, probar y modificar sin tocar el resto.
Por ejemplo, para soportar un formato nuevo solo tocas `processor/formats.js` y
`processor/raster-optimizer.js`; la cola, la UI y el resto no cambian. `paths.js`
está deliberadamente desacoplado de si Electron está realmente corriendo o no, para
que toda la lógica de negocio se pueda probar con Node normal (`npm test`) sin
necesidad de levantar la aplicación completa.

`npm run audit` revisa el código en busca de lo que sobra (exports, funciones, variables, imports y
dependencias sin uso) y avisa de las funciones largas; conviene pasarlo antes de cada versión.

No hay bundler (Webpack/Vite) ni frameworks de UI: son archivos `<script>` planos
cargados directamente por Electron.

## Desarrollo

Requiere [Node.js](https://nodejs.org) 22.12 o superior (el mismo que usa el flujo de GitHub; lo piden Electron 44 y `sharp` 0.35).
Electron 44 ya no descarga su binario al instalar: lo hace solo la primera vez que se ejecuta (`npm start`, `npm run dev` o las pruebas de interfaz), asi que esa primera vez hace falta internet.

```bash
npm install
npm start          # abre la app en modo normal
npm run dev         # abre la app con el DevTools disponible (Ctrl/Cmd+Opt+I)
npm test            # corre las pruebas automatizadas (motor, archivos, formatos, ajustes...)
npm run test:e2e    # prueba end-to-end sobre Electron real (arranque + reanudación)
npm run test:ui     # prueba de interfaz real: abre la ventana y hace clic/teclea sola
                    # en Linux sin pantalla: xvfb-run -a npm run test:ui
```

## Generar los instaladores (.dmg / .exe)

```bash
npm run dist:mac         # dist/Compacta-x.x.x-Mac.dmg: macOS 13 o superior, Intel y Apple Silicon, con el mismo Electron que Windows (ejecutar en macOS)
npm run dist:mac-legacy  # dist/Compacta-x.x.x-Mac-antiguo.dmg: macOS 10.13 a 12, Electron 26 y sharp 0.33.5 (ejecutar en macOS)
npm run dist:win         # dist/Compacta Setup x.x.x.exe (se puede compilar desde Linux, macOS o Windows)
```

> **macOS** solo se puede generar **en una Mac** (la fusión Intel + Apple Silicon necesita `lipo`, y el `.dmg`, `hdiutil`): por eso
> se usa **GitHub Actions** (ver más abajo), que ya trae Macs. **Windows sí se puede compilar desde Linux o macOS**
> (así se generó el .exe que acompaña este proyecto), usando Wine para incrustar el ícono — ver más abajo si vas a intentarlo tú mismo.
>
> **Hay dos instaladores de Mac porque no existe un único motor que cubra macOS 10.13 y esté al día:** Electron 44 (el de Windows) exige
> macOS 13; Electron 26 llega a macOS 10.13. Mismo código y misma interfaz (las pruebas pasan con las dos parejas). Cada `.dmg` es universal
> (Intel + Apple Silicon). Ver `DOCUMENTACION-PROYECTO.md`, 7.25.

### Nota importante si vas a compilar tú mismo: binarios nativos por plataforma

`sharp` (el motor de compresión) usa un binario nativo distinto por sistema operativo
y arquitectura. Si compilas el `.exe` de Windows **desde Linux o Mac**, un `npm install`
normal solo descarga el binario de tu propio sistema — el instalador quedaría sin el
binario de Windows y la app fallaría al abrir con el error
`Could not load the sharp module using the win32-x64 runtime`.

Por eso los scripts `dist:mac`, `dist:mac-legacy` y `dist:win` tienen un paso previo automático
(`predist:mac` / `predist:mac-legacy` / `predist:win` en `package.json`) que descarga también el binario
nativo del sistema de destino antes de empaquetar. No tienes que hacer nada extra:
basta con correr `npm run dist:win`, `npm run dist:mac` o `npm run dist:mac-legacy` y el binario correcto se
descarga solo. Esto ya se probó de punta a punta: se generó el `.exe`, se verificó
que el binario de Windows queda físicamente incluido (no solo referenciado), y se
confirmó que ya no arrastra binarios de otras plataformas de forma innecesaria.

### ffmpeg (vídeo): un binario por plataforma Y arquitectura

El vídeo usa ffmpeg, que se descarga con el paquete de desarrollo `ffmpeg-static` y se
deja en `vendor/ffmpeg/<plataforma>-<arquitectura>/` con `scripts/prepare-ffmpeg.js`.
Cada instalador lleva solo el suyo (`extraResources` con la macro `${arch}`): el `.app`
de Mac Intel lleva el de x64 y el de Apple Silicon el de arm64. Los scripts `predist:*`
y `prebuild:linux-dir` lo hacen solos; `vendor/` no se sube al repositorio (pesa ~290 MB).

### Requisitos de macOS (medidos en los binarios de los `.dmg`)

| Equipo | Instalador | Fotos y app | Vídeos y audios |
|---|---|---|---|
| macOS 13 (Ventura) o superior, Intel o chip Apple | `…-Mac.dmg` | sí | sí |
| Intel con macOS 10.13 a 12 | `…-Mac-antiguo.dmg` | sí | sí |
| Chip Apple con macOS 12 | `…-Mac-antiguo.dmg` | sí | sí |
| Chip Apple con macOS 11 | `…-Mac-antiguo.dmg` | sí | sí, con Rosetta (si falta, se avisa con el comando para instalarla) |
| macOS 10.12 o anterior | ninguno | no | no (Electron 26, `sharp` y ffmpeg piden 10.13); un Mac de finales de 2009 o posterior se puede actualizar gratis a 10.13 |

La versión antigua funciona, pero lleva un motor de 2023 y puede tener algún problema que la normal no tiene. Si no sabes cuál usar: menú  → «Acerca de este Mac».

Los comprimidos RAR/7z/tar usan el `tar` del sistema; el RAR5 puede no abrirse en
sistemas antiguos (se usa 7-Zip si está instalado). Qué se verificó sin un Mac y qué no: ver
**`PRUEBAS-EN-MAC.md`** (cómo probar en un Mac real, para colaborar) y `DOCUMENTACION-PROYECTO.md`, 7.23.

### GitHub Actions: así se genera y se prueba el `.dmg` (recomendado)

`.github/workflows/build.yml` compila el `.dmg` universal y el `.exe` en la nube de GitHub (gratis para repos públicos), cada uno en su
sistema operativo real, y **prueba cada `.dmg` en un Mac Intel y uno Apple Silicon reales** (arquitecturas, firma, que la ventana abre, y que
comprime de verdad una foto, un HEIC, un vídeo y un audio con lo que lleva dentro) además de pasar `npm test` en ellos.

1. Sube este proyecto a un repositorio de GitHub.
2. Ve a la pestaña **Actions** → **Construir instaladores** → **Run workflow**.
3. Cuando termine, descarga el instalador desde **Artifacts** del run (`Compacta-Mac`, `Compacta-Mac-antiguo` / `Compacta-Windows`), y la captura de la ventana
   en `ventana-…` para mirarla. Si lo lanzas con una etiqueta (`git tag v1.2.2 && git push --tags`), además lo publica en **Releases**
   con enlace de descarga.

## Notas honestas sobre "calidad"

- La calidad 90 por defecto en JPEG/WebP es *visualmente indistinguible* del original
  en la inmensa mayoría de fotos, pero técnicamente sigue habiendo una recompresión.
  Si necesitas garantía matemática de cero pérdida, sube el slider de calidad a 100
  y mantén apagado el "modo agresivo".
- La opción PNG sin modo agresivo sí es 100% sin pérdida de píxeles (verificado con pruebas).
- Todo el procesamiento ocurre localmente. La app no se conecta a internet ni envía
  ninguna imagen a ningún sitio.
- Pasar de 10MB a 1MB (90% menos) no es realista sin pérdida visible en una foto ya
  comprimida por un celular — eso sí es realista en capturas de pantalla (PNG) con
  el modo agresivo activado.

## Licencia

MIT para el código de este proyecto. Este software incluye Electron (MIT), sharp
(Apache-2.0) y libvips (LGPL-2.1-or-later) como dependencias, y las tipografías
Space Grotesk e IBM Plex Sans (ambas SIL Open Font License 1.1).
