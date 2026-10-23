# Compacta — Documentación completa del proyecto

Este documento existe para dejar constancia completa de qué es este proyecto,
cómo se construyó, qué problemas se encontraron y cómo se resolvieron —
pensado para que sirva como referencia autosuficiente aunque no se tenga a
mano la conversación original donde se desarrolló.

---

## 1. Qué es y para qué se hizo

**Compacta** es una aplicación de escritorio (Windows y, potencialmente, macOS)
que comprime fotos por lotes para que ocupen menos espacio en disco, sin
pérdida visible de calidad. Pensada para repartirse a una iglesia y
congregaciones hermanas: gente sin conocimientos técnicos debe poder
instalarla con un doble clic y usarla sin fricción.

Requisitos originales que guiaron todas las decisiones:
- Arrastrar y soltar imágenes, o botón para elegir archivos/carpeta.
- Procesamiento por lotes, rápido y confiable (no "toda una vida").
- Reducir el peso de cada imagen **sin perder calidad ni elementos**.
- Estructura de carpetas `input/` → `output/` que refleja subcarpetas.
- Código fuente real, modular (no un solo archivo gigante).
- Sin dependencias externas en tiempo de ejecución (100% offline).
- Entregable como instalador de doble clic, sin que el usuario final
  necesite instalar Node, Python, ni nada técnico.
- Arquitectura sólida: manejo de errores, sin archivos a medias, verificado
  con pruebas reales, no solo "se ve que compila".

## 2. Decisión de tecnología

- **Electron** (Chromium + Node.js empaquetados) para la interfaz y el
  empaquetado como instalador nativo (.exe / .dmg). Permite una UI moderna
  con HTML/CSS/JS sin depender de un toolkit nativo distinto por plataforma.
- **sharp** (motor de imagen basado en libvips, en C++, con bindings nativos
  precompilados) para la compresión real. Es el estándar de facto en Node
  para procesamiento de imágenes de alto rendimiento.
- Sin bundler (Webpack/Vite) ni framework de UI (React/Vue): archivos
  `<script>` planos cargados directo por Electron. Menos piezas moviéndose,
  menos dependencias, más fácil de auditar.
- Sin backend, sin servidor, sin telemetría, sin llamadas de red en tiempo de
  ejecución.

## 3. Arquitectura de carpetas

```
src/
  main/                        Proceso principal (Node.js, sin UI)
    index.js                   Arranque, ventana, limpieza y reanudación al inicio
    paths.js                   Rutas input/output/config (desacoplado de Electron)
    batch-progress.js          Progreso global y tiempo restante (funcion pura)
    duplicates.js              Detectar fotos/videos identicos a lo ya importado
    output-dir.js              Carpeta de salida elegible: validar, aplicar, avisar
    preview.js                 Vista previa antes/despues: general (sharp), detalle al 100 % y fotograma de video
    import-sidecars.js         Limpiar subtitulos huerfanos tras abrir un comprimido
    importer.js                Importar: archivos, varias carpetas, comprimidos, portapapeles
    media-walker.js            Recorrer carpetas (lista plana y por carpetas)
    import-context.js          Contadores y límites compartidos de UNA importación
    zip-extractor.js           Descompresor de ZIP propio (streaming, anti zip-slip/bomba)
    system-archive.js          RAR, 7z, tar, gz, bz2, xz con el "tar" del sistema
    archive-extractor.js       Reparte cada comprimido al extractor que corresponda
    archive-errors.js          Errores de descompresión -> frase para la persona
    file-names.js              Nombres de ruta seguros y sin colisiones
    file-manager.js            Lo que hay en input/output: lotes, salida, pendientes, limpieza
    manifest-store.js          Registro de "ya procesado" (escritura diferida y atómica)
    queue-manager.js           Cola con tres carriles (fotos en paralelo, video de uno en uno, audios hasta 4)
    system-info.js             Calcula concurrencia según el hardware
    language.js                Idioma de la app en el proceso principal (ajuste o idioma del sistema) (7.21)
    sharp-lazy.js              Carga `sharp` la primera vez que hace falta, no antes de dibujar la ventana (7.21)
    settings-store.js          Persistencia de ajustes (JSON local)
    protocol.js                Protocolo seguro para miniaturas en el renderer
    ipc-handlers.js             Conecta la UI con toda la lógica anterior
    processor/
      formats.js                Qué se soporta: imágenes, videos, audios y comprimidos
      index.js                  Elige el compresor según el tipo de archivo
      raster-optimizer.js       Imágenes (sharp)
      video-optimizer.js        Videos: calidad -> parámetros, nunca peor que el original
      audio-optimizer.js        Audio (cualquier formato, también Mac): MP3/AAC/Vorbis/Opus/FLAC; mono real, modo voz, portadas; 7.18 y 7.19
      scripts/audit-code.js     `npm run audit`: exports/funciones/variables/imports/dependencias sin uso y funciones largas (7.20)
      audio-analysis.js         Mide canales reales y el peso real de la salida con unas muestras (7.19)
      ffmpeg.js                 Localizar ffmpeg, inspeccionar un video, ejecutar con progreso
      heic.js                   Fotos HEIC/HEIF: decodifica con libheif-js en un hilo aparte (7.21)
      heic-worker.js            El hilo (WebAssembly); sale desempaquetado del .asar (asarUnpack)
      heic-color.js             Display P3 -> sRGB y detección del perfil por sus primarias (funciones puras)
      output-files.js           Escritura atómica y nombres de salida, comunes a ambos
      child-processes.js        Registro de procesos externos para matarlos al cerrar
      sidecars.js               Copiar los subtitulos de archivo aparte junto a la salida

  shared/                      Lo usan por igual el proceso principal (require) y la ventana (<script>)
    i18n.js                    t(), plurales, idioma del sistema, dirección (RTL), isolate() para el bidi
    locales/                   es.js (FUENTE), en, de, it, vi, ar: mismas claves (lo comprueba tests/i18n.test.js)

  preload/
    preload.js                 Única puerta de comunicación UI <-> Node

  renderer/                    Interfaz (HTML/CSS/JS planos)
    index.html
    css/ (styles.css, fonts.css)
    js/ (dropzone.js, clipboard.js, queueView.js, settingsPanel.js, app.js)
    assets/fonts/               Tipografías locales embebidas (offline)

tests/
  formats.test.js
  raster-optimizer.test.js
  file-manager.test.js
  smoke-test-electron.js        Prueba end-to-end sobre Electron real
```

**Principio seguido en todo el proyecto**: cada archivo tiene una sola
responsabilidad y se puede leer/probar/modificar sin tocar el resto. Por
ejemplo, `paths.js` detecta si está corriendo dentro de Electron o no
(`typeof require('electron') === 'object'`), y si no lo está, usa una carpeta
temporal — esto permite que toda la lógica de negocio (`file-manager`,
`raster-optimizer`, `video-optimizer`, etc.) se pruebe con `node --test` normal, sin necesitar
levantar la aplicación completa.

## 4. Flujo de datos

1. El usuario arrastra archivos/carpetas, usa los botones, o pega con Ctrl+V.
2. El renderer extrae las rutas reales (`webUtils.getPathForFile`) y las
   manda al proceso principal por IPC.
3. `importer.importPaths()` copia lo recibido dentro de `input/`,
   preservando la estructura de carpetas, y filtra solo fotos y videos
   soportados; los comprimidos (zip, rar, 7z, tar...) se abren y solo
   entra lo que sea foto o video.
4. Cada archivo importado se encola en `queue-manager` junto con su ruta de
   salida espejo en `output/`.
5. `queue-manager` reparte el trabajo entre varios "workers" en paralelo
   (según núcleos y memoria del equipo) para las fotos, y de uno en uno
   para los videos (carril propio), llamando a `processor.processMedia()`.
6. `processMedia()` elige el compresor: sharp para imágenes, ffmpeg para
   videos. Ambos escriben de forma atómica (archivo temporal + renombrado,
   nunca escritura directa al nombre final).
7. Cada cambio de estado se emite de vuelta al renderer, que actualiza la
   lista visualmente en tiempo real.

## 5. El motor de compresión, por formato

| Formato de origen | Comportamiento por defecto | Modo agresivo |
|---|---|---|
| JPEG | Recompresión con pérdida controlada (mozjpeg), calidad configurable (90 por defecto) | Baja la calidad efectiva ~15 puntos para más ahorro |
| PNG | 100% sin pérdida (mejor filtrado/compresión, mismos píxeles) | Cuantiza la paleta de color (como pngquant) |
| WebP / TIFF | Recompresión sin pérdida | Ídem PNG/JPEG según corresponda |
| GIF / WebP animado | Se detecta si tiene más de un fotograma y se copia intacto, sin tocar | (no aplica, se preserva igual) |
| Conversión a WebP (opcional) | Sin pérdida si el origen ya era sin pérdida (PNG/TIFF); con pérdida controlada por calidad si el origen ya era JPEG | Fuerza codificación con pérdida para más ahorro |

**Salvaguarda universal**: si el resultado optimizado no pesa menos que el
original, se descarta y se copia el archivo original tal cual. Nunca se
entrega un archivo peor que el que se recibió.

**Escritura atómica**: cada imagen se escribe primero a
`nombre.ext.tmp-xxxxxx` y solo se renombra al nombre final si la escritura
terminó bien. Si el proceso se interrumpe a la mitad (cierre forzado, corte
de luz), el peor caso es un temporal huérfano — nunca un archivo final
corrupto. Esos temporales huérfanos se limpian solos la siguiente vez que se
abre la app (si tienen más de un minuto de antigüedad, para no tocar una
escritura en curso de otra instancia).

**Reanudación automática**: al iniciar, la app compara cada imagen de
`input/` contra su equivalente esperado en `output/`; si no existe, la
vuelve a encolar. Así, cerrar la app a mitad de un lote grande nunca pierde
trabajo ni lo repite innecesariamente.

## 6. Cifras reales medidas (no estimadas)

Foto sintética de 12 megapíxeles con textura/ruido tipo cámara de celular,
calidad 95 de "cámara", procesada en un núcleo de CPU modesto:

| Calidad | Tamaño resultante | Ahorro | Tiempo |
|---|---|---|---|
| 82 | 1.12 MB | -66.5% | 1.75 s |
| 88 | 1.67 MB | -50.1% | 2.18 s |
| 90 (por defecto) | 1.91 MB | -43.0% | 3.02 s |
| 92 | 2.62 MB | -21.9% | 3.31 s |

En una computadora real con varios núcleos (la app usa entre 1 y 4 en
paralelo según el hardware), un lote de 30-50 fotos debería tardar bajo el
minuto en total, no horas.

**Nota de honestidad**: pasar de 10 MB a 1 MB (90% menos) no es realista sin
pérdida visible en una foto que el celular ya comprimió. Reducciones de esa
magnitud sí son típicas en capturas de pantalla (PNG) con modo agresivo.

## 7. Bitácora de problemas encontrados y solucionados

### 7.1 — El `.exe` no abría: "Could not load the sharp module using the win32-x64 runtime"

**Causa raíz**: `sharp` usa un binario nativo distinto por sistema operativo
y arquitectura. El `.exe` de Windows se compiló desde un entorno Linux; un
`npm install` normal en Linux solo descarga el binario nativo de Linux, no
el de Windows. El instalador se armó completo, pero sin el binario que
realmente necesitaba para funcionar en una PC con Windows.

**Solución aplicada**: se agregaron scripts `predist:win` / `predist:mac` en
`package.json` que descargan explícitamente el binario nativo del sistema de
destino (`npm install --os=win32 --cpu=x64 sharp`) antes de empaquetar. npm
ejecuta automáticamente cualquier script `preX` antes de `X`, así que
`npm run dist:win` se autocorrige solo, sin pasos manuales adicionales.
También se configuró `asarUnpack` para que los binarios nativos (`.node` y
sus `.dll` de soporte) queden como archivos reales en disco en vez de
empaquetados dentro del `.asar` — necesario porque Node no puede cargar un
addon nativo desde dentro de ese archivo virtual.

**Verificación**: se instaló la app de verdad dentro de un Windows emulado
con Wine, confirmando que el binario correcto queda físicamente presente
(`app.asar.unpacked/node_modules/@img/sharp-win32-x64/...`) y que ya no
arrastra binarios de otras plataformas (el instalador bajó de 91.8 MB a
86.3 MB al excluirlos explícitamente en la configuración de `electron-builder`).

### 7.2 — Activar "Convertir a WebP" no reducía el peso ni cambiaba el formato

**Causa raíz**: al convertir un JPEG (que ya tiene pérdida) a WebP, el código
exigía por defecto una codificación **sin pérdida** (`lossless: !aggressive`,
que da `true` cuando el modo agresivo está apagado). Codificar sin pérdida
los píxeles de una imagen que ya venía con el ruido de compresión de un JPEG
casi siempre da un archivo **más pesado** que el JPEG original, nunca más
liviano. La salvaguarda "nunca entregar algo peor que el original" entraba
en acción cada vez, descartaba la conversión, y copiaba el archivo original
sin tocar — por eso parecía que la función "no hacía nada".

**Solución aplicada**: la decisión de usar codificación sin pérdida o con
pérdida ahora depende de si el **formato de origen** ya era sin pérdida
(PNG/TIFF) o no (JPEG). Si el origen ya era JPEG, la conversión a WebP usa
calidad ajustada (con pérdida controlada, igual que la recompresión normal
de JPEG), lo cual sí reduce el tamaño de forma real. Si el origen ya era
PNG/TIFF, se mantiene sin pérdida por defecto, preservando la garantía de
cero pérdida donde tiene sentido.

**Verificación**: prueba automatizada que confirma que convertir un JPEG a
WebP ahora sí reduce el tamaño y cambia la extensión, y otra prueba que
confirma que convertir un PNG a WebP sigue siendo perfectamente sin pérdida
(píxeles idénticos, comparados byte a byte).

### 7.3 — El "modo agresivo" no tenía ningún efecto

**Causa raíz**: el modo agresivo solo estaba implementado para PNG (cuantizar
colores) y WebP (permitir codificación con pérdida). Para JPEG —el formato
más común en fotos de celular, y por lo tanto el que más probablemente
estaba probando el usuario— el código de codificación de JPEG ignoraba por
completo el parámetro `aggressive`. Encender o apagar el modo agresivo en
una foto JPEG daba exactamente el mismo archivo, byte por byte.

**Solución aplicada**: cuando el modo agresivo está activo, la calidad
efectiva de JPEG (y de WebP/AVIF cuando corresponde) se reduce un tramo fijo
adicional (~15 puntos, con un piso de calidad 40) para lograr un ahorro
extra real y perceptible en el tamaño del archivo.

**Verificación**: prueba automatizada que confirma que, para el mismo JPEG y
la misma calidad base, el resultado con modo agresivo activado pesa menos
que el resultado sin él (antes del arreglo, ambos daban el mismo número
exacto de bytes).

### 7.4 — Nombre del editor/publicador en Windows

Se corrigió el campo "Publisher" (visible en Configuración → Aplicaciones →
Compacta, y en las propiedades del archivo `.exe`) para mostrar
**Robert Balanca Florentin** en vez del placeholder original. Este cambio
vive únicamente en los metadatos del programa (registro de Windows,
propiedades del ejecutable) — deliberadamente **no** se agregó ningún texto
visible dentro de la interfaz de la aplicación, respetando que el nombre
"Compacta" se mantuviera como la única marca visible para quien la usa.

### 7.5 — La app volvía a comprimir fotos ya terminadas cada vez que se abría

**Síntoma reportado**: al reabrir Compacta con fotos ya procesadas en
sesiones anteriores, la app las mostraba de nuevo en la cola y las volvía a
comprimir desde cero, en vez de dejarlas quietas. Con lotes grandes esto
convertía cada apertura en varios minutos de espera innecesaria.

**Causa raíz**: la comprobación de "¿esta foto ya tiene salida?"
(`findUnprocessedFiles` en `file-manager.js`) comparaba el nombre completo
de archivo, extensión incluida, entre `input/` y `output/`
(`output/foto.JPG` contra `input/foto.JPG`, carácter por carácter). Pero
`raster-optimizer.js` **normaliza** la extensión de salida a minúscula y
forma canónica (`.JPG`/`.jpeg` → `.jpg`, `.TIFF` → `.tif`, etc.), y además
la cambia a `.webp` si el ajuste "Convertir a WebP" está activo. El nombre
que de verdad queda en `output/` casi nunca coincidía carácter por carácter
con el que la comprobación esperaba, así que casi siempre daba "no está
hecho" — en particular con **cualquier foto de cámara o celular**, porque
esas casi siempre traen la extensión en mayúscula (`IMG_1234.JPG`), que es
el caso que más se dispara en la práctica, no un caso raro de borde.

**Solución aplicada**: en vez de adivinar la extensión exacta que va a
elegir el compresor (algo que depende de ajustes que pueden cambiar entre
una sesión y otra), `findUnprocessedFiles` ahora solo compara el **nombre
base sin extensión**, sin distinguir mayúsculas de minúsculas, dentro de la
carpeta de salida que le corresponde a cada imagen. Si existe *cualquier*
archivo con ese nombre base en `output/` — sea cual sea su extensión final
— la foto se considera terminada. Esto desacopla la lógica de reanudación
de los detalles internos de qué extensión exacta produce el compresor, que
es responsabilidad de `raster-optimizer.js`, no de `file-manager.js`.

**Verificación**: dos pruebas de regresión automatizadas que confirman que
una foto ya procesada no se vuelve a encolar ni cuando su salida quedó con
la extensión en minúscula (`IMG_0001.JPG` → `IMG_0001.jpg`) ni cuando quedó
convertida a WebP (`foto.jpg` → `foto.webp`); ambas pruebas fallan con el
código anterior y pasan con la corrección, confirmando que efectivamente
cubren el bug reportado. También se confirmó de punta a punta con la
prueba end-to-end sobre Electron real (`npm run test:e2e`): tras procesar
12 fotos, reabrir el flujo de arranque no vuelve a encolar ninguna de las
12 ya hechas, y sí detecta correctamente una fotos nueva agregada después.

### 7.6 — [EN INVESTIGACIÓN] El usuario reporta que el reprocesamiento sigue ocurriendo tras 7.5

Tras entregar la corrección de 7.5 (confirmada dentro del `.exe` empaquetado
mediante extracción directa del `app.asar`), el usuario reportó que el
problema seguía presente en su uso real, aunque los botones nuevos
("Eliminar pendientes") sí funcionaban correctamente — es decir, estaba
probando la versión correcta, no una copia vieja.

Se revisó de nuevo todo el camino de arranque (`index.js` →
`findUnprocessedFiles` → `getInputDir`/`getOutputDir` en `paths.js`) sin
encontrar otro defecto de lógica; el mecanismo de detección por nombre base
(7.5) se sostiene ante los casos considerados (mayúsculas/minúsculas,
conversión a WebP, subcarpetas anidadas). Hipótesis pendientes de descartar
con el usuario, de más a menos probable:

1. **Sincronización en la nube de la carpeta "Documentos"**: en Windows 11
   es común (a veces activado por defecto) que "Documentos" esté redirigido
   a OneDrive. Si OneDrive mueve, vacía o no sincroniza a tiempo el
   contenido de `Documentos\Compacta\output`, la carpeta puede aparecer
   vacía al reabrir la app aunque los archivos existan "en la nube" — desde
   el punto de vista de `fs.readdir`, eso es indistinguible de que nunca se
   procesaron. Equivalente en Mac: iCloud Drive con "Optimizar
   almacenamiento de Mac" activado.
2. El usuario está probando en Mac ejecutando el código fuente directamente
   (no hay instalador Mac todavía, ver sección 11), y hay alguna diferencia
   de comportamiento específica de plataforma no identificada.
3. Un defecto real no identificado, distinto al de 7.5.

Se le pidió al usuario un diagnóstico concreto y de bajo esfuerzo: revisar
si los archivos en `output/` siguen ahí (fuera de la app, en el explorador
de archivos) después de cerrar Compacta y sin volver a abrirla, más
confirmar sistema operativo y si "Documentos" muestra ícono de nube.
**Pendiente de respuesta para continuar el diagnóstico.**

### 7.7 — Mitigación aplicada sin esperar la confirmación de 7.6: manifiesto interno

Sin haber recibido confirmación del usuario sobre la hipótesis de 7.6, se
decidió aplicar de todas formas una mitigación estructural, porque hace la
detección de "ya procesado" más robusta en general, no solo para el caso de
OneDrive/iCloud:

Se agregó `manifest-store.js`, un registro plano (`processed-manifest.json`)
que vive en la carpeta de datos de usuario del sistema operativo (la misma
donde ya vivía `settings.json`), **nunca dentro de Documentos**. Cada vez
que `queue-manager.js` termina un trabajo con éxito, se marca ahí además de
dejar el archivo en `output/`. `findUnprocessedFiles` ahora consulta
primero este registro; solo si no aparece ahí cae al escaneo de `output/`
de 7.5. Con esto, aunque `output/` no esté disponible a tiempo por
sincronización en la nube, la app igual sabe que esa foto ya se hizo.

Limitación reconocida: fotos que ya estaban procesadas ANTES de instalar
esta versión no tienen entrada en el manifiesto todavía (versiones
anteriores nunca lo escribieron). La primera apertura tras actualizar
podría reprocesarlas una vez más si el escaneo de `output/` falla para
ellas por la razón de 7.6 — pero a partir de esa vez quedan en el
manifiesto y no debería volver a pasar. No es una solución retroactiva,
es un piso a partir de ahora.

Se agregaron pruebas (`tests/manifest-store.test.js` y un caso en
`tests/file-manager.test.js`) que simulan exactamente el escenario de 7.6
(`output/` completamente vacío) y confirman que el manifiesto evita el
reproceso en ese caso.

### 7.8 — Aviso proactivo de OneDrive/iCloud

`paths.js` expone `isBaseDirCloudSynced()`: una detección heurística (busca
"onedrive", "icloud" o "mobile documents" en la ruta de la carpeta base,
sin distinguir mayúsculas/minúsculas) que cubre los casos por defecto más
comunes de redirección de "Documentos" en Windows 11 y macOS. Si detecta
esto, se muestra un banner descartable en la interfaz explicando el riesgo
y sugiriendo excluir la carpeta "Compacta" de la sincronización. El
descarte se recuerda entre sesiones (`dismissedCloudWarning` en
`settings.json`). No es infalible (es una búsqueda de texto en la ruta, no
una consulta real al servicio de sincronización), pero cubre el caso
general sin agregar dependencias nuevas.

### 7.9 — Revisión exhaustiva de bugs y código muerto (v1.0.4)

Tras el reporte de que "los perfiles no funcionan, las notificaciones
tampoco", se hizo una revisión completa de todo el código — no solo del
punto reportado — con pruebas automatizadas nuevas para cada hallazgo y una
prueba de interfaz real (`tests/ui-test-electron.js`, ver sección 9) que
abre la app de verdad y hace clic/teclea como una persona, porque varios de
estos bugs son invisibles para las pruebas unitarias de siempre (dependen
de comportamientos reales de Electron, no de la lógica interna).

**Los perfiles y "Eliminar pendientes" de verdad no funcionaban.** Causa:
`window.prompt()` no está soportado en Electron (no lanza error, simplemente
no hace nada o devuelve `null`), así que los botones de crear/renombrar
perfil no tenían ningún efecto. `window.confirm()` sí funciona, pero en
Windows deja a veces los campos de texto de la ventana sin poder escribirse
después de usarlo. Se reemplazaron los dos por un cuadro de diálogo propio
dentro de la app (`src/renderer/js/dialog.js` + estilos en `styles.css`),
con foco atrapado dentro del cuadro y cierre con Escape/clic afuera.

**Las notificaciones de lote no aparecían.** Dos causas encima de la otra:
(1) el aviso se disparaba en el evento `queue-idle`, que salta también al
pulsar **Detener** — no solo al terminar de verdad —, y (2) solo se
mostraba si la ventana no tenía el foco, así que nunca se veía mientras se
probaba con la app abierta delante. Se separó la cuenta de "trabajo hecho"
(nueva, en `queue-manager.js`: `this.batch`) de la de "sin nada que
procesar ahora mismo", y se creó `src/main/notifier.js`, que avisa por
**dos canales siempre** (un aviso verde dentro de la app + la notificación
del sistema), y solo además pide atención (parpadeo/rebote del ícono) si la
ventana está en segundo plano.

**Las miniaturas de la cola no cargaban nunca** (invisible sin mirar la
consola: `net::ERR_FILE_NOT_FOUND` en cada una). El protocolo
`compacta-file:///Lote/foto.jpg` usaba host vacío; Chromium interpreta el
primer tramo tras `//` como el host de la URL, así que la ruta real perdía
su primer directorio. Corregido con un host fijo (`compacta-file://app/...`).

**En macOS, cerrar la ventana rompía la app hasta reiniciarla.** Los
manejadores de IPC quedaban enganchados a la ventana original (via cierre
de variable); en macOS cerrar la ventana no cierra la app, y al reabrir
desde el Dock se creaba una ventana nueva a la que nadie avisaba de los
cambios de la cola, y los diálogos de abrir archivo/carpeta fallaban con
"Object has been destroyed". `setupIpcHandlers` ahora recibe una función
que devuelve la ventana **actual**, no la ventana en sí.

**Otros bugs de seguridad y de datos, todos con prueba de regresión:**
- Path traversal por prefijo en el protocolo de miniaturas: `startsWith(baseDir)`
  aceptaba una carpeta hermana como `Compacta-otra-cosa`.
- Dos fotos con el mismo nombre y distinta extensión (`foto.jpg` + `foto.png`)
  podían pisarse una a la otra en `output/` (por ejemplo, ambas como
  `foto.webp` con "Convertir a WebP").
- `findUnprocessedFiles` (la corrección de 7.5) podía dar **falsos
  positivos**: si existía `foto.jpg`, se daba por hecha `foto.png` con el
  mismo nombre. Se cambió a comparar contra la lista exacta de nombres que
  el compresor puede producir (`candidateOutputFileNames` en `formats.js`,
  única fuente de verdad compartida con `raster-optimizer.js`).
- `.DS_Store`, `._foto.jpg`, `Thumbs.db`, `desktop.ini`, `__MACOSX/` (basura
  que crean solos macOS/Windows) contaban como "archivo no compatible" al
  importar una carpeta — muy notorio en Mac, donde `.DS_Store` está en
  todas partes.
- La extensión que llega desde el portapapeles al pegar una imagen no se
  validaba: una extensión manipulada podía escapar de la carpeta temporal.
- `settings.json` se escribía directo (no atómico): un corte de luz a
  mitad de guardar podía corromperlo y borrar todos los perfiles en
  silencio. Ahora se escribe a un temporal y se renombra.
- Los ajustes que llegan por IPC (calidad, etc.) no se validaban antes de
  guardarse ni de llegar al motor de compresión.
- Sin bloqueo de instancia única: abrir Compacta dos veces hacía que ambas
  copias procesaran las mismas carpetas a la vez.
- Fallos pasajeros de Windows al renombrar el archivo final (antivirus,
  indexador, OneDrive reteniendo el archivo un instante) hacían fallar una
  foto entera con un error confuso; ahora se reintenta un par de veces.
- El atajo de barra espaciadora interfería con los botones: con
  "Detener/Reanudar" enfocado, alternaba el estado dos veces de un solo
  toque; sobre la zona de arrastrar, abría el selector de archivos Y
  ADEMÁS detenía la cola.
- `npm run dev` no abría las herramientas de desarrollador pese a que el
  README lo prometía (nada leía el parámetro `--dev`).
- El botón "Abrir carpeta de salida" no hacía nada, sin avisar, si esa
  carpeta todavía no existía (nada procesado aún).
- Cada actualización de la cola reenviaba la lista completa a la ventana
  sin límite de frecuencia (con lotes grandes podía congelar la interfaz),
  y volvía a insertar TODOS los elementos del DOM en cada actualización en
  vez de solo los nuevos.
- Código muerto: `walkImages` exportado sin usarse fuera de su archivo,
  `DEFAULT_SETTINGS` exportado sin usarse, y en el renderer `listBatches`,
  `revealFile` y `formatBytes` expuestos pero nunca llamados desde ningún
  lado — se quitaron.

**Sobre la duda de "no quiero que se guarde en OneDrive/iCloud":** Compacta
nunca decidió guardar nada ahí — `Documentos` ya estaba redirigida a la
nube por una configuración del propio Windows/Mac, ajena a la app. El
aviso de 7.8 y el registro interno de 7.7 no cambian dónde se guardan las
fotos (siguen en `Documentos\Compacta`, igual que siempre); el registro
interno vive en la carpeta de datos de la app (no en Documentos)
únicamente como respaldo de memoria interna, no hay ninguna copia nueva de
fotos ahí.

### 7.10 — Dos bugs de uso real con la 1.0.4, y revisión de rendimiento en lotes grandes (v1.0.5)

Tras instalar y probar la 1.0.4 de verdad (un lote con la misma foto de
cámara duplicada muchas veces, para forzar un lote grande), se reportaron
dos problemas: la barra espaciadora "para detener" en realidad reabría un
selector de carpeta/archivos sin avisar, y la app iba extremadamente lenta,
con un recuadro grande y con flecos de color superpuesto a la lista de
fotos. Los dos quedaron reproducidos con una prueba automatizada que falla
contra el código de la 1.0.4 y pasa con la corrección (ver más abajo de cada
uno), no solo "se probó a mano y pareció que sí".

**El espacio "para detener" reabría el selector de carpeta.** La corrección
de 7.9 para el atajo de espacio (`isInteractiveTarget`) apartaba el atajo
global de CUALQUIER `<button>` enfocado, asumiendo que "ya reacciona solo al
espacio". Es cierto para el botón que se acaba de pulsar con el ratón — pero
ahí está el problema: a diferencia de Firefox/Safari, **Chromium deja el
foco en el último botón pulsado con el ratón**. Si ese botón era, por
ejemplo, "Elegir carpeta" (que además vive dentro de la zona de arrastrar,
como sus demás botones internos), la siguiente vez que se pulsaba espacio
para Detener/Reanudar, el atajo global se apartaba por ser un `<button>`, y
el espacio quedaba libre para su comportamiento nativo por defecto: volver a
activar ESE MISMO botón. Resultado: pulsar espacio no detenía nada y en
cambio reabría el selector de carpeta (o de archivos, o intentaba abrir la
carpeta de salida — lo que fuera que se hubiese tocado por última vez), sin
relación con lo que se quería hacer. Había, además, un segundo problema
emparentado: el manejador de teclado de la propia zona de arrastrar
(`dropzone.js`) escuchaba `keydown` en el contenedor entero, así que un
espacio que burbujeaba desde un botón interno también lo interceptaba, y
SIEMPRE forzaba un clic en "Elegir archivos" sin importar cuál de los dos
botones internos tuviera de verdad el foco.

Corrección: los botones ya no se excluyen del atajo global (`app.js`); en
su lugar, se llama `preventDefault()` en el `keydown`, lo que anula el clic
nativo por espacio de cualquier botón que tuviera el foco, y el atajo
siempre actúa igual (Detener/Reanudar) sin importar dónde quedó el foco. La
única excepción real es la zona de arrastrar (`#dropzone`) recibiendo el
evento directamente en sí misma (no burbujeado desde un botón interno) —
ese caso lo sigue resolviendo su propio manejador, ahora con un chequeo de
`e.target` para no reaccionar a botones internos. Prueba de regresión:
`tests/ui-test-electron.js`, tres pruebas nuevas que enfocan
sucesivamente "Elegir carpeta", "Elegir archivos" y "Abrir carpeta de
salida" y confirman que el espacio alterna la cola sin disparar esos
botones.

**Miniaturas de la cola: lag severo y corrupción visual con lotes
grandes.** La corrección de 7.9 arregló que las miniaturas cargaran (el
problema del host vacío en la URL), pero lo que cargaban seguía siendo el
**archivo original completo** — un JPEG de cámara de varios MB y varios
miles de píxeles de lado, decodificado entero solo para dibujar un círculo
de 38px. Con una sola foto no se nota; con un lote de decenas o cientos de
copias de la misma foto grande (el caso real reportado), eso es decodificar
cientos de imágenes gigantes de golpe nada más aparecer en la lista — de
ahí el lag severo, y con toda probabilidad también el recuadro con flecos
de color visto encima de la lista (síntoma típico de quedarse sin memoria
de vídeo al decodificar de golpe demasiadas texturas enormes).

Corrección: nuevo módulo `src/main/processor/thumbnail.js`, que genera con
`sharp` una miniatura real de 96×96px (el doble del tamaño visible, para
verse nítida en pantallas de alta densidad) y la guarda en caché en disco,
en `<datos de usuario>/thumbnails/`, nombrada con un hash de la ruta de
origen. El protocolo de miniaturas se separó en dos esquemas en
`protocol.js`: `compacta-file://` (el original, ahora sin uso propio pero
que se conserva para la vista previa antes/después a tamaño completo de
MEJORAS.md, que si necesitará la imagen entera) y `compacta-thumb://`
(nuevo, el que de verdad usa la cola), que sirve la miniatura cacheada en
vez del archivo original. Prueba de regresión:
`tests/thumbnail.test.js` (generación, caché, condición de carrera, archivo
corrupto) y una prueba nueva en `tests/ui-test-electron.js` que importa
fotos de 3000px de ancho y confirma que el `<img>` mostrado mide menos de
la décima parte de eso — sin la corrección, esa prueba falla mostrando
"3000px" tal cual.

**Lecturas y escrituras síncronas de disco en cada foto procesada.**
Revisando el resto del pipeline en busca de más causas de lag en lotes
grandes, se encontró que tanto `settings-store.js` (`loadSettings()`) como
`manifest-store.js` (`markDone`/`isMarkedDone`) releían y —en el caso del
manifiesto— también volvían a parsear el archivo entero desde disco, **de
forma síncrona y bloqueante**, en cada una de esas llamadas — y
`queue-manager.js` llama a ambos por cada foto que termina de procesar, no
una vez por lote. El manifiesto, además, solo crece con el uso de la app,
así que ese costo empeora con el tiempo. Los dos ahora mantienen su
contenido en memoria durante toda la sesión del proceso (una sola lectura
al arrancar) y siguen escribiendo a disco de inmediato en cada cambio, para
no perder nada si la app se cierra a mitad de un lote. No se detectó
ninguna prueba existente que dependiera de releer el archivo sin recargar
el módulo, así que este cambio no requirió tocar ninguna prueba previa.

### 7.11 — Lo reportado tras instalar la 1.0.5, y un sonido pedido (v1.0.6)

**La miniatura: se decidió quitarla, no seguir persiguiendo el bug.** La
1.0.5 (ver 7.10) sustituyó el archivo original por una miniatura real de
96×96px generada con `sharp` y cacheada en disco — y quedó verificado con
pruebas automatizadas que eso es justo lo que hacía (dimensiones e imagen
en caché confirmadas por código, no solo "se vio bien a ojo"). Aun así, en
uso real sobre Windows se seguía viendo mal: una imagen ajena (de otra foto
o de otro origen) apareciendo estirada y con flecos de color por encima de
varias filas de la lista a la vez. Como esto no se pudo reproducir en esta
máquina de desarrollo (no hay forma de replicar el hardware/driver de
vídeo exacto del usuario desde aquí), seguir "corrigiendo a ciegas" sin
poder verificar el resultado habría sido apostar, no depurar. Se optó por
la alternativa que el propio reporte planteaba como aceptable: quitar la
vista previa de la foto del todo. Ahora cada fila de la cola muestra un
icono genérico (un dibujo SVG fijo, igual para todas las fotos, sin
relación con el contenido de ninguna) — no hay ningún `<img>` en la cola,
nada que decodificar ni que componer aparte del propio anillo de progreso,
así que esta categoría entera de bug deja de ser posible. Se retiraron
también, por quedar sin uso, el módulo `processor/thumbnail.js`, el
esquema `compacta-thumb://` del protocolo y `getThumbsDir()` de
`paths.js` — no tiene sentido mantener código para generar algo que ya no
se muestra. Prueba: `tests/ui-test-electron.js` confirma que no existe
ningún `<img>` dentro de la lista de la cola y que el icono es
exactamente el mismo SVG en todas las filas.

**El aviso de OneDrive/iCloud: la "X" sí funcionaba, el área de clic era
el problema.** Se sospechó primero de un bug de logica o de persistencia
(¿se guarda de verdad el descarte?), pero una prueba con un clic de RATÓN
real —coordenadas + `mouseDown`/`mouseUp`, no `.click()` por JavaScript,
que salta el "hit test" del navegador y por tanto no podría detectar este
tipo de problema— confirmó que el botón funciona y que el descarte
sobrevive a cerrar y reabrir la ventana. El problema real: el área
clicable era casi exactamente el ancho del carácter "×" (18px de fuente
más 2px de relleno a cada lado) — un blanco pequeño y fácil de fallar por
un par de píxeles, lo que se siente exactamente como "no funciona" aunque
funcione. Se amplió el área de clic a un cuadrado de 28×28px centrado en
el símbolo, sin cambiar cómo se ve. De paso, esto deja un recordatorio
general para el resto de la interfaz: `.click()` en las pruebas no prueba
que un botón sea clicable de verdad, solo que su código funciona si se
llega a ejecutar.

**Notificaciones con aspecto de "electron.app.Compacta".** En Windows,
Electron necesita que se le indique explícitamente la identidad de la app
(`app.setAppUserModelId`, con el mismo id que el `"appId"` del empaquetado)
para poder asociar el proceso en ejecución con el acceso directo instalado
y así mostrar el nombre y el icono correctos en las notificaciones. Sin
esa llamada, Windows no tiene forma de saber a qué app pertenece la
notificación y cae en la identidad interna por defecto de Electron. Se
añadió la llamada al arrancar `index.js`, leyendo el id directamente de
`package.json` para que nunca pueda quedar desincronizado del valor real
de empaquetado. (Nota aparte, no un bug: ese id sigue siendo el de
plantilla `com.tuempresa.compacta` — cuando haya un nombre de organización
definitivo, es cuestión de cambiarlo en un único sitio, `package.json`.)

**Sonido al terminar un lote (pedido, no reportado como fallo).** Se
sintetiza con la Web Audio API (dos tonos breves y ascendentes con una
envolvente suave) en vez de empaquetar un archivo de audio — nada que
pueda quedar mal referenciado ni pesar espacio de más. Suena en el mismo
momento en que aparece el aviso verde dentro de la app, así que hereda el
mismo criterio de "no molestar" en lotes pequeños que ya tenía ese aviso
(ver 7.9). El `AudioContext` se crea perezosamente (no al cargar la
página, porque los navegadores no dejan arrancar audio antes de una
interacción del usuario) y cualquier fallo se ignora en silencio: el
sonido es un extra y nunca debe poder romper el aviso visual.

### 7.12 — La 1.0.6 no arrancaba: "Cannot read properties of undefined (reading 'appId')" (v1.0.6, hotfix)

**Esto es la segunda vez que pasa algo de esta misma familia, así que
conviene decirlo sin rodeos.** La corrección de la notificación en 7.11
(`app.setAppUserModelId(require('../../package.json').build.appId)`) pasó
las 64 pruebas unitarias y las 25 de interfaz de esa versión y aun así la
app instalada NO ARRANCABA: nada más abrirla, Electron mostraba un cuadro
de error de "Uncaught Exception" con `TypeError: Cannot read properties of
undefined (reading 'appId')` en `index.js:17`, y la app se quedaba ahí —
inservible para cualquiera que la instalara.

**Causa exacta.** `electron-builder` QUITA los campos `"build"`,
`"scripts"` y `"devDependencies"` del `package.json` que copia dentro de
`app.asar` — son metadatos de la construcción del instalador, no de la app
en sí, y no los necesita nadie en tiempo de ejecución. Se comprobó
extrayendo el `.asar` real ya construido:

```
$ node -e "console.log(require('./app.asar/package.json'))"
{ name: 'compacta', productName: 'Compacta', version: '1.0.6',
  description: '...', author: '...', license: '...', main: '...',
  dependencies: {...} }              // <-- sin "build" en absoluto
```

`require('../../package.json').build.appId` funcionaba perfectamente en
desarrollo (donde `package.json` está completo) y fallaba SOLO en la app
ya instalada — exactamente el tipo de diferencia que ninguna prueba
anterior podía detectar, porque **todas** las pruebas de este proyecto
(las 71 de `npm test` y las de `npm run test:ui`) corren sobre el código
fuente sin empaquetar, nunca sobre el `.asar` real que es lo que de verdad
recibe quien instala la app.

**Esto es la misma clase de problema que el de las miniaturas en 7.11**,
aunque de causa distinta: en los dos casos, algo quedaba verificado y
"correcto" en el entorno de desarrollo y fallaba solo en la app tal como
llega a quien la usa. La diferencia importante es que aquella vez la causa
era específica de un hardware que no se podía reproducir (una GPU
concreta); esta vez la causa era 100% determinista y reproducible en
cualquier máquina — simplemente nunca se había ejecutado el `.asar`
empaquetado ni una sola vez antes de darlo por bueno. Ese es el fallo de
proceso real a corregir, no solo la línea de código.

**Corrección del síntoma.** El id se escribe ahora a mano en un módulo
propio, `src/main/app-id.js`, con un comentario explicando por qué
(exactamente esta historia) para que a nadie se le ocurra "simplificarlo"
volviendo a leerlo de `package.json`. Una prueba unitaria nueva,
`tests/app-id.test.js`, compara ese valor contra `package.json` (el
código fuente, no el empaquetado) para que los dos no puedan
desincronizarse con el tiempo.

**Corrección de fondo: probar el `.asar` real, no solo el código
fuente.** Se añadió `tests/packaged-smoke-test-electron.js`, que:
1. Da por hecho que ya existe un build Linux "dir" (`npm run
   build:linux-dir` — no necesita wine, tarda menos de un minuto, y usa el
   mismo `electron-builder` y el mismo proceso de empaquetado que generan
   el instalador de Windows real, con el mismo `package.json` recortado).
2. Hace `require()` de `src/main/index.js` **desde dentro del `.asar`**
   generado — la misma ruta de código exacta que ejecuta la app instalada,
   ni una línea del código fuente sin empaquetar.
3. Comprueba que el proceso principal no lanza ninguna excepción, que
   llega a abrirse una ventana, y que la página carga con `window.api`
   disponible.

Se comprobó que esta prueba SÍ detecta el bug exacto que llegó a manos del
usuario: reconstruyendo el `.asar` con la línea de código de antes de este
arreglo, la prueba falla mostrando textualmente `Cannot read properties of
undefined (reading 'appId')` — el mismo mensaje del cuadro de error
original. Con la corrección, la prueba pasa. `npm run test:packaged`
(tras `npm run build:linux-dir`) debe correrse siempre antes de generar
cualquier instalador para distribuir, no solo `npm test` y `npm run
test:ui`.

### 7.13 — El aviso de OneDrive "no se cerraba", varias carpetas, ZIP y una pasada de rendimiento (v1.0.7)

**El aviso de OneDrive/iCloud: la causa real.** Reportado tras la 1.0.6:
"aun pulsando la X no funciona, se queda allí". La 1.0.6 ya había tocado
esto y lo dio por arreglado ampliando el área de clic de la "X". No era
eso. La "X" siempre funcionó: ejecutaba su código, ponía la clase `hidden`
en el aviso y guardaba que ya se había cerrado. Lo que fallaba es que
`hidden` no tenía ningún efecto visible: la hoja de estilos tenía
`.hidden { display: none }` en la línea ~447 y `.cloud-banner { display:
flex }` en la ~452. Las dos reglas tienen la misma especificidad y en ese
caso gana la que va después, es decir, el `flex`. Por eso el aviso nunca se
podía ocultar, con clic de ratón o como fuera.

Por qué la prueba de la 1.0.6 no lo detectó: comprobaba que el elemento
tuviera la clase `hidden`, que sí la tenía, en lugar de comprobar que se
dejara de ver. Es la misma familia de fallo que 7.9 y 7.12: una prueba que
verifica el mecanismo en vez del resultado. Ahora comprueba el resultado
(`getComputedStyle(...).display` y la altura real), y se verificó que **esa
prueba falla con el CSS antiguo y pasa con el arreglo**. Además hay una
prueba unitaria que vigila que la regla lleve `!important`.

Arreglo: `.hidden:not(.toast) { display: none !important; }` como única
regla para ocultar. El `toast` queda fuera porque se oculta con un fundido
(`opacity`) y tiene su propia regla.

**Varias carpetas.** El selector de carpetas usa ahora `multiSelections`
(Ctrl/Cmd + clic); arrastrar varias ya funcionaba. Carpetas con el mismo
nombre se reservan con `mkdir` sin `recursive` (`Fotos`, `Fotos (2)`...),
que es atómico: antes se comprobaba con `existsSync` y se creaba después,
y dos importaciones simultáneas podían acabar mezcladas.

**ZIP** (`src/main/zip-extractor.js`, dependencia nueva `yauzl`, JavaScript
puro, sin binarios nativos):
- Se pueden soltar, elegir con el botón "Elegir ZIP", o venir dentro de una
  carpeta; también ZIP dentro de ZIP (hasta 3 niveles).
- Lectura en streaming: un ZIP de varios GB no se carga en memoria.
- Solo se extraen imágenes compatibles. Basura de macOS/Windows
  (`__MACOSX`, `._foto.jpg`, `.DS_Store`, `Thumbs.db`) se ignora sin avisar.
- Zip-slip: cada nombre se parte en segmentos, se limpia y se recompone
  siempre dentro de la carpeta destino (más la comprobación propia de
  `yauzl`). Hay una prueba con una entrada `../../evil.jpg`.
- Bombas de descompresión: límites de entradas (200.000), tamaño por
  imagen (4 GiB) y total (40 GiB), y profundidad de anidado.
- Escritura atómica (temporal + renombrar): si la app se cierra a mitad,
  nunca queda una foto a medias en `input/`.
- Un ZIP roto, con contraseña o demasiado grande no detiene el resto de la
  importación: se avisa con el motivo ("El ZIP "x.zip" está dañado…").
- Limitación conocida: un ZIP que ya trae una carpeta raíz con su propio
  nombre acaba en `input/<nombre>/<nombre>/...`. Es feo pero inofensivo: la
  salida replica la misma estructura.

**Soltar fuera del recuadro.** Antes solo el recuadro punteado aceptaba
`drop`. Soltar una foto un poco fuera hacía que Electron *navegara* a ese
archivo y la ventana de la app se convertía en un visor de imagen. Ahora
toda la ventana acepta archivos (y solo reacciona a arrastres de archivos).

**Rendimiento — qué se midió y qué se hizo.** Lote de 180 fotos JPG de
6 megapíxeles (2,3 MB cada una), mismo equipo, 1.0.6 contra 1.0.7:
195,6 s contra 22,5 s (8,7× más rápido) **en una máquina de un solo núcleo**,
así que la mejora de paralelismo (abajo) no cuenta en esa cifra.

1. *El cuello de botella dominante era `mozjpeg: true`.* Medido por
   separado: 1099 ms por foto con mozjpeg contra 116 ms con libjpeg-turbo,
   para ahorrar solo un ~7% más de tamaño (1,19 MB contra 1,28 MB, a la
   misma calidad). Es 9,5× más lento por un 7% de ahorro. Ahora el modo por
   defecto es libjpeg-turbo con codificación Huffman optimizada, y mozjpeg
   queda como interruptor **"Compresión máxima (más lenta)"** en Ajustes,
   guardado por perfil. Es un cambio de comportamiento que conviene tener
   presente: con los ajustes por defecto, los JPG pesan ~7% más que en la
   1.0.6 a cambio de procesarse ~10× más rápido; quien prefiera lo contrario
   activa el interruptor.
2. *AVIF con `effort: 4`:* 13 s por imagen; con `effort: 3`, 1,3 s con el
   mismo tamaño. Cambio sin contrapartida.
3. *La cola era O(n²).* Cada evento construía la lista entera de trabajos
   (aunque la ventana recibe como mucho un envío cada 120 ms), y cada foto
   reclamada recorría la lista buscando "el siguiente pendiente". Ahora hay
   un cursor (O(1) amortizado) y el aviso de cambio no copia nada;
   `getSnapshot()` se construye solo cuando se va a enviar. 50.000 trabajos
   se reclaman en menos de 0,5 s (hay prueba).
4. *Importación.* Antes: `fs.cp` + `statSync` por archivo + un segundo
   recorrido del árbol, y la cola **no empezaba hasta terminar de copiar
   todo**. Ahora: un solo recorrido, copias en paralelo (con clonado
   `reflink` si el disco lo permite) y las fotos se encolan carpeta a
   carpeta mientras se sigue copiando. Se entrega por carpeta completa y no
   foto a foto porque el compresor mira a las demás imágenes de la misma
   carpeta para que `foto.jpg` y `foto.png` no se pisen. El orden se
   conserva.
5. *Detección de nombres repetidos:* se leía la carpeta entera para cada
   foto (5.000 fotos en una carpeta = 25 millones de comparaciones). Ahora
   se lee una vez y se invalida con el `mtime` de la carpeta.
6. *Manifiesto de "ya procesado":* se reescribía entero y de forma síncrona
   tras cada foto. Ahora se escribe con retardo de 400 ms, de forma
   asíncrona y atómica, y se fuerza la escritura cuando la cola se vacía o
   se detiene y al salir. Lo peor que puede pasar con un corte de luz es
   perder las marcas de los últimos 400 ms, y esas fotos se reconocen igual
   porque ya están en `output/`.
7. *Paralelismo:* antes tope fijo de 4 aunque el equipo tuviera 12 núcleos.
   Ahora `min(núcleos − 1, RAM / 2 GiB, 8)`: aprovecha más núcleos sin
   arriesgarse a quedarse sin memoria con fotos muy grandes. El grupo de
   hilos de libuv pasa a `max(8, trabajos + 4)` para que importar mientras
   se comprime no se quede esperando detrás de las fotos.
8. *Interfaz:* las filas de la cola que no cambian ya no se tocan (antes se
   reescribían todas en cada envío), las nuevas se insertan de una vez y se
   usa `content-visibility: auto` para no pintar las que no se ven. Con más
   de 2.000 trabajos los envíos se espacian a 300 ms.
9. Dos fallos latentes de paso: `push(...lista)` revienta con ~100.000
   elementos (ahora bucle), y dos archivos sueltos con el mismo nombre desde
   carpetas distintas se pisaban en el lote (ahora se renombran).

**Verificación.** 94 pruebas unitarias; 29 pruebas de interfaz en Electron
real con pantalla virtual (incluyen varias carpetas, ZIP, ZIP roto, soltar
fuera del recuadro y la "X" comprobando lo que se ve); y `test:packaged`
sobre el `.asar` real, ampliado para importar un ZIP y una carpeta a través
del paquete (comprueba que `yauzl` va dentro). Las pruebas de teclado de la
interfaz necesitan un lote lento y ahora la compresión es rápida, así que
ese lote usa a propósito "Compresión máxima".

### 7.14 — Videos, todos los comprimidos y una reorganización del código (v1.0.8)

**Aviso importante sobre las versiones.** El instalador `Compacta Setup
1.0.7.exe` NO comprime videos: se compiló antes de empezar con ellos. Quien
probó videos con ese instalador vio que "no los reconocía", y era lo
esperado. Los videos llegan en la 1.0.8.

**Por qué ffmpeg y no un compresor propio.** Comprimir video con calidad
exige un codificador (H.264/H.265). Electron no trae uno utilizable, y
escribir uno propio en JavaScript sería lento y de peor calidad. Se usa el
paquete `ffmpeg-static`, que lleva el binario dentro del instalador: la
persona no instala nada aparte. Es la única dependencia nueva para video
(la licencia GPL de ffmpeg viaja en `ffmpeg.LICENSE`). Efecto colateral: el
instalador pasa de ~86 MB a ~108 MB.

**Cómo se traduce "calidad" a video** (`video-optimizer.js`):
- Codificación por calidad constante (CRF): la barra de calidad (60–100) se
  convierte en CRF (90, la opción por defecto, = CRF 20, indistinguible a
  simple vista; medido: SSIM ≈ 0,996). "Modo agresivo" resta el mismo tramo
  de calidad que en JPEG; "Compresión máxima" usa un preset más lento (busca
  mejor, no baja la calidad).
- Nunca se reescala ni se tocan los fotogramas por segundo (incluido el
  variable de los móviles); se conservan metadatos, capítulos y todas las
  pistas de audio.
- HEVC o color de 10/12 bits (HDR de iPhone) se recodifica en HEVC con 10
  bits: pasarlo a H.264 de 8 bits lo dejaría apagado. Siempre en 4:2:0,
  único submuestreo que reproducen televisores, móviles y Windows (un ProRes
  4:2:2 o un 4:4:4 se reducen a 4:2:0: es la única pérdida de este caso).
- El audio AAC/MP3 se copia sin recodificar. Otros formatos (Opus, AC3, WMA…)
  pasan a AAC porque MP4 no los admite.
- Vídeo entrelazado (cámaras, DV, TV): se desentrelaza con `yadif`, si no el
  movimiento se vería peinado. Ancho o alto impar: se añade 1 píxel de borde
  en vez de recortar.
- Si el resultado no ahorra al menos un 5 %, se conserva el ORIGINAL intacto
  (copia byte a byte): un video ya bien comprimido apenas encoge y cada
  recodificación con pérdida acumula degradación.
- Un archivo que no es un video válido da error claro y no deja temporales.

**Formatos de video** (25): mp4, m4v, mov, qt, mkv, webm, avi, divx, wmv,
asf, flv, f4v, mpg, mpeg, mpe, m2v, vob, 3gp, 3g2, mts, m2ts, mxf, ogv, dv,
rm, rmvb. Todos salen como `.mp4`. No se incluye `.ts` a propósito (en
carpetas de programación es TypeScript). Un test comprueba que cada
extensión soportada tiene una prueba con un clip real de ese formato.

**La cola** (`queue-manager.js`): carril de fotos (paralelo, como antes) y
carril de video con UN solo worker (ffmpeg ya reparte cada video entre todos
los núcleos; dos a la vez solo se pelearían y gastarían el doble de
memoria). Un video largo no frena a las fotos ni al revés. El proceso corre
con prioridad por debajo de lo normal para que la interfaz siga fluida, y la
fila muestra un anillo que se llena con el porcentaje real.

**Comprimidos.** ZIP con el extractor propio (ya verificado en 7.13). RAR,
7z, tar, tar.gz/tgz, tar.bz2/tbz, tar.xz/txz y .cbz/.cbr/.cb7 con el `tar`
que YA trae el sistema (en Windows `System32\tar.exe`, en macOS
`/usr/bin/tar`): es bsdtar/libarchive y entiende todos esos formatos, así
que no hay nada que instalar ni empaquetar. Se extrae a una carpeta
temporal (`input/.extract`), solo se importa lo que es foto, video u otro
comprimido, y la temporal se borra siempre (y al arrancar, por si el cierre
fue forzado). Seguridad: bsdtar rechaza `..` y rutas absolutas; no se siguen
enlaces simbólicos; se vigila el tamaño mientras extrae y se corta si pasa
del límite (bomba de descompresión); comprimidos anidados de hasta 3
niveles y de formatos mezclados (un RAR dentro de un ZIP y al revés).
Contraseña, archivo dañado o `tar` ausente se avisan con el motivo.
Limitaciones: RAR/7z con contraseña o en varios volúmenes no se abren, y
estos formatos dependen del `tar.exe` de Windows 10/11 (no probado en un
Windows real, solo con bsdtar 3.7 de Linux, que es el mismo motor).

**Reorganización.** `file-manager.js` (407 líneas, cinco responsabilidades)
se dividió en `importer.js`, `media-walker.js`, `import-context.js` y el
propio `file-manager.js` (solo biblioteca: lotes, salida, pendientes,
limpieza). El procesador se separó en `formats`, `raster-optimizer`,
`video-optimizer`, `ffmpeg`, `output-files` y `child-processes`. Se
eliminó duplicación: `recordSkipped` y la escritura atómica estaban
copiados en dos módulos, y la sanitización de nombres se extrajo a
`file-names.js`. Se quitaron los exports que nadie usaba. Revisión de
código muerto: no había funciones sin uso ni canales IPC huérfanos.
Ningún archivo supera ~310 líneas. `styles.css` (~570 líneas) se dejó en un
solo archivo a propósito: partirlo no aporta nada a una hoja de estilos de
esa extensión y añade peticiones de carga.

**Fallos encontrados al probar con archivos reales** (ninguno se habría visto
con pruebas sintéticas):
1. El analizador de ffmpeg no reconocía como video un HEVC de 10 bits (las
   comas dentro de `yuv420p10le(tv, bt709…)` rompían el patrón): se habría
   copiado sin comprimir y en silencio. Ahora detecta códec, formato de
   píxel y resolución por separado.
2. La build estática de ffmpeg para Linux se cierra con SIGSEGV al leer
   MPEG-TS (.mts/.m2ts). No es un defecto de Compacta; el `ffmpeg.exe` de
   Windows (el que se empaqueta) los lee bien. Esos 2 tests se omiten solo
   en Linux, y de forma explícita (comprobando la señal), no "por si acaso".
3. Una prueba de interfaz dejaba filas en la cola al fallar y arrastraba a
   otra: ahora comprueba lo que se ve (un icono por fila, el del tipo).

**Corrección de una verificación.** En una primera pasada se afirmó que los
formatos de video se habían probado con el `ffmpeg.exe` de Windows; no era
cierto (la variable de entorno usada no existía y corrió el ffmpeg de
Linux). Se añadió `COMPACTA_FFMPEG_PATH` (sin ella no cambia nada) y se
repitieron las pruebas de video contra el `ffmpeg.exe` exacto del
instalador, bajo wine: pasan los 25 formatos, la calidad (SSIM), HEVC de 10
bits, archivos corruptos, sin audio, dimensiones impares y la cola.

**Verificación final.** 154 pruebas unitarias (2 omitidas, ver arriba), 31
de interfaz en Electron real (incluye un video comprimiéndose con su
porcentaje en pantalla y RAR/7z elegidos con el botón), y `test:packaged`
sobre el `.asar` real: procesa un ZIP, un RAR y 2 videos con el ffmpeg
empaquetado. El instalador de Windows se inspeccionó por dentro: lleva
`ffmpeg.exe` desempaquetado, el `sharp` de Windows y ningún binario de Linux.
No se pudo ejecutar el instalador en un Windows real.

**Empaquetado de ffmpeg.** (Reescrito en 7.15: lo que decía esta sección
sobre macOS dejó de ser cierto.) Ver 7.15.

### 7.15 — Mac (Intel y Apple Silicon), subtítulos y respaldo para RAR en sistemas antiguos (v1.0.8)

**Qué se pidió:** que lo de los videos y los comprimidos funcione también en
Mac, nuevos y viejos; que no se pierdan los subtítulos; y dejar escritas las
lecciones para no repetir errores.

**Límite de lo verificado: aquí NO hay ningún Mac.** No se pudo ejecutar
nada de macOS. Lo que sí se hizo, y se puede repetir: inspeccionar los
binarios por dentro (cabeceras Mach-O: arquitectura, versión mínima de macOS,
librerías enlazadas, firma), construir los paquetes de Mac desde Linux
(`electron-builder --mac dir --x64 --arm64`) y comprobar qué lleva cada
`.app`. Todo lo que dependa de ejecutar en un Mac real (que el sistema deje
lanzar el ffmpeg incrustado en una app sin firmar, el `tar` de un macOS
concreto) está SIN PROBAR y se marca como tal abajo.

**Matriz de compatibilidad medida** (cabeceras Mach-O, no suposiciones). **HISTÓRICA, de 1.0.x/1.1.0 (Electron 32): la vigente, con dos variantes de Mac, está en 7.25.**

| Equipo | App y fotos | Videos | Comprimidos |
|---|---|---|---|
| Mac Intel, macOS 10.15 (Catalina) o superior | Sí | Sí (ffmpeg pide 10.13) | Sí (ver RAR5) |
| Apple Silicon, macOS 12 o superior | Sí | Sí | Sí |
| Apple Silicon, macOS 11 (Big Sur) | Sí (app pide 11.0) | **No**: el ffmpeg de arm64 pide macOS 12.0 | Sí |
| Mac con macOS 10.14 o anterior | No: Electron 32 exige 10.15 | — | — |

- Apple Silicon con macOS 11 y videos: no se puede arreglar (parchear el
  binario invalidaría su firma, y arm64 exige firma válida; aquí no hay
  `codesign`). Se detecta ANTES de lanzar ffmpeg (`videoEngineProblem()`, por
  la versión de Darwin: macOS 12 = Darwin 21) y se muestra: "los videos
  necesitan macOS 12 o superior; actualiza, o instala la versión para Mac
  Intel (funciona también en Apple Silicon mediante Rosetta)". Las fotos y
  los comprimidos no se ven afectados.
- Mac con macOS ≤10.14: es un límite de Electron, no de Compacta. Soportarlo
  exigiría un Electron antiguo y sin parches de seguridad: no se recomienda.

**Cómo se empaqueta ffmpeg ahora** (cambió respecto a 7.14):
- `ffmpeg-static` pasó a **dependencia de desarrollo**: solo sirve para
  DESCARGAR binarios; ya no viaja dentro de la app.
- `scripts/prepare-ffmpeg.js <plataforma> <arquitectura>` deja cada binario
  en `vendor/ffmpeg/<plataforma>-<arquitectura>/` (con SU licencia). Trabaja
  en una copia temporal de `ffmpeg-static` porque los dos de Mac (x64 y
  arm64) se llaman igual y se pisarían. `vendor/` NO va en el repositorio ni
  en el zip (está en `.gitignore`: pesa ~290 MB) y se regenera solo.
- `extraResources` por plataforma copia `vendor/ffmpeg/<plat>-${arch}` a
  `<recursos>/ffmpeg/`. La macro `${arch}` hace que el `.app` x64 lleve el
  ffmpeg x64 y el arm64 el arm64 (verificado: SHA-256 idéntico al de `vendor/`).
  Sale del `.asar` (un ejecutable no se lanza desde dentro) y conserva el
  permiso de ejecución; además `getFfmpegPath()` hace `chmod 755` por si se
  perdiera.
- `predist:mac` prepara los dos binarios de Mac; `predist:win` el de Windows;
  `prebuild:linux-dir` el de Linux. Se disparan solos con `npm run dist:*`.
- Orden de búsqueda en `ffmpeg.js`: `COMPACTA_FFMPEG_PATH` → `<recursos>/ffmpeg`
  → `vendor/…` (desarrollo) → `ffmpeg-static` (desarrollo).
- Pendiente de comprobar en un Mac real: que un ffmpeg x64 sin firma, dentro
  de una app sin notarizar, se pueda lanzar tras aprobar la app. El arm64 sí
  lleva firma (`LC_CODE_SIGNATURE`); el x64 no la necesita para ejecutar.
  Al firmar la app en el futuro, el ffmpeg incrustado también hay que
  firmarlo (con "hardened runtime").

**Subtítulos: ya no se pierden** (`video-optimizer.js`, `planContainer()`):
- Subtítulos de **texto simple** (SRT, WebVTT, mov_text): dentro del MP4 como
  `mov_text`; no se pierde ni una línea.
- Subtítulos **ASS/SSA** (con estilos) o **de imagen** (PGS de Blu-ray,
  VobSub de DVD, DVB): el MP4 no puede guardarlos, así que ese video sale
  como **.MKV** copiándolos tal cual, con idioma, marca de "por defecto" y de
  "forzado", y las fuentes incrustadas. En MKV el audio también se copia sin
  recodificar, sea cual sea su formato.
- Los "closed captions" EIA-608 van dentro de la propia imagen y se conservan
  al recodificar; no se tratan como pista.
- `candidateOutputFileNames` incluye `.mkv` para que lo ya procesado se
  reconozca. Un video con subtítulos puede, por tanto, salir con otra
  extensión que el resto: es lo esperado.
- Limitación: los subtítulos en un **archivo aparte** (`pelicula.srt` junto a
  `pelicula.mkv`) no se tocan ni se copian a `output/`.
- Probado con clips reales (SRT en MP4 con idioma español; ASS+SRT en MKV con
  idiomas y marcas). El caso de imagen (PGS) solo se probó a nivel de
  argumentos: este ffmpeg no puede fabricar un PGS de prueba.

**Comprimidos en sistemas antiguos.** El `tar` de macOS 10.15/11 y de algunas
versiones de Windows 10 es una libarchive antigua que **no abre RAR5** (el
formato que crea WinRAR hoy por defecto). Respaldo: si el tar falla y la
persona tiene 7-Zip instalado (PATH, `C:\Program Files\7-Zip`,
`/opt/homebrew/bin`, `/usr/local/bin`; una app de macOS arranca con un PATH
mínimo sin Homebrew), se usa 7-Zip. Si nada puede abrirlo, el aviso dice la
causa real ("usa el formato RAR5, que este equipo no sabe abrir… vuelve a
comprimirlo como ZIP o 7z, o instala 7-Zip") en vez de un genérico "dañado".
Variables de diagnóstico: `COMPACTA_TAR_PATH`, `COMPACTA_SEVENZIP_PATH` (`none`
lo desactiva). Qué versión exacta de libarchive trae cada macOS no se pudo
verificar (de memoria: RAR5 llega con libarchive 3.4, que trae macOS 12 o
posterior): por eso el respaldo y el aviso existen. SIN PROBAR en un Mac real.

**Unicode en nombres (trampa típica de macOS).** Un nombre con tilde puede
estar guardado compuesto (NFC) o descompuesto (NFD); son el mismo nombre para
la persona pero distinto para una comparación de texto, y Compacta no
reconocería lo ya procesado y lo repetiría. Las comparaciones de nombres
(`findUnprocessedFiles`, detección de choques de nombre) pasan por
`foldName()` (NFC + minúscula). Solo para comparar, nunca para crear archivos.

**Revisión del código por cosas de Mac.** Ya estaban bien: rebote del Dock
(`app.dock.bounce`), barra de título `hiddenInset`, `activate` y
`window-all-closed` sin salir de la app, `COPYFILE_FICLONE` (clonado APFS, y
copia normal en HFS+), `os.setPriority`, y el `tar` en `/usr/bin/tar`. Los
`.app` de x64 y arm64 llevan las librerías nativas de `sharp` para ambas
(requisito mínimo medido: 10.13 en Intel, 11.0 en arm64).

**Bugs encontrados en esta tanda (y como se evitan).**
1. *`files` por plataforma SUSTITUYE al global.* En electron-builder, `win.files`
   / `mac.files` reemplazan a `files`, no se suman. Las nuestras solo tenían
   exclusiones, así que el `.asar` llevaba todo el proyecto (tests, scripts,
   documentos y, al aparecer `vendor/`, 290 MB de ffmpeg: instalador de 162 MB
   en vez de 108). Ya existía antes sin que se notara. Arreglo: cada
   plataforma repite `src/**/*` y `package.json`. Comprobación rápida:
   `npx asar list <app.asar> | awk -F/ '{print "/"$2}' | sort | uniq -c`
   debe mostrar solo `node_modules`, `src` y `package.json` (~800 KB).
2. *Detección de contraseña por la palabra "encrypt".* 7-Zip imprime siempre
   `Encrypted = -` (que significa NO cifrado): cualquier fallo se habría
   etiquetado "protegido con contraseña". Se usan frases concretas
   (`Wrong password`, `Cannot open encrypted archive`…).
3. *El motivo del error era la línea de copyright de 7-Zip.* Se elige la
   línea que explica el problema, no la primera de la salida.
4. *La frase útil de 7-Zip va una línea después de `ERROR: <ruta>`*: la
   contraseña se busca en TODA la salida, no solo en la línea elegida.
5. *7-Zip 23 no abre parte de lo que comprime RAR 7.0* (`Unsupported Method`;
   hace falta 7-Zip 24+). La prueba del respaldo usa un RAR sin comprimir.
6. *`package.json` sobrescrito por un comando de comprobación.* `npx asar
   extract-file <asar> package.json` EXTRAE EN LA CARPETA ACTUAL y pisó el
   `package.json` del proyecto con la copia del paquete (sin scripts ni
   `build`). Se reconstruyó desde una copia de seguridad. Regla: extraer
   SIEMPRE a una carpeta temporal (`cd /tmp/x && npx asar extract-file …`).

### 7.16 — Progreso global, vista previa, carpeta de salida, duplicados, subtítulos aparte y reordenar (v1.0.9)

Todo lo de esta sección se verificó en Linux (unitarias + Electron real con
pantalla virtual). Lo que concierne a Mac está SIN PROBAR en un Mac real: ver
`PRUEBAS-EN-MAC.md`, que lista cada función y cómo comprobarla.

**Progreso global y tiempo restante** (`batch-progress.js`, función pura).
Cada trabajo pesa lo que ocupa su archivo (bytes; los tamaños se leen en
segundo plano, 16 a la vez, con `stat`). Fotos y vídeos se estiman **por
separado** (cada carril va a su ritmo) y el lote acaba cuando acaba el más
lento: mezclarlos daba una estimación absurdamente optimista al principio,
cuando solo han terminado fotos. Mientras un carril con trabajo pendiente no
tenga ritmo medido, el tiempo es `null` ("calculando…"): no se inventa. No se
estima antes de 1,5 s activos. La pausa no cuenta (`_activeMs`/`_activeSince`
solo corren con workers en marcha). "Lote" = los trabajos añadidos desde que lo
anterior terminó del todo (`batchId`); los terminados de lotes viejos que sigan
en la lista no cuentan. La barra solo sale con 2 o más trabajos.

**Subtítulos en archivo aparte** (`processor/sidecars.js`, `import-sidecars.js`,
y los puntos de entrada en `media-walker`, `importer`, `zip-extractor` y
`system-archive`). `Peli.srt`, `Peli.es.srt`, `Peli.spa.forced.srt` acompañan a
`Peli.*` (extensiones: srt, ass, ssa, vtt, sub, idx, sup). `Peli 2.srt` NO es de
`Peli` (el sufijo exige un punto). Comparación con `foldName` (NFC +
minúsculas). Viajan con su vídeo al importar (carpeta, vídeo suelto —se buscan
en su carpeta de origen—, ZIP y tar) y se copian a `output/` con el nombre del
vídeo de SALIDA (puede cambiar de extensión y de nombre). Un subtítulo sin
vídeo cuenta como "no compatible". En un comprimido llegan en cualquier orden:
se guardan todos y al final se borran los huérfanos. Un subtítulo que no se
copia nunca hace fallar al vídeo.

**Omitir duplicados** (`duplicates.js`; ajuste `skipDuplicates`, activado por
defecto). Idéntico byte a byte a algo ya en `input/` o llegado antes en la
misma importación. Por etapas, de barato a caro: tamaño → huella del principio
y del final (1 MB cada uno) → SHA-256 completo. El detector se crea ANTES de
copiar nada (si no, lo nuevo se compararía consigo mismo). El duplicado ya
copiado se borra, junto con sus subtítulos huérfanos y las carpetas que
queden vacías. Los archivos vacíos nunca cuentan. Aviso al usuario con cómo
volver a procesarlo (desactivar el ajuste), porque es legítimo volver a
comprimir lo mismo con otros ajustes. NO afecta al pegado desde el portapapeles.

**Carpeta de salida elegible** (`output-dir.js`; `paths.js` ahora tiene un
"override" porque no puede depender de `settings-store`). Se valida: ruta
absoluta, no raíz de disco, no dentro de `input/`, no la que CONTIENE a
`input/` (p. ej. Documentos), que sea carpeta, y que se pueda ESCRIBIR (se
escribe y borra un archivo de prueba). Si la elegida deja de estar disponible
(disco externo desenchufado), se usa la de siempre y se avisa, SIN borrar la
elección (vuelve sola al reconectar). La comprobación se repite en cada
importación y al pegar del portapapeles. Cambiarla no repite trabajo: el
registro de "ya procesado" es por archivo de entrada. Lo ya procesado en la
carpeta anterior no se mueve (se avisa). Solo se cambia con `setOutputDir()`,
nunca con `saveSettings()`.

**Vista previa antes/después** (`preview.js`, `previewView.js`). Botón del ojo
solo en FOTOS terminadas. Se pide por id de trabajo (la ventana no decide qué
archivo se lee). Nunca llega la foto completa a la pantalla: `sharp` la reduce
a 1400 px, aplica la orientación EXIF y la entrega como JPEG en base64. Es un
modal bajo demanda, sin ningún `<img>` en la lista, por la mala experiencia de
las miniaturas (7.11). Se sueltan las imágenes al cerrar. Los vídeos no tienen
vista previa. **Riesgo pendiente de comprobar en equipos reales**: el defecto
visual de las miniaturas (imagen estirada con flecos de color) nunca se
reprodujo, así que no se puede asegurar que el modal no lo sufra.

**Reordenar la cola** (`queue-manager.moveJob`, `queueReorder.js`). Solo
pendientes entre pendientes. Los cursores de búsqueda se reinician (asumen que
nada anterior a ellos está pendiente). El snapshot trae `orderVersion` y la
pantalla solo recoloca las filas cuando cambia. Arrastrando el asa (HTML5
drag & drop, con tipo propio para no confundirse con arrastrar archivos desde
fuera) o con Alt + flecha desde el asa (en Mac, Option). Un reordenamiento
quita el foco del elemento movido: `queueView` lo devuelve al asa.

**HEIC / HEIF (fotos de iPhone): investigado en 1.0.9 y NO implementado. (RESUELTO en 1.1.0 por otro camino: libheif-js, ver 7.21.)** Con un HEIC
real (creado con `heif-enc` + x265): `sharp` lee los metadatos pero NO
decodifica (le falta el decodificador HEVC, que va aparte por patentes); el
ffmpeg 7.0 de Linux SÍ lo decodifica, pero el **ffmpeg 6.1.1 de Windows NO**
(`moov atom not found`: esa versión no lee HEIF). Los de Mac no se pudieron
probar. Como tendría que funcionar igual en las tres plataformas, queda sin
hacer. Camino posible: un ffmpeg de Windows 7.x (`ffmpeg-static` no lo ofrece:
habría que cambiar de proveedor de binarios) y comprobar los HEIC con
cuadrícula de teselas de iPhone. Mientras tanto se sigue avisando de que
conviertan a JPG.

**Revisión estática.** ESLint 9 ejecutado con `npx` (no se añade al proyecto)
sobre `src`, `scripts` y `tests`: sin variables sin definir, código
inalcanzable ni claves duplicadas. El único aviso (`Response` en
`protocol.js`) es un falso positivo de la lista de globales usada.

**Bugs y lecciones de esta tanda.**
1. *Dos JPEG de un color casi igual salen IDÉNTICOS byte a byte* (r=20 y r=21):
   una prueba de duplicados "fallaba" porque de verdad eran duplicados. Usar
   colores bien separados.
2. *Activar `skipDuplicates` rompió pruebas antiguas* que importaban el mismo
   archivo sintético muchas veces: se apaga explícitamente en las que no tratan
   de duplicados (`duplicates.test.js` cubre la función).
3. *Un aviso enviado al arrancar se pierde* si la página aún no cargó
   (`webContents.send` antes de `did-finish-load`). Los avisos de arranque usan
   `notifyRendererWhenReady`. El aviso "no se pudo revisar si quedaban pendientes"
   tenía ese mismo fallo desde antes.
4. *Mover un elemento del DOM le quita el foco*: tras Alt+flecha no se podía
   encadenar otra pulsación. Se devuelve el foco al recolocar.
5. *En las pruebas de interfaz, un clic real fuera de la ventana no llega a
   ningún sitio*: la fila de una foto nueva está al final de una cola larga;
   hay que hacer `scrollIntoView` antes de `realClick`.
6. *El `assert` de `ui-test-electron.js` es una función propia* (sin
   `.deepEqual`): usar el helper `deepEq` local.
7. *Una prueba fallida a medias puede dejar la cola en pausa* y provocar
   fallos en cascada en las siguientes: los tests que pausan reanudan siempre
   en un `finally`.
8. *El deslizador de la vista previa heredaba el ancho fijo del control de
   calidad* (regla global de `input[type=range]`): se necesita más especificidad.
9. *7-Zip 23 no abre parte de lo que comprime RAR 7.0* (también en 7.15).
10. *Dentro de Electron, `COMPACTA_TEST_BASE_DIR` se IGNORA*: `paths.js` usa
    `app.getPath('documents')` si hay `app`. Esa variable solo aísla las pruebas
    en Node a secas. Las pruebas que corren bajo Electron (`ui-test-electron.js`,
    `smoke-test-electron.js`, `packaged-smoke-test-electron.js`) deben aislar con
    `app.setPath('documents', <carpeta temporal>)`. La prueba de arranque
    (`smoke-test-electron.js`) no aislaba nada y trabajaba en los Documentos reales
    del equipo: con "Omitir duplicados", una segunda ejecución con las mismas fotos
    no importaba nada y esperaba para siempre un evento que no llegaba (colgada
    hasta agotar el tiempo). Síntoma a vigilar: una prueba que "se cuelga" justo
    tras activar una función que omite o deduplica.
11. *`waitFor`/esperas sin límite en pruebas de arranque ocultan fallos reales*:
    una importación que devuelve 0 archivos nunca emite `queue-idle`. Las pruebas
    deben comprobar primero que se importó lo esperado.

### 7.17 — Vista previa que no hacía nada, ventana sin maximizar, "omitir duplicados" que omitía todo, barra que retrocedía (v1.0.10)

Cuatro fallos reportados tras usar la 1.0.9, más dos mejoras de la lista. Todo se
reprodujo antes de tocarlo (capturas con Electron real bajo `xvfb`, simulaciones y
pruebas) y se verificó después con clics y arrastres de ratón de verdad.

**1. La vista previa "no hacía absolutamente nada".** Causas, todas reales:
- La compresión es casi invisible a la vista: reducida a 1400 px, la original y el
  resultado se ven iguales. El comparador no ofrecía forma de ver lo que de verdad cambió.
- El escenario era un marco de 62 vh con la foto centrada dentro (`object-fit: contain`)
  y el recorte (`clip-path`) se calculaba sobre el MARCO, no sobre la foto: con una foto
  vertical, medio recorrido del deslizador no tocaba la foto.
- No había línea ni tirador: nada decía que algo se pudiera mover, y el único control era
  un deslizador pequeño lejos de la imagen.
- Además los textos usaban `--text` y `--text-dim`, variables que NO existían (ver punto 5).

Ahora (`previewView.js`, `preview.js`): el escenario mide exactamente la proporción de la
foto; la línea tiene tirador y se arrastra con el puntero sobre la foto (también el
deslizador, que mide lo mismo que la foto); y **«Ver al 100 %»** (también doble clic o la
tecla Z) pide al proceso principal un **recorte sin reducir** de las dos fotos
(`buildDetail`, canal `preview:detail`), centrado donde estaba el ratón. Va como **PNG**
(un JPEG añadiría defectos propios), con `rotate()` ANTES de `extract()` (verificado con
una prueba de orientación EXIF: la zona se mide sobre la foto como se ve), con el tamaño
de la zona = el del escenario × `devicePixelRatio` (1 píxel de la foto = 1 píxel físico), y
con todos los valores de entrada acotados (la ventana nunca decide una ruta ni un tamaño
sin límite: `DETAIL_MAX_SIDE`). Un mapa pequeño con el recuadro de la zona permite moverla;
las peticiones se coalescen (gana la última). La vista general se codifica ahora con
calidad 92 y croma 4:4:4. **Vídeos**: el ojo también aparece; `buildVideoPreview` saca UN
fotograma (hacia el 10 %) del original y del resultado con ffmpeg a un temporal que se
borra; no hay detalle al 100 %. La barra espaciadora ya no pausa la cola con la vista
previa abierta.

**2. Con la ventana sin maximizar se veía mal.** Se midió: a 860×560 la zona de arrastrar
(~350 px fijos) dejaba la cola entera fuera de la pantalla; el panel de Ajustes no tenía
alto máximo (en una ventana baja, las últimas opciones eran inalcanzables); el encabezado
de la cola ("Eliminar pendientes"...) no se partía; las filas pendientes quedaban corridas
por el asa. Ahora: con algo en la cola `.app.has-queue` vuelve compacta la zona de arrastrar;
`.queue-section` ocupa lo que sobra y `.queue-list` hace su propio scroll (`min-height: 0`
en `.content`, que antes impedía encogerse); encabezados con `flex-wrap`; márgenes con
`clamp()`; Ajustes y diálogos con `max-height`/`overflow`; el asa reserva su hueco en todas
las filas (`visibility`). Mínimo de ventana 760 × 520 (antes 860 × 560). Prueba de interfaz
nueva a 760×520.

**3. "Omitir duplicados" omitía todo.** NO era un fallo del comparador (se comprobó con
20 fotos distintas: entran las 20; con las mismas otra vez, se omiten las 20). Era el
ALCANCE: `input/` no se vacía nunca, y se comparaba contra todo lo que alguna vez entró
ahí, incluidas pruebas de hace semanas o cosas cuya salida se había borrado. Ahora
(`duplicates.js`): es duplicado solo lo **idéntico byte a byte** a (a) algo llegado antes
en la MISMA importación, o (b) algo anterior cuyo resultado **sigue vivo** (`isLive`: está
en la cola sin error, o su resultado existe en `output/`, `file-manager.hasOutputFor`). Lo
anterior cuyo resultado ya no existe NO cuenta (y no se borra: podría ser de otra
importación en curso). Se cuentan aparte `duplicateInDrop` y `duplicateBefore` y el aviso
los distingue. **Fotos parecidas pero distintas**: nunca se omiten (a propósito no hay
comparación por parecido; se probó con una cara con la boca abierta y cerrada, la misma
foto a dos calidades y una ráfaga de 12). Un hash perceptual daría falsos duplicados justo
en esos casos; ver MEJORAS.md para la idea de solo *mostrarlas*. Lección: una función que
"mira lo anterior" necesita decir QUÉ anterior cuenta; `importPaths` recibe `isLive` y el
valor por defecto (todo cuenta) es solo para pruebas.

**4. La barra "avanzaba, retrocedía y volvía a avanzar" y el tiempo era impreciso.** Causas:
(a) importando carpeta a carpeta, la cola se vaciaba entre una y otra, y `addJobs` abría un
LOTE NUEVO (barra a 0 y reloj a 0; también se enviaba el aviso de "terminado" antes de
tiempo); (b) los tamaños se leen en segundo plano y cambian el peso de cada trabajo al
llegar; (c) "Limpiar completados" quitaba trabajos hechos del lote en curso (total y hecho
bajaban); (d) el progreso de un video podía dar un instante menos que el anterior. El tiempo
usaba el promedio de TODO el lote (con el arranque incluido) y saltaba con cada foto grande.
Ahora (`batch-progress.js`, `queue-manager.js`): `BatchTracker` guarda la memoria del lote;
`beginImport()`/`endImport()` mantienen el lote abierto mientras se importa (el aviso de
"terminado" espera a `endImport`); `clearFinished` pasa lo hecho a `retired`; la fracción
es monótona y nunca llega al 100 % mientras queda algo; el progreso de un video nunca baja.
**Tiempo**: ritmo = avance en los últimos ~20 s de tiempo activo (ventana deslizante),
medido sobre lo mismo que se descuenta de lo pendiente (primera versión: ritmo solo con lo
terminado y pendiente con "medio hecho" = error del 47 % al 25 % del lote; lo detectó la
simulación); la hora de fin se suaviza (constante 8 s) y la cuenta atrás baja con el reloj;
hace falta 2 s de historial y todos los carriles con trabajo con ritmo (si no, "calculando…").
Durante la importación se dice "al menos". La interfaz redondea (de 5 en 5 s, luego min) y
una barra "Terminado" retirada no reaparece sola. Pruebas con simulación (100 fotos, 4
trabajadores): error < 20 % desde el 25 % (o < 1,5 s en el tramo final), la barra nunca baja
y la cuenta atrás no sube de golpe.

**5. Variables CSS inexistentes.** Las piezas de 1.0.9 usaban `--text`, `--text-dim`, `--mono`
y el sistema solo definía `--text-primary/secondary/tertiary` y `--font-mono`. El navegador
ignora en silencio una `var()` sin definir. Se añadieron alias en `:root`. Lección: al añadir
CSS, buscar cada `var(--x)` nuevo en `:root`.

**Mejoras de la lista.** Vista previa de vídeos (arriba) y reordenar agarrando la FILA entera
(`li.draggable` solo en pendientes; el asa sigue siendo la pista visual y la vía de teclado).

**Entorno de pruebas.** `libarchive-tools` (bsdtar) y `p7zip-full` hacen falta para las pruebas de
comprimidos: con el `tar` GNU del sandbox falla UNA prueba (espera el mensaje de bsdtar,
"dañado"); con `COMPACTA_TAR_PATH=$(which bsdtar)` pasa. No es un fallo del programa.
`rar` no está disponible aquí (8 pruebas omitidas).

### 7.18 — Audio y arreglo de «Omitir duplicados» (v1.0.11)

**Petición.** (1) Que «Omitir duplicados» dejara de «no hacer nada»; (2) audio como función nueva: soltar un
audio de CUALQUIER formato (también los de Mac) y que se comprima; (3) seguir con las mejoras (sin Mac ni idiomas).

**Duplicados: qué se encontró.** NO se logró reproducir que falle la detección de copias idénticas: se probó
(`/tmp`, flujo real con cola y `hasOutputFor`) carpeta con copias, la misma carpeta otra vez, sueltos ya
procesados y fotos de 6 MB; todo se omite bien, y el instalador 1.0.10 llevaba el mismo `src/` que el fuente.
Sí se encontraron y corrigieron cuatro fallos reales que dan esa impresión:
1. Una excepción al comparar UN archivo (desapareció, antivirus) abortaba TODA la importación.
   Ahora `duplicates.js` lo trata como único (ante la duda se procesa).
2. **Coste cuadrático**: `isWorkAlive` buscaba en toda la lista de la cola por cada archivo y `hasOutputFor`
   releía el listado de la carpeta de salida por cada archivo. Con miles de archivos al volver a soltar una
   carpeta, la app se quedaba como colgada. Ahora `createLivenessCheck()` (ipc-handlers) crea UN conjunto con la
   cola y `hasOutputFor(ruta, dirCache)` lista cada carpeta una sola vez (prueba con 1500 archivos).
3. Pegar con Ctrl+V una captura repetida no hacía nada y no avisaba (`importClipboardImage` no recibía `isLive`
   ni devolvía los contadores). Ahora usa la misma comprobación y avisa.
4. El aviso era un toast de 5 s. Ahora es un aviso persistente (`#duplicatesNotice`) con **«Procesar de todos
   modos»**: `importPaths` devuelve `duplicateSources` (de dónde vino cada copia omitida; no existe para lo salido
   de un comprimido) y el proceso principal las recuerda (`lastSkippedSources`); `batches:import-skipped`
   reimporta con `allowDuplicates: true` SOLO para esa importación, sin tocar el ajuste (la ventana no manda rutas).
Si el fallo persiste en uso real, falta el escenario exacto: lo más probable es la misma foto REGUARDADA (WhatsApp),
que no es idéntica byte a byte y por decisión previa no se omite.

**Audio (`processor/audio-optimizer.js`).**
- `formats.js`: `AUDIO_EXTENSIONS` (>40, con .m4a/.m4b/.m4r/.aiff/.aif/.aifc/.caf), `isSupportedAudio`,
  `mediaKind` -> `'audio'`, `AUDIO_OUTPUT_EXTENSIONS` (para que «ya procesado» reconozca wav -> mp3).
- Se decide por el CODEC real (`ffmpeg.js` ahora devuelve frecuencia, canales, tasa de bits, portada y la tasa
  global), no por la extensión. `planAudio()` es una función pura; `buildAudioArgs()` también.
- Sin pérdida (pcm_*, flac, alac, wavpack, ape, tta, tak, truehd, mlp, dsd...) -> siempre MP3 (libmp3lame, VBR; 90 -> V2).
  Con más de 2 canales -> AAC conservando canales (`-b:a` con escala por canales). Con pérdida: misma familia
  (mp3->mp3, aac->m4a/m4b/m4r, vorbis->ogg, opus->opus; wma/ac3/dts/otros->mp3) y SOLO si
  `tasa de origen > tasa prevista × 1.15`; si no, copia intacta (`ya-optimizado`). Tras codificar, si no ahorra
  5 % se deja el original (`sin-mejora-posible`).
- Nunca sube de frecuencia; >48 kHz baja (a 44.1 o 48 según sea múltiplo); MP3 solo admite sus frecuencias.
- Etiquetas (`-map_metadata 0`), capítulos (`-map_chapters 0`), portada en MP3/M4A (se reintenta SIN portada si el
  muxer la rechaza: BMP/GIF). Varias pistas -> `.mka`. `listEncoders()` pregunta una vez qué trae ESE ffmpeg y,
  si falta libmp3lame/libopus/libvorbis, usa AAC (el ffmpeg de Mac podría no traerlos: sin verificar).
- Un `.mp4/.3gp/.webm/.mkv` sin pista de video pero con audio ya no se «copia sin tocar»: `optimizeVideo` delega
  en `optimizeAudio` (sale como `.m4a`; `candidateOutputFileNames` de videos incluye `.m4a`).
- Cola: tercer carril `'audio'` (hasta `MAX_AUDIO_WORKERS = 4` a la vez, no espera a videos ni fotos);
  `batch-progress.js` estima el carril de audio por separado (y tolera resúmenes viejos sin él).
- Interfaz: icono de nota, «Comprimiendo audio… N %», sin ojo de vista previa (`buildPreview` lo rechaza),
  textos y selector de archivos con audios.

**Verificado.** Unitarias: 309 (301 correctas, 8 omitidas por no haber `rar`), 0 fallos. Audio con archivos REALES de
~30 formatos generados con ffmpeg (decodifican enteros, duración conservada, etiquetas, portada, capítulos, 5.1,
96 kHz/24 bits, mono 8 kHz, corruptos, mismo nombre con otra extensión, voz en .3gp/.webm/.mkv/.mp4).
Interfaz real: 39/39 (incluye el aviso que se queda 5,6 s, el botón, la X, audios con icono y sin ojo, «Sin cambios»).
**ffmpeg.exe 6.1.1 del instalador bajo wine** (con `COMPACTA_FFMPEG_PATH=/tmp/ffmpeg-wine.sh`, un `exec wine …/ffmpeg.exe "$@"`
SIN `xvfb-run`: con él, llamadas seguidas fallan): pasaron 40 pruebas de formatos reales (wav, wave, flac, mp3, m4a,
ogg, opus, wma, ac3, w64, aiff, aifc, caf pcm/alac, wv, tta, aif, au, snd, mp2, aac, m4r, 3ga, oga, ligeros...), 5.1,
portada y capítulos. NO se repitieron bajo wine: MKA de 2 pistas, alta resolución, mono 8 kHz, calidad, corruptos,
mismo nombre, voz en contenedor de video, progreso y delegación desde video (sí pasan con el ffmpeg de Linux).
NO verificado: Windows real, Mac real (ver `PRUEBAS-EN-MAC.md` I).

### 7.19 — Audio más pequeño sin perder calidad, más formatos de vídeo (v1.0.12)

**Queja:** «los comprimidos de los audios apenas bajan el peso y se pierde calidad». Se midió antes de tocar
nada (voz real: JFK 44,1 kHz, LJSpeech; música real de calidad CD: 320 y 192 kbps; PESQ-WB y STOI para voz).

**Por qué pesaba tanto (causas reales, en `audio-optimizer.js` de 1.0.11):**
1. Un audio con pérdida ≤ 1,15 × el objetivo se copiaba intacto: casi todo MP3 de 128-192 kbps «no bajaba».
2. Estéreo con los dos canales iguales (o uno vacío) se guardaba en estéreo: el doble de bits, mismo sonido.
3. La portada se copiaba entera (`-c:v copy`): una de 2000-3000 px pesa más que una canción de 128 kbps.
4. El objetivo era el mismo para voz que para orquesta (V2 ≈ 190 kbps). Una voz necesita 3-4 veces menos.

**Qué se hizo (todo medido, ver abajo):**
- `processor/audio-analysis.js` (nuevo): `analyzeChannels` mide energía lateral/central (L-R vs L+R) en 1 o 3 trozos
  del archivo (20/50/80 %, 12 s cada uno) y decide `mix` (mono con la mezcla), `left`/`right` (el otro canal está vacío)
  o `stereo`. **Música: umbral −32 dB y manda el PEOR trozo** (basta uno con estéreo real para no tocar nada);
  voz: −15 dB. `estimateKbps` codifica esas mismas muestras con los ajustes elegidos, a un pipe, y devuelve los kbps reales.
- **Recodificar con pérdida solo si la prueba REAL ahorra ≥ 20 %** (`RECODE_MIN_SAVING`), no una tabla: LAME VBR pesa lo
  que pesa el propio sonido (una voz limpia a V2 son ~86-111 kbps, no 190). Opus/AAC son de tasa fija: usan su tabla.
- **Modo voz (`audioKind: 'voice'`)** es una ELECCIÓN de la persona (Ajustes, guardable en un perfil), **no se adivina**:
  separar voz de música por energía (silencios, modulación a 4 Hz) dio falsos positivos medidos (batería y piano suave
  salían como «voz», ruido de multitud como «música») y degradaría música. Solo los codecs que son SOLO voz
  (AMR, GSM, Speex, iLBC, G.723/729, RealAudio, Codec2) se tratan como voz solos. MP3 voz: 90 → V4 mono (PESQ 4,61-4,62
  sobre 4,64; 4,46 en voz de estudio de alta fidelidad), 100 → V2, 75 → V6 a 22,05 kHz (≈38 kbps, PESQ 4,58). Con calidad
  ≤ 80 la voz baja a 22,05 kHz. Opus de voz usa `-application voip` (32 kbps mono a 90).
- **Formato de audio** (`audioFormat`): `compat` (MP3/M4A/OGG/OPUS según el origen, como antes), `opus` (todo a Opus salvo
  más de 2 canales; **sin portada**: el muxer ogg no la guarda), `flac` (solo para lo SIN pérdida: bit a bit idéntico, sin tocar
  canales ni frecuencia; float → 24 bits; DSD y varias pistas no; FLAC→FLAC se salta; lo que ya tiene pérdida NUNCA va a FLAC).
  Cierra el pendiente «audio sin pérdida (FLAC)».
- **Portadas:** > 800 px o PNG/BMP/GIF/TIFF/WebP → JPEG de 600 px (`mjpeg -q:v 4`). Si el audio ya era óptimo y el contenedor
  lo permite (`.mp3`, `.m4a/.m4b/.m4r`, `.flac`), `planCoverOnly` copia el audio SIN recodificar (`-c:a copy`) y solo cambia
  la portada: MD5 del audio idéntico (verificado), etiquetas y capítulos intactos.
- **TRAMPA (bug real hallado y corregido): no usar `-frames:v 1` con la portada.** ffmpeg deja de escribir en cuanto sale ese
  fotograma y el audio se pierde (35 KB «válidos» de un MP3 de 1,2 MB; pasó la comprobación del 5 % de ahorro). Por eso además
  **toda salida de audio se verifica** (`isCompleteOutput`: abre, tiene audio y dura lo mismo ±max(1,5 s, 3 %)) antes de reemplazar
  nada; si falla, se deja el original.
- Cola: `report.detail` («mono», «voz · mono», «sin pérdida», «portada reducida») y los motivos de «Sin cambios»
  («ya estaba optimizado», «no se podía reducir sin perder calidad», «tiene varias pistas de vídeo…»).
- `ffmpeg.js`: `cover {codec,width,height}`, `extraVideoStreams`, `captureFfmpeg()` (stdout a Buffer).

**Medido (ffmpeg.exe del instalador bajo wine, idéntico al ffmpeg 6.1.1 de Linux):**

| Caso | 1.0.11 | 1.0.12 | PESQ-WB (orig. 4,64) |
|---|---|---|---|
| Predicación MP3 192k (estéreo duplicado), modo música | sin cambios | −55 % (87 kbps, mono) | 4,63 |
| Predicación MP3 128k (estéreo duplicado), modo voz | sin cambios | −45 % (71 kbps) | 4,62 |
| FLAC de voz estéreo duplicado | −89 % | −90 % (86 kbps) | 4,63 |
| El mismo, modo voz | — | −91 % (72 kbps) | 4,61 |
| El mismo, modo voz calidad 75 | — | −95 % (38 kbps) | 4,58 |
| LJSpeech 22 kHz, modo voz | — | −82 % (65 kbps) | 4,46 |
| MP3 320k música | −40 % | −40 % (igual) | — |
| MP3 192k música | sin cambios | sin cambios (correcto) | — |
| MP3 128k con portada de 2400 px | sin cambios | −76 %, audio idéntico | — |
| Música real: ¿se tomó por mono? | — | **no**, ninguna (lateral/central de −6 a −15 dB) | — |

**Lo que NO se puede hacer:** un MP3/M4A de música que ya está en 128-192 kbps no baja sin perder calidad audible; la única vía es
Opus (recodificar a otro códec con pérdida, −35 %, requiere reproductor moderno). Se dice así a la persona, no se disimula.
PESQ mide VOZ; **no hay escucha humana** ni métrica de música en estas pruebas (solo coherencia con 1.0.11 y que el modo por
defecto no cambió para música).

**Vídeo — más formatos (20 extensiones nuevas):** `.3gpp .3gpp2 .m2t .trp .tp .tod .vro .evo .m2p .dvr-ms .ogm .ivf .mk3d .nut
.mpv .m1v .mjpeg .mjpg .gxf .y4m`. Cada una tiene un clip real en `tests/helpers/make-video-formats.js` (la prueba exige uno por
extensión) y se comprueba contra el `ffmpeg.exe` real. **Excluidas a propósito:** `.ts` (TypeScript; detectarlo leyendo el
contenido obligaría a cambiar el recorrido de carpetas, los ZIP —donde solo hay nombres— y el importador), `.mod` (go.mod/tracker),
`.ps` (PostScript), `.dat`, `.264/.h264/.hevc` (sin contenedor: no traen su fps y saldrían a otra velocidad), `.insv/.360`
(dos lentes: se perdería una), `.swf`, `.wtv` (no hay muxer para generar un clip de prueba y no se puede verificar).
- Flujos en bruto (`RAW_VIDEO_EXTENSIONS`: `.m2v .mpv .m1v .mjpeg .mjpg`): declaran una duración absurda (0,02 s) → se tratan como
  «duración desconocida» (progreso sin porcentaje); el MP4 de salida es normal y completo.
- **Dos pistas de vídeo reales** (3D, ángulos) → `varios-videos`, se deja intacto (antes se perdía la segunda en silencio). No cuentan
  las miniaturas/portadas (codec de imagen o `attached pic`).
- **VP9 y AV1 → HEVC** (en H.264 casi siempre pesaban más y el resultado se descartaba tras minutos de trabajo). Compatibilidad: HEVC
  en un MP4 puede necesitar la extensión HEVC en Windows 10. Los WebM/AV1 descargados a menudo no se pueden reducir y quedan «Sin cambios».
- La prueba de codificación corta para saltar pronto vídeos ya optimizados se hizo en 1.0.13 (ver 7.20).

**Verificación 1.0.12:** 356 pruebas unitarias (345 pasan con ffmpeg-static; las 11 omitidas: 5 MPEG-TS que ese binario no sabe leer —pasan
con el ffmpeg del sistema—, 6 de RAR/formatos opcionales); 40/40 de interfaz en Electron real; **todo el audio (54 + 21) y los 20 formatos
de vídeo nuevos contra el `ffmpeg.exe` del instalador bajo wine**; el código del `.asar` es idéntico a `src/` (diff).
**NO verificado:** instalador en un Windows real, nada en Mac real, ninguna escucha humana.

### 7.20 — Rendimiento y limpieza del código (v1.0.13)

**Petición:** «optimizar código, quitar código muerto/basura, monolitos enormes, hacerlo más eficaz y la app más rápida».
Se midió antes de tocar nada.

**Auditoría (herramienta nueva `npm run audit` = `scripts/audit-code.js`):**
- 44 archivos en `src/`, ~8.200 líneas. **No hay monolitos**: el mayor JS (`queue-manager.js`) tiene 436 líneas
  (523 contando el renderer) y el CSS 737. Lo largo son unas funciones (ver la lista en `MEJORAS.md`).
- **Código sin uso: ninguno** (funciones, variables, imports, dependencias). Sobraban 8 `module.exports` que nadie importa;
  quitados (`MIN_ELAPSED_MS`, `SILENCE_DB`, `opusVoiceKbps`, `AUDIO_OUTPUT_EXTENSIONS`, `VIDEO_OUTPUT_EXTENSION`,
  `isSupportedAudio`, `SUBTITLE_EXTENSIONS`, `findSevenZip`).
- **Falsos positivos conocidos del análisis** (no tocar): `main/index.js`, `processor/index.js` y `preload/preload.js` son puntos
  de entrada; `queue-item--processing/done/error` se arman como `queue-item--${estado}`; los `console.log('[DEBUG…]')` de
  `main/index.js` solo salen con `COMPACTA_DEBUG` y los usan las pruebas.
- Refactor: `setupIpcHandlers` (164 líneas, una lista plana de 26 canales) → 6 funciones por tema (`registerQueueHandlers`,
  `registerImportHandlers`, `registerSettingsHandlers`, `registerOutputHandlers`, `registerPreviewHandlers`,
  `registerAppHandlers`) + `forwardQueueEvents`. Cuerpos movidos LITERALMENTE; se comprobó que los 26 nombres de canal son
  idénticos y 40/40 pruebas de interfaz. `settingsPanel`: 6 controles repetidos → tabla `SIMPLE_SETTINGS` (150 → 112 líneas).
- No se tocó `extractZip` ni `importPaths`: llevan seguridad (ZIP bomb, `..`, enlaces) y su división no se justifica sin medir.

**Rendimiento — una regresión PROPIA de 1.0.12, corregida:** el análisis de audio lanzaba hasta 6 ffmpeg por archivo
(3 trozos de canales + 3 de prueba de peso). Medido con un MP3 estéreo de 128 kbps que NO se toca: **1.0.11 ~105 ms,
1.0.12 ~1.150 ms** (en Windows, lanzar `ffmpeg.exe` cuesta aún más). Ahora:
- ≤ 45 s: el archivo entero; ≤ 10 min: **2 trozos de 15 s**; más largo: 3 de 12 s; los trozos se leen **en paralelo**.
- La prueba de peso usa trozos de 10 s y `-compression_level 5` (la mitad de tiempo, tamaño apenas mayor = conservador).
- **`trialCanChangeDecision`**: la prueba solo se hace si, incluso suponiendo que el MP3 pese un 55 % de la tabla
  (`TRIAL_OPTIMISM`; el caso más fácil medido fue un 58 %), pudiera llegar al ahorro mínimo. Un 128 kbps estéreo ya no la hace.
- Resultado: 128 kbps (no se toca) **1.150 → ~400 ms**; 192 kbps (donde la prueba sí puede decidir) **1.170 → ~740 ms**.
  Las decisiones medidas antes NO cambiaron (−55 %, −37 %, −44 %, −24 %, y lo ligero intacto).

**Vídeo — prueba de peso (cierra el pendiente anotado en 7.19):** codificar un vídeo largo son minutos u horas, y si el original
ya está bien comprimido (descarga VP9/AV1, redes sociales) se descarta al final. `projectedSizeRatio` codifica 2 trozos de 8 s
(35 % y 70 %) con EXACTAMENTE los ajustes reales (`videoCodecArgs`/`videoFilterArgs`, extraídos de `buildVideoArgs` sin cambiar
sus argumentos: los 21 tests que los comprueban siguen verdes) a un pipe en bruto (`-f h264|hevc`, sin sobrecarga de contenedor).
Solo para vídeos de ≥ 180 s. Razón = (vídeo estimado + audio de salida) / peso original; **si es ≥ 1,10 se deja intacto**
(`ya-optimizado`); entre 0,95 y 1,10 se codifica igualmente (el error de estimar con 2 trozos es de ese orden y saltarse un vídeo
que sí ahorraba pierde ahorro, mientras que codificar de más solo pierde tiempo). Medido en 5 fuentes (CRF 12-38):

| Fuente | Estimada | Real (entero) | Decisión | Prueba / entero |
|---|---|---|---|---|
| CRF 12 | 0,66 | 0,67 | codifica | 1,2 s / 11,1 s |
| CRF 20 | 0,98 | 0,99 | codifica (se descartará: zona gris) | 1,1 s / 10,6 s |
| CRF 26 | 1,28 | 1,29 | salta | 1,0 s / 12,2 s |
| CRF 32 | 1,59 | 1,59 | salta | 1,0 s / 10,4 s |
| CRF 38 | 1,81 | 1,84 | salta | 1,1 s / 11,1 s |

**LÍMITE: contenido sintético** (`testsrc2`), no vídeo real; con grabaciones de móvil o pantalla la estimación con 2 trozos
puede desviarse más. Verificado también con el `ffmpeg.exe` real bajo wine (el salto tarda < 8 s).

**Arranque de la app:** NO medido de forma fiable (en el entorno de pruebas, 1 núcleo y pantalla virtual, ~20 s, ruido). Las fotos ya
se afinaron en 1.0.7 (`sharp.concurrency(1)`, caché sin descriptores, libjpeg-turbo por defecto) y no se tocaron.

**Verificación 1.0.13:** 361 pruebas (350 pasan, 0 fallan, 11 omitidas como siempre); 40/40 de interfaz tras cada refactor;
audio y vídeo nuevos contra el `ffmpeg.exe` real bajo wine. **NO verificado:** Windows real, Mac real, vídeo real (no sintético).

### 7.21 — Menos espera, 6 idiomas y fotos HEIC (v1.1.0)

**Petición:** pasar a 1.1.0 (cambios mayores); revisar por qué la app «se queda pensando un tiempo antes de ejecutar la
tarea»; implementar las mejoras pendientes salvo vídeo y Mac.

#### A. Por qué se quedaba pensando — diagnóstico MEDIDO
Se reprodujo con un historial sintético de 20.000 fotos únicas en `input/` (como tras meses de uso) y se midió desde que se
suelta una carpeta hasta que la primera foto pasa a «procesando».

| Causa | Qué pasaba | Arreglo |
|---|---|---|
| **Detector de duplicados** | `createDuplicateDetector` recorría y hacía `stat` de TODO `input/` (que no se vacía nunca) en CADA importación: coste que crece con el uso | Índice compartido (`duplicates.sharedIndex`): se arma UNA vez al abrir la app, con la lista que ya saca el arranque; cada importación lo reutiliza y lo amplía. Lo que ya no existe en disco se retira al tocarlo, sin fallar |
| **Todo o nada** | Nada llegaba a la cola hasta copiar la carpeta ENTERA (1.000 fotos: se esperaba a tener 1.000 copias) | `importGroup` entrega por **tandas** (la 1.ª de 8, luego de 64) mientras sigue copiando |
| Arranque | La ventana esperaba a validar la carpeta de salida (prueba de escritura; en un disco de red o externo, segundos) | Se abre primero; `output:get` y las importaciones esperan a esa validación |
| Carpeta de salida | La prueba de escritura se repetía en cada importación | Una vez cada 30 s (entre medias, basta comprobar que sigue existiendo) |
| `sharp` | Se cargaba antes de la ventana (~65 ms aquí; en Windows con antivirus, mucho más) | `sharp-lazy.js`: se carga justo después de dibujar la ventana |

**Cifras (mismo historial de 20.000, 400 fotos de 1600×1200, 1 núcleo):** el primer archivo empieza a comprimirse a los
**99 ms (antes 577 ms)**; tiempo total 24,8 s frente a 25,1 s, memoria igual (comprimir sigue siendo el trabajo pesado).
Solo el índice: 22 ms con historial vacío, 360 ms con 20.000 archivos en un disco muy rápido; en Windows con antivirus será de
segundos. **No medido en un Windows real.**

**Por qué es seguro empezar a comprimir antes de terminar de copiar:** el compresor mira los demás archivos de la carpeta
para que `foto.jpg` y `foto.png` no se pisen. Ahora se conocen de antemano todos los nombres que tendrá la carpeta
(`expectSiblings`, en `output-files.js`), así que esa decisión es exacta desde el primer momento y además no relee la carpeta
(cuyo contenido cambia con cada copia) por cada foto. Un duplicado descartado se quita de lo previsto (`unexpectSibling`).
Los subtítulos se copian ANTES que los vídeos. Verificado con una prueba que falla si se anula `expectSiblings` (mutación).

**Audio:** el análisis de canales y la prueba de peso leían 2-3 trozos con un ffmpeg cada uno. Ahora UN solo ffmpeg los lee
(`concat`; cada trozo rellenado hasta su duración exacta con `apad`+`atrim` para poder separarlos). Comprobado contra el método
anterior: energías por trozo idénticas, bytes exactos; la estimación de kbps sale ~2 % menor (un flujo continuo no repite las
cabeceras de cada trozo), irrelevante frente al umbral del 20 %. Efecto en Windows (más procesos = más antivirus): no medido.

#### B. Idiomas (6)
- **Qué:** español, inglés, alemán, italiano, vietnamita y árabe (RTL), en la ventana Y en los avisos/errores del proceso
  principal. 216 textos por idioma, `src/shared/locales/<código>.js` con las MISMAS claves (el español es la fuente; lo que falte
  cae al inglés y luego al español, nunca una clave pelada).
- **Cómo:** `src/shared/i18n.js` lo usan igual el proceso principal (`require`) y la ventana (`<script>`). `t('clave', {n})`,
  plurales con `Intl.PluralRules` (`clave.one/.other`, y en árabe también `.two/.few/.many`), `data-i18n` / `-title` / `-aria` /
  `-alt` en el HTML, `applyTranslations()` también fija `lang` y `dir` de `<html>`.
- **Decisiones tomadas** (el pendiente decía «definir»): idioma inicial = el del **sistema operativo** (si no es uno de los
  seis, inglés), sin pantalla de elección; se cambia en **Ajustes > Idioma** al instante (sin reiniciar), y es un ajuste GLOBAL
  (no va en los perfiles). Cada idioma se ve con su propio nombre en el selector. En pruebas y sin elegir, el idioma es el español.
- **Árabe / RTL:** el documento entero cambia de dirección; el CSS usa propiedades lógicas (`inline-start/end`) y el
  interruptor se desplaza al lado correcto. NO se invierte la comparación antes/después (el texto de ayuda dice «izquierda =
  original», es físico) ni su barra. Los tamaños y medidas («281 B → 120 B») se aíslan con marcas Unicode (`I18n.isolate`) porque
  sin ellas el algoritmo bidireccional los desordenaba («B 0»): se vio mirando las capturas, ninguna prueba automática lo detectaba.
- **Tipografías:** las empaquetadas son solo latinas (no tienen las tildes apiladas del vietnamita ni el árabe): en `vi` y `ar` se usa
  la fuente del sistema para no mezclar dos tipografías dentro de una palabra.
- **Instalador:** `electron-builder` genera un NSIS multilingüe que elige solo por el idioma de Windows. **CORRECCIÓN (la primera
  versión de este texto decía que ya traía los seis; era falso):** sus mensajes propios de la pantalla «¿para quién se instala?»
  existen en 21 idiomas, entre ellos es/en/de/it, pero NO en árabe ni vietnamita (los rellena en inglés). Se comprobó EJECUTANDO el
  instalador bajo wine con `LC_ALL=<idioma>` (hay que generar el locale con `locale-gen` y crear antes el prefijo con `wineboot -u`):
  alemán e italiano completos; vietnamita y árabe, solo los botones. Arreglo: `build/installer.nsh` con las 17 traducciones
  (LCID 1025 = árabe, 1066 = vietnamita) dentro de la macro `customHeader`. Va ahí, y no suelto en el archivo, porque
  `electron-builder` incluye sus mensajes y ese archivo en un orden no garantizado (tareas asíncronas) y en NSIS gana la ÚLTIMA
  definición de un `LangString` (medido con `makensis`): la primera prueba, con el archivo suelto, NO funcionó. Además,
  `warningsAsErrors: false` en `package.json` (NSIS avisa de la definición repetida). Verificado de nuevo bajo wine: vietnamita y
  árabe ya salen traducidos. **No probado en un Windows real.**
- **No se traduce** (son nombres de archivo/ajustes): las carpetas `Lote_…` y el nombre del perfil de fábrica guardado (la interfaz
  muestra «Por defecto» en el idioma actual mientras no se renombre).
- **Las traducciones las escribí yo**: coherentes y revisadas con las pruebas, pero no por hablantes nativos (sobre todo vi y ar).
- **Pruebas:** `tests/i18n.test.js` (mismas claves y {parámetros} en los 6, plurales, detección, y que cada texto que pide el
  código o el HTML existe) y `tests/ui-i18n-electron.js` (17 pruebas en Electron real: cambio en vivo, fila de la cola, dirección,
  que NINGÚN texto se desborde ni se recorte en ninguno de los 6 idiomas, en la ventana y en Ajustes; guarda capturas con
  `COMPACTA_SHOTS=<carpeta>`).

#### C. Fotos HEIC/HEIF
- **Camino elegido:** `libheif-js` (libheif compilado a WebAssembly), SIN ffmpeg ni nada del sistema: igual en Windows, Mac y Linux.
  Es una dependencia nueva (preferías no añadir): la razón fuerte es que `sharp` no decodifica HEVC y el ffmpeg de Windows 6.1.1 no
  lee HEIF; el pendiente decía que hacía falta un ffmpeg 7.x. Se usa solo `libheif-js/wasm-bundle` (se descartó `heic-decode`: era una
  capa fina que pedía otra dependencia).
- **En un hilo aparte** (`heic-worker.js`): decodificar 12 MP tarda segundos y en el proceso principal congelaría la ventana. Probado:
  el bucle de eventos no se para. Un solo hilo, de una en una (medido, peor caso de ruido a 12 MP y 10 MB: ~2,6-2,9 s por foto);
  se retira tras 20 s sin uso (la memoria de WebAssembly no se devuelve sola). Límite de 100 MP.
- **Color:** las fotos de iPhone son Display P3 y libheif entrega los números sin perfil: tratarlos como sRGB apaga los colores. Se
  detecta P3 por la propiedad `colr` (`nclx` con primarias 12, o un perfil ICC con las **primarias** de Display P3 —no por su nombre:
  el perfil «sP3C» de libvips no dice «Display P3»—) y se convierte a sRGB con una matriz y tablas. Validado contra la conversión ICC real
  de libvips (diferencia ≤ 2/255). Otros perfiles (Adobe RGB…) se dejan como están.
- **Comportamiento (importante):** HEIC ya es muy eficiente y **pasarlo a JPG suele pesar MÁS**. Se respeta la regla «nunca peor que
  el original»: solo sale `.jpg` (o `.webp`) si pesa menos; si no, se copia el HEIC tal cual con el motivo «ya es un HEIC eficiente».
  Con calidad 90 y sin modo agresivo, esto último será lo habitual en fotos reales. Una opción «convertir siempre a JPG por
  compatibilidad» no existe (decisión pendiente, ver `MEJORAS.md`).
- **Empaquetado:** `asarUnpack` del hilo, su módulo de color y `libheif-js`; en `files` se excluye todo `libheif-js` menos
  `libheif-bundle.js` (~5 MB de sobra). El instalador pesa +0,5 MB. Se conserva su LICENSE (**LGPL-3.0**).
- **Vista previa:** `openImage()` abre cualquier foto (HEIC decodificado, con una caché de la última 60 s).
- **Pruebas:** `tests/heic.test.js` (11) con HEIC reales fabricados con `pillow-heif` (se omiten si no está instalado): colores y
  medidas, color P3 de extremo a extremo con un perfil ICC real, conversión que aligera y que no aligera, hilo no bloqueante, archivos
  dañados (el hilo sigue sirviendo), vista previa. Y `tests/packaged-smoke-test-electron.js` decodifica un HEIC dentro del `.asar`.
- **NO verificado:** fotos HEIC reales de iPhone (teselas, Live Photos, HDR de 10 bits, el perfil de Apple); las de prueba son sintéticas.

#### D. Otros
- `styles.css`: sin clases sin uso; dos selectores duplicados fundidos (`.queue-item__badge`, `.statusbar__hint strong`).
- `npm run audit` limpio (sin código sin uso); `importPaths` repartida (`makeDeliver`). Siguen largas: `app.js main` 147,
  `settingsPanel.init` 127, `extractZip` 110, `createDuplicateDetector` 102, `dialog.show` 99 (no se tocaron: listas planas de cableado, y
  `extractZip` lleva las protecciones anti-ZIP-bomb).
- Alta densidad: la interfaz completa (40 pruebas) pasa con escala 1,5 y 2 (`--force-device-scale-factor`, verificado con
  `devicePixelRatio`). Monitor Retina real: no probado.

#### E. Errores encontrados por el camino (y cómo)
1. Mi script de edición no insertó un `require` en `audio-optimizer.js` (no tenía `'use strict'`): lo cazaron las pruebas (`t is not defined`).
2. La prueba de «los hermanos» que escribí primero pasaba AUNQUE se anulara `expectSiblings`: no ejercitaba el mecanismo (las dos fotos caían
   en la misma tanda). Se comprobó con una mutación, se añadió una prueba directa de la pieza y se confirmó que esa sí falla.
3. La detección de P3 por NOMBRE no reconocía un perfil P3 real (de libvips): se pasó a comparar las primarias.
4. Tamaños y rutas desordenados en árabe (bidi): visto en las capturas.
5. `queueView` no tenía texto para el motivo `animacion-preservada` (salía vacío): ahora lo tiene en los 6 idiomas.
6. Mensajes con tilde: las pruebas esperaban «video» y «si» sin tilde; el texto correcto ya las lleva (se actualizaron las pruebas).
7. La detección de HEIC como «no compatible» (aviso de 1.0.3) ya no aplica: tests y aviso actualizados.

**Verificación 1.1.0:** 394 pruebas unitarias (381 pasan, 12 omitidas por no haber `rar`/`7z`, 1 falla: el `tar` de GNU de este Linux
(la prueba de «comprimido falso» espera el mensaje de bsdtar; falla igual en 1.0.13 en este entorno); 40/40 de interfaz (también a escala
1,5 y 2); 17/17 de idiomas; el paquete real de Linux (incluido un HEIC); el `.asar` del instalador de Windows idéntico al fuente.
**NO verificado:** Windows real (instalador y arranque), Mac real, vídeo real, HEIC real de iPhone, traducciones por nativos.

### 7.22 — Ajustes de 1.1.0 tras probarlo (carpetas unidas, contraseña en ZIP, opción HEIC)

**Petición (tras probar 1.1.0):** una captura con carpetas «pruebas2 (13)», «(14)», «(15)», «(17)»: «¿sabes por qué aparece el número entre
paréntesis?»; y «haz tus mejoras» (audio aprobado, firma de código descartada, traducciones aprobadas).

#### A. El número entre paréntesis
- **Causa (medida en el código, no supuesta):** `reserveUniqueDir` creaba `Nombre (2)`, `(3)`… cada vez que se soltaba una carpeta cuyo nombre
  YA existía en `input/`, y `input/` no se vacía nunca. Al probar repetidamente «pruebas2» salían (13), (14)… El hueco en el (16) es una
  importación en la que todo era repetido: su carpeta nueva quedó vacía y se borró, pero el número ya se había gastado. La salida repite la
  misma estructura, así que `output/` también se llenaba.
- **Arreglo:** `ensureDir` reutiliza la carpeta si existe: lo nuevo se **une** a ella. Para no pisar nada: un archivo cuyo nombre ya está
  ocupado (otra foto distinta con el mismo nombre —la cámara reinició la cuenta—, o la misma importada otra vez) recibe «foto (2).jpg»
  EN EL NOMBRE DEL ARCHIVO (`resolveNameConflicts`, y `copyUnique` con `COPYFILE_EXCL` como red por si dos importaciones coinciden). Si es el
  mismo archivo de antes, el detector de duplicados lo descarta como siempre. Los subtítulos siguen al vídeo renombrado.
- **Tres cuidados:** (1) un comprimido sin fotos NO borra la carpeta si ya existía (solo la borra si la creó él); (2) los nombres previstos para
  los hermanos `foto.jpg`/`foto.png` ahora incluyen lo que YA había en la carpeta y llevan cuenta de importaciones simultáneas;
  (3) los extractores ya daban «(2)» a lo repetido, así que unir comprimidos es seguro.
- **No cambia:** las carpetas que ya tengas con número se quedan (se pueden borrar a mano). `Lote_…` (archivos sueltos) sigue siendo una
  carpeta por importación. El progreso es por lote de la cola, no por carpeta (comprobado), así que unir no lo altera.
- **Pruebas:** `tests/import-merge.test.js` (8: misma carpeta repetida, mismo nombre con fotos nuevas, subcarpetas, vídeo con subtítulo,
  comprimido que se une y comprimido vacío que no borra, dos importaciones a la vez, hermanos previstos) y dos pruebas de interfaz en
  Electron. Se actualizaron las 2 pruebas antiguas que fijaban «Fotos (2)» (la intención «no sobrescribir» se mantiene).

#### B. ZIP con contraseña (antes solo avisaba)
- **Qué:** `zip-decrypt.js`, sin dependencias nuevas (solo `crypto`): **ZipCrypto** (el clásico, `zip -P`, Windows) y **AES-128/192/256 de
  WinZip**. En streaming (un vídeo de GB no se carga en memoria). ZipCrypto: la comprobación es de UN byte (1 de ~128 contraseñas malas pasa),
  así que además se verifica el CRC32 y todo fallo de datos tras ese cifrado se informa como «contraseña equivocada». AES: verificador de
  2 bytes + HMAC-SHA1 final (detecta contraseña mala y archivo alterado; un archivo alterado se avisa como dañado, sin volver a preguntar).
- **Flujo:** al importar un ZIP cifrado, sale un cuadro («Comprimido protegido», campo oculto, la contraseña se respeta tal cual con
  espacios y tildes, no se guarda en ningún sitio). Mala: se vuelve a preguntar. Cancelar: el aviso de siempre («protegido con
  contraseña»). Se reintenta SOLO ese comprimido (`batches:import-archive-password`); lo ya extraído vuelve como duplicado y se descarta.
  Solo se pide la contraseña de lo que se va a importar (un `leeme.txt` cifrado no estorba). **RAR y 7z con contraseña siguen sin
  poder** (`tar` no la admite): solo avisan.
- **Por qué los bytes crudos salen del archivo y no de yauzl:** `yauzl` no deja leer en crudo ni las entradas guardadas sin comprimir ni las
  AES (método 99); se leen directamente desde la cabecera local.
- **Verificado contra un oráculo independiente:** ZIP reales fabricados por `zip` (ZipCrypto) y `pyzipper` (AES) en tests: 4 cifrados × (con y
  sin comprimir, 3 MB, contraseña buena, equivocada, ausente), alterado, y de extremo a extremo. **Prueba de estrés: 4.200 contraseñas
  equivocadas** y ninguna se trató mal. Eso encontró DOS fallos reales que las pruebas normales no veían (7 de 4.200): `pipeline` destruía el
  flujo con el error original antes de poder convertirlo, y un error sin oyente se habría vuelto una excepción sin capturar.
- **Velocidad (medida, 60 MB, 1 núcleo):** AES ≈ 143 MB/s; ZipCrypto ≈ 30 MB/s (un vídeo de 1 GB: ~35 s solo en descifrar). Un intento de
  acelerar ZipCrypto con variables locales no cambió nada: el cuello está en otra parte (CRC32 de comprobación). Sin optimizar más.

#### C. Opción «HEIC: pasar siempre a JPG»
Ajuste por perfil `heicAlwaysJpg` (apagado). Con ella, un HEIC se convierte aunque pese más; la fila muestra «+N %» y «pasada a JPG por
compatibilidad (pesa más que el HEIC)»; el «ahorrado» nunca cuenta un ahorro inexistente. Sin ella, todo como antes.

#### D. Funciones largas
Repartidas `app.js main` (5 funciones con nombre), `settingsPanel.init` (4 piezas), `dialog.show` y `createDuplicateDetector`
(huellas aparte). Verificado con las 44 pruebas de interfaz en Electron. Quedan `extractZip` (106) y `createDuplicateDetector` (91).

#### E. Más hallazgos
1. Una prueba mía («primera tanda ≤ 8») pasaba solo por casualidad de tiempos: si el primer archivo terminaba el último, la primera tanda
   salía de 42. Se arregló el CÓDIGO (se entrega de a `chunkSize`), no la prueba.
2. Al insertar la fila de la opción HEIC en `index.html` mi script duplicó un bloque grande: se restauró desde el zip entregado y se repitió
   bien (comprobado: un solo `dialogOverlay`, un solo `heicToggle`).
3. Instalador (ver 7.21 B): árabe y vietnamita tradujeron solo los botones; corregido y reverificado bajo wine en el instalador definitivo.

**Verificación (instalador final):** 432 pruebas unitarias (419 pasan, 12 omitidas por no haber `rar`/`7z`, 1 falla: el `tar` de GNU de este
Linux, como en 1.0.13), 44/44 de interfaz, 17/17 de idiomas, paquete real de Linux (incluido un HEIC), `.asar` del instalador de Windows
idéntico al fuente, instalador en árabe comprobado bajo wine. **NO verificado:** Windows real, Mac real, vídeo real, fotos HEIC reales de iPhone.

### 7.23 — Mac terminado: un solo instalador, desde macOS 10.13, misma interfaz (v1.2.0; desde 1.2.2 hay dos variantes, ver 7.25)

**Qué se pidió.** Terminar Mac (corregir lo mal hecho, implementar lo que Windows tiene y Mac no, con calidad y velocidad), probarlo, quitar el
«aplazado a propósito», que **el instalador sea UNO solo** para Macs viejos y modernos, que llegue a **macOS 10.14 o anterior** («tal vez 10.12 como mínimo»
en la iglesia), con la **misma interfaz** que Windows, y que el `.dmg` lo genere GitHub.

**Decisión central (1.2.0; desde 1.2.2 solo vale para la variante antigua, ver 7.25): el build de Mac usa Electron 26.6.10; Windows usa el de `package.json` (32 al hacer 1.2.0; hoy 44).** Desde Electron 27 (Chromium 117) macOS 10.13 y 10.14 ya no se
soportan (documentado por Electron); la 26 es la última que arranca ahí. Se fija en el script `dist:mac-legacy` (`-c.electronVersion=26.6.10`), no en `package.json`, así
`npm test`, Windows y el Mac moderno siguen con el Electron del `package.json`. **Mismo código, misma interfaz:** se pasó todo con los dos motores (unitarias con Node 22 y con el Node 18.16 de Electron 26,
vía `ELECTRON_RUN_AS_NODE=1`; interfaz con el Electron de `package.json` y con Electron 26). Lo único distinto entre sistemas es el hueco para los tres botones de la ventana de Mac
(en Windows están en su propia barra de título).

**Hasta dónde llega, MEDIDO en las cabeceras Mach-O** (`LC_BUILD_VERSION`): Intel → Electron 26: 10.13, `sharp`/libvips: 10.13, ffmpeg x64: 10.13. Apple Silicon →
Electron 26: 11.0, `sharp`: 11.0, ffmpeg arm64: **12.0**. El instalador declara `LSMinimumSystemVersion` 10.13.0 (en un Mac anterior, el Finder lo dice en vez de fallar).
**¿Y macOS 10.12?** No se soporta, y no hace falta: la lista oficial de Apple de Macs compatibles con Sierra (10.12) es **idéntica** a la de High Sierra (10.13)
(MacBook e iMac de finales de 2009, MacBook Pro / Mac mini / Mac Pro de mediados de 2010, MacBook Air de finales de 2010). Todo Mac que pueda correr 10.12 puede
actualizarse gratis a 10.13.6 desde la App Store (a veces sale «unexpected error» por un certificado caducado del instalador: se arregla bajando de nuevo el
instalador desde el enlace de Apple, o poniendo la fecha del Mac en 2014 mientras se instala). Ir más abajo exigiría un Electron ≤ 21 sin parches, otro `sharp`/libvips
y otro ffmpeg: no se hizo y no se recomienda.

**Cambios (todos con prueba).**
1. **Un solo `.dmg` universal** (`Compacta-X.Y.Z-Mac.dmg`, `--universal`): fusión Intel + Apple Silicon con `@electron/universal`. Sin `.zip`, sin uno por arquitectura.
   La prueba `tests/mac-build-config.test.js` vigila esa promesa.
2. **Fallo evitado en la fusión universal:** el ffmpeg de Intel y el de Apple Silicon traen un `ffmpeg.LICENSE` distinto y la fusión exige que todo lo que no es binario sea
   idéntico («Expected all non-binary files to have identical SHAs»). Ahora el binario va por arquitectura y las licencias de AMBAS viajan aparte (`Resources/ffmpeg/licenses/x64|arm64`).
   Los ffmpeg se fusionan solos en un binario «fat»; las librerías de `sharp` de las dos arquitecturas son idénticas en los dos paquetes y pasan sin ajustes (los archivos dentro de
   `app.asar.unpacked` los trata `mergeASARs`, no la comprobación Mach-O).
3. **Firma ad-hoc** (`build.mac.identity = "-"`, `timestamp = "none"`; en 1.2.0 era una función propia, `scripts/mac-sign.js`, retirada en 1.2.2, ver 7.27): sin ella, electron-builder no firma nada y el `.app` sale con la firma original de Electron rota; **Apple Silicon lo rechaza con «está dañado»**.
   Con firma ad-hoc (gratis) sale el aviso normal de «no verificado». `hardenedRuntime: false` a propósito: con «runtime», macOS solo carga librerías del MISMO equipo de desarrollo y una firma
   ad-hoc no tiene equipo. Si algún día hay certificado (Developer ID): quitar `identity: "-"` y `timestamp`, poner `hardenedRuntime: true`, añadir `build/entitlements.mac.plist` (allow-jit, allow-unsigned-executable-memory, disable-library-validation) y las
   variables `CSC_LINK`/`CSC_KEY_PASSWORD`/`APPLE_ID…` para notarizar.
4. **Botones de la ventana** (corregido): `trafficLightPosition {18, 25}` + `html[data-platform='mac'] .topbar` (padding-left FÍSICO de 88 px: en macOS los botones siguen a la izquierda también con árabe; barra de 64 px para centrarlos;
   sin hueco en pantalla completa vía los eventos `enter/leave-full-screen` → `window:fullscreen`). Probado en español y árabe, ventana normal y mínima (con capturas).
5. **Menú de Mac** (`src/main/app-menu.js`): en los 6 idiomas (`menu.*`), con «Edición» (sin él ⌘C/⌘V no existen), sin «Herramientas de desarrollo» (solo con `--dev`); se reconstruye al cambiar de idioma. Windows/Linux no cambian.
6. **Apple Silicon + macOS 11**: el ffmpeg arm64 pide macOS 12, pero el mismo archivo lleva la parte Intel y Rosetta 2 la ejecuta: `ffmpegLaunch()` antepone `arch -x86_64` (cabecera Mach-O leída con
   `machoArchitectures()` de `src/main/macho.js`, validada con los binarios reales; Rosetta comprobada con `arch -x86_64 /usr/bin/true`). Sin Rosetta: aviso con el comando de instalación. Ya no se dice «instala la versión para Mac Intel» (no hay otra).
7. **Arrastrar y soltar con Electron 26:** `webUtils.getPathForFile` es de Electron 29; el preload usa `file.path` si no existe (`tests/preload-compat.test.js`).
8. `⌘V` / `Ctrl+V` se decide con `window.api.platform` (el preload lo expone), no con `navigator.platform`.
9. **GitHub Actions** (`.github/workflows/build.yml`): construye el `.dmg` y, en un **Mac Intel (`macos-15-intel`) y uno Apple Silicon (`macos-latest`) reales**, lo abre, comprueba las dos arquitecturas, el
   macOS mínimo y la firma, abre la app real (captura de la ventana en «Artifacts»), ejecuta `scripts/verify-packaged-engine.js` (comprime de verdad foto, HEIC fabricado con `sips`, vídeo y audio con el Electron,
   `sharp`, libheif y ffmpeg del paquete) y pasa `npm test`. Con una etiqueta `v*` publica en Releases. Windows también se construye ahí.

**Resultado de las pruebas de 1.2.0:** 454 unitarias (443 pasan, 11 omitidas por no haber `rar`, 0 fallan) con Node 22 Y con el Node 18.16 de Electron 26; 47/47 de interfaz con Electron 32 y con Electron 26;
17/17 de idiomas; paquete real de Linux; fusión universal de Mac sin errores; verificador del paquete 7/7.

**Resultado REAL en GitHub (repositorio `RobertBalanca1/compacta`, etiqueta `v1.2.0`).** Construido y probado en macOS reales, no simulado: `.dmg` universal + `.exe`; el `.dmg`
se abrió y se probó en un **Mac Apple Silicon (macOS 26.6.2) y en un Mac Intel**: las dos arquitecturas, macOS mínimo 10.13.0, firma ad-hoc válida, formato HFS+, compresión real
de foto, HEIC (fabricado con `sips`), vídeo y audio con lo que lleva dentro la app, ventana real cargada y `npm test` completo. **Cuatro fallos que SOLO aparecieron en GitHub** (y su arreglo):
1. Windows: electron-builder detecta CI e intenta publicar → exige `GH_TOKEN`. Arreglo: `--publish never` en `dist:win`, `dist:mac` y `dist:mac-legacy`.
2. Mac: `EEXIST: file already exists, link …heic-worker.js` — en CI electron-builder usa enlaces duros y esos dos archivos (desempaquetados del `.asar`) se procesan dos veces. En local no se ve (no usa
   enlaces duros fuera de CI; se reproduce con `USE_HARD_LINKS=true CI=true`). Arreglo: `USE_HARD_LINKS=false` en `dist:mac` y `dist:mac-legacy`.
3. Mac: en un servidor Apple Silicon electron-builder fabrica el `.dmg` en **APFS**, formato arriesgado en macOS 10.13/10.14. Arreglo: el `.dmg` se construye en `macos-15-intel` (HFS+) y el flujo
   comprueba con `diskutil info` que el volumen es HFS+. (Sigue siendo universal.)
4. `npm test` en Apple Silicon: 2 pruebas fallaban porque el ffmpeg de Apple Silicon no trae el codificador `libopencore_amrnb` ni el muxer `yuv4mpegpipe` y no puede FABRICAR la muestra `.amr` / `.y4m`;
   ahora se omiten en ese caso (si el fallo es otro, siguen fallando). No dice nada de si LEE esos formatos: no comprobado en Apple Silicon.
Cómo leer un fallo del flujo desde el entorno de desarrollo: los registros de GitHub (`/actions/jobs/<id>/logs`) redirigen a un servidor que ese entorno no alcanza y las anotaciones solo dicen «Process completed with exit code 1». Con un token
(Actions: lectura) se puede usar un paso temporal `if: always()` que haga `git push -f` de las últimas líneas del registro a una rama `registro-…` y leerla con la API de contenidos; se usó así y luego se quitó (rama y paso).

**Cómo se verificó (repetible desde Linux).**
- `npm run predist:mac` (las dos variantes de `sharp` y los dos ffmpeg: la segunda instalación con `--cpu` NO borra la primera) → `npx electron-builder --mac dir --universal` construye los dos
  paquetes y se detiene en la fusión (`@electron/universal` solo corre en darwin). `node scripts/mac-app-tools.js merge` hace esa fusión con las mismas opciones que electron-builder (necesita un `lipo`:
  `apt install llvm; ln -s /usr/bin/llvm-lipo-18 /usr/local/bin/lipo`) y `node scripts/mac-app-tools.js check` lista cada ejecutable y librería del `.app` con sus arquitecturas y su macOS mínimo, y falla si algo pide
  más que lo declarado. (Para la variante antigua: `predist:mac-legacy` y `-c.electronVersion=26.6.10 -c.mac.minimumSystemVersion=10.13.0`, ver 7.25.) Resultado en 1.2.0: ejecutable, Electron Framework y ffmpeg con x86_64 + arm64,
  mínimos 10.13/11.0 (ffmpeg arm64: 12.0), `.asar` con `src/` idéntico al fuente. El lector de cabeceras es `src/main/macho.js` (probado con binarios Mach-O fabricados: `tests/macho.test.js`, `tests/mac-app-tools.test.js`).
- `scripts/verify-packaged-engine.js` se probó aquí contra el paquete de Linux con el Electron 26 como motor (7/7).
- Nota: en las pruebas de interfaz, la plataforma FINGIDA del proceso principal (`process.platform = 'darwin'`) se propaga al preload de las ventanas que se creen mientras tanto (no es la real).

**NO verificado (honestidad).** Nada se ha ejecutado en un Mac real salvo lo que haga GitHub al correr el flujo (macOS reciente, no 10.13–10.15). La firma, `codesign`, `hdiutil`, la creación del `.dmg` y el arranque de la app
en macOS no pueden simularse desde Linux. El aspecto real de los botones, notificaciones, Dock, permisos y la ruta de Rosetta en macOS 11: ver `PRUEBAS-EN-MAC.md`.
Electron 26 (Chromium 116, 2023) no recibe parches de seguridad; la app no carga contenido de internet. Con macOS 26 («Tahoe») antes de la 26.2, los Electron anteriores a 2025 gastan GPU en `WindowServer` (bug de
`_cornerMask`, arreglado por Apple en el sistema en 26.2); afecta igual a la 26 que a la 32.

### 7.24 — Revisión de calidad de 1.2.0: dependencias, obsoletos y avisos

**Se pidió:** que no quede ningún aviso ni cosa obsoleta, ni en local ni en GitHub, y optimizar. Resultado y lo que NO se pudo:

**Subido (probado con todo):** `electron-builder` 25.1.8 → **26.15.3** y `electron` 32.3.3 → **44.9.1** (Windows, desarrollo y Mac moderno; solo el Mac antiguo sigue fijado a 26.6.10, en `dist:mac-legacy`).
Avisos «npm warn deprecated»: de **11 a 4**; vulnerabilidades de `npm audit`: de **20 a 9**. Los 4 avisos que quedan los trae la propia última versión de electron-builder
(`inflight` y `glob@7` vía `@electron/asar`, `boolean` vía `@electron/get`, `rimraf@2` vía `electron-winstaller`): no se pueden quitar sin romper la herramienta (probado: un `overrides`
de `rimraf` solo cambiaba un aviso por otro). Son herramientas de CONSTRUCCIÓN, no viajan en la app.

**Lo que NO se arregló, y por qué:**
- 8 vulnerabilidades «moderate» (`sprintf-js` ≤ 1.1.3, DoS por precisión sin límite, vía `roarr` ← `global-agent` ← `@electron/get`): **no existe ninguna versión corregida** de `sprintf-js`; solo
  afecta al registro de las herramientas de construcción. `npm audit fix` no puede arreglarlo (propone una versión de electron-builder anterior a la que ya está).
- (ACTUALIZADO en 1.2.2, 7.25: resuelta en Windows y Mac moderno con `sharp` 0.35.5; solo queda en el Mac antiguo.) 1 vulnerabilidad «high» en `sharp` 0.33.5 (CVEs de libvips, libheif y librsvg). Se arregla en `sharp` 0.35.5, pero esa versión exige **Node ≥ 20.9 y macOS ≥ 10.15 en Intel** (medido en sus
  binarios: libvips y `.node` con mínimo 10.15) y Electron 26 trae Node 18.16: subirla rompe justo macOS 10.13/10.14, que es un requisito. Por eso, al hacer 1.2.0, `sharp` se dejó en 0.33.5 en TODAS las
  plataformas. **Desde 1.2.2 (7.25) solo la variante antigua la conserva.** Riesgo real en esa variante: solo al procesar una imagen maliciosa que la persona misma elija; la app es local y no abre nada de internet. Si algún día se
  renuncia a macOS < 10.15, desaparece la variante antigua y con ella esa alerta (y la de Chromium 116).

**Cambios necesarios por las versiones nuevas (los habría roto el siguiente build en GitHub):**
1. `@electron/universal` 2.0.3 (de electron-builder 26) comprueba también los binarios dentro de `app.asar.unpacked`: las librerías de `sharp` de las DOS arquitecturas son idénticas en los dos
   paquetes y hay que declararlas: `build.mac.x64ArchFiles = "Contents/Resources/app.asar.unpacked/node_modules/@img/**"` (el nombre engaña: vale para todo binario igual en ambos).
   Sin ello: «Detected file … that's the same in both x64 and arm64 builds and not covered by the x64ArchFiles rule».
2. `build.dmg.filesystem = "HFS+"` explícito: electron-builder 26 avisa de que el valor por defecto pasará a APFS en la próxima versión mayor (arriesgado en macOS 10.13/10.14). La versión nueva
   también reintenta sola si `hdiutil` falla de forma transitoria al montar/desmontar (los «failed to mount» ocasionales). El flujo sigue comprobando que el `.dmg` es HFS+.
3. Acciones de GitHub a las versiones que corren sobre Node 24 (`checkout@v7`, `setup-node@v7`, `upload-artifact@v7`, `download-artifact@v8`, `action-gh-release@v3`): las anteriores generaban
   el aviso amarillo «Node.js 20 is deprecated». Todas conservan las entradas que usamos (comprobado en sus `action.yml`). `npm ci --no-audit --no-fund` quita las líneas informativas.
   El desmontaje del `.dmg` en el flujo reintenta con `-force`.

**Código:** sin APIs obsoletas (búsqueda estática y ejecución con `--trace-deprecation --pending-deprecation`: 0 avisos en Node 22, con Electron 44 ni con Electron 26). `scripts/audit-code.js`
ya no avisa de funciones largas: `extractZip` (106 líneas) se dividió sacando `processEntry`, y `createDuplicateDetector` (91) sacando `compareWith`; sin cambiar su lógica (las pruebas de ZIP, importación y
duplicados lo confirman). El ruido que se ve al probar en este entorno de desarrollo (mensajes de `dbus`/GPU/`shared_image` de Chromium sin pantalla real) no viene de la app.

**Pruebas tras la revisión (código final, local):** 458 unitarias, 447 pasan, 11 omitidas (sin `rar`) y 0 fallan, con Node 22 (0 avisos de obsolescencia con `--trace-deprecation --pending-deprecation`) y con el Node 18.16
de Electron 26; interfaz 47/47 con Electron 44 y con Electron 26; idiomas 17/17; paquete real de Linux (arranca, descomprime ZIP, comprime vídeo y audio, decodifica HEIC); verificador del paquete 7/7 con el motor
del Mac; fusión universal de Mac sin errores y con las mismas arquitecturas y mínimos; instalador de Windows con Electron 44.9.1 construido sin ningún aviso y con `src/` idéntico al fuente.

**Dos mensajes que se ven al probar y NO son de la app:**
- Con el Node 18.16 de Electron 26, `MaxListenersExceededWarning … 11 abort listeners added to [AbortSignal]`: lo genera el propio ejecutor de pruebas de Node 18 (`node:internal/test_runner`) cuando un archivo tiene más de 10
  pruebas (la traza lo confirma). No ocurre al usar la app ni en GitHub (usa Node 22).
- En este entorno de desarrollo (Linux sin pantalla), mensajes de `dbus`/GPU/`shared_image` de Chromium y, con `sharp` dentro de Electron en Linux, `GLib-CRITICAL … key_id > 0`: solo Linux, no afectan a Windows ni a Mac.

**Pendiente de comprobar en GitHub (necesita subirlo):** que el flujo con las acciones nuevas termine sin ninguna anotación amarilla y que el `.dmg` salga HFS+; los avisos exactos de GitHub no se pueden leer desde aquí sin un token.

### 7.25 — Dos versiones de Mac (moderna y antigua), paridad con Windows y revisión de fallos (v1.2.2)

**Se pidió:** otra repasada de fallos en Windows y en Mac (versión vieja y nueva), confirmar que todo lo de Windows está en Mac, valorar separar Mac en una versión para equipos antiguos y otra para
modernos dejando claro que en los antiguos puede haber algún problema, y subir el contador de versión (1.2.2).

**Decisión: dos instaladores de Mac, mismo código y misma interfaz; solo cambia el motor por debajo.** Motivo, medido en los binarios (`LC_BUILD_VERSION`): Electron 44 exige **macOS 13.0** (Intel y Apple Silicon) y Electron 26
llega a **10.13**; no hay un único motor que cubra 10.13 y esté al día. Con UN solo instalador, TODOS los Macs (también los modernos) habrían quedado con Chromium 116 de 2023 y la librería de imágenes con vulnerabilidades;
con dos, la mayoría usa el mismo motor que Windows.

| | **Mac** (`Compacta-X.Y.Z-Mac.dmg`) | **Mac antiguo** (`Compacta-X.Y.Z-Mac-antiguo.dmg`) |
|---|---|---|
| Para | macOS 13 (Ventura) o superior, Intel o chip Apple | macOS 10.13 a 12 (Intel; chip Apple con macOS 11 o 12). También arranca en los nuevos, pero no hace falta |
| Motor | Electron del `package.json` (44.9.1), el mismo que Windows | Electron 26.6.10 (Node 18.16, Chromium 116) |
| `sharp` / libvips | 0.35.5 / 8.18.7 (0 vulnerabilidades de producción) | 0.33.5 / 8.15.3 (la 0.35 exige macOS 10.15 y Node 20) |
| `LSMinimumSystemVersion` | 13.0.0 | 10.13.0 |
| Se construye con | `npm run dist:mac` | `npm run dist:mac-legacy` (`predist:mac-legacy` instala `sharp@0.33.5`) |
| Aviso al usuario | — | en el nombre del archivo (`-antiguo`), en el `LEEME.txt` y en el texto del Release: «funciona, pero puede tener algún problema que la normal no tiene» |

Un Mac con macOS < 13 que intente abrir la versión normal recibe del Finder el aviso de que requiere macOS 13 (por `LSMinimumSystemVersion`), no un cierre inesperado. `package.json` declara `sharp` como
`>=0.33.5 <0.36.0` para ser coherente con las dos instalaciones; `package-lock.json` fija la 0.35.5 (Windows, desarrollo y Mac moderno). La detección de macOS 11 en Apple Silicon (Rosetta para el ffmpeg, 7.23) solo
puede ocurrir en la variante antigua.

**Pruebas con cada pareja (Linux), medición INTERMEDIA; el resultado final está en 7.26.** Moderna/Windows: Node 22 + `sharp` 0.35.5 + Electron 44: 447 pasan, 0 fallan (11 omitidas). Antigua: Node 18.16 (Electron 26 como Node) + `sharp` 0.33.5: 446 pasan y 1 falló (mi propia
prueba de configuración, que aún describía «un solo Mac»; ya actualizada). Las dos fusiones universales se construyen y se inspeccionan aquí (mínimos: moderna 13.0.0 con `sharp` 10.15/11.0 y ffmpeg 10.13/12.0; antigua 10.13.0).
El flujo de GitHub construye ambas, las abre en un Mac Intel y uno Apple Silicon reales (4 pruebas) y comprueba además el mínimo esperado de cada una, las claves de permisos y la sintaxis de los textos con `plutil -lint`.

**Paridad de funciones Windows ↔ Mac (revisión del código con `grep` de todo lo que depende del sistema).** Todo lo que hace la app (cola, fotos/HEIC/vídeo/audio, duplicados, comprimidos con contraseña, pegar, arrastrar, 6 idiomas,
ajustes, vista previa) es el MISMO código en los dos. Lo que cambia es lo que impone cada sistema, y todo tiene su equivalente:
instalación (asistente con acceso directo ↔ arrastrar a Aplicaciones), aviso al terminar (notificación + parpadeo de la barra de tareas ↔ notificación + rebote del Dock), botones de la ventana (barra del sistema ↔ botones
integrados con hueco en la barra), menú (ninguno ↔ menú propio en 6 idiomas con Edición), permisos (no hay ↔ textos explicativos en 6 idiomas para Documentos, Escritorio, Descargas y discos externos/red), primera apertura
(aviso de SmartScreen ↔ aviso de Gatekeeper, ver `LEEME.txt`). No se encontró ninguna función de Windows que falte en Mac.

**Fallos encontrados y corregidos en esta revisión.**
1. **Windows (y Linux) enseñaban el menú de ejemplo de Electron** (Archivo/Edición/Ver/Ventana/Ayuda, con «Herramientas de desarrollo» y «Recargar» a la vista): nada lo quitaba. Ahora `refreshAppMenu` pone `Menu.setApplicationMenu(null)`
   fuera de macOS, salvo con `--dev`; copiar/pegar/deshacer siguen funcionando solos en los campos de texto. (3 pruebas en `tests/app-menu.test.js`.)
2. **Mac: los avisos de permiso de macOS salían sin explicación** (Documentos, Escritorio, Descargas, discos externos/red). Ahora `build.mac.extendInfo` + `build/mac-strings/<idioma>.lproj/InfoPlist.strings` (6 idiomas).
3. **`sharp` 0.33.5 tenía una vulnerabilidad alta (CVE de libvips/libheif/librsvg)** y la 0.35.5 no puede llegar a macOS 10.13 → resuelta en Windows y Mac moderno (0 vulnerabilidades de producción), conservada solo en el Mac antiguo (que
   no se puede arreglar sin subir el mínimo).
4. `sharp-wasm32` (0.35) se excluye de los tres sistemas: es el respaldo en WebAssembly que no se usa y pesaba de más.
5. Versión: `package.json` y `package-lock.json` pasan a **1.2.2** (la 1.2.0 ya estaba publicada en GitHub con el `.dmg` único; no existe 1.2.1).

**Resultado final de las pruebas con el código de 1.2.2 (Linux, instalación limpia con `npm ci` entre una pareja y otra):**
- Pareja moderna (Node 22 + `sharp` 0.35.5), antes de la revisión exhaustiva de 7.26: 464 pruebas, 453 pasan, 11 omitidas (sin `rar`), 0 fallan, 0 avisos de obsolescencia. Interfaz 47/47 con Electron 44, idiomas 17/17.
- Pareja antigua (Node 18.16 de Electron 26 + `sharp` 0.33.5), idem: 453 pasan, 0 fallan, 0 avisos propios (solo el del ejecutor de pruebas de Node 18, ver 7.24). Interfaz 47/47 con Electron 26, idiomas 17/17.
- Paquete real de Linux (arranca, descomprime ZIP, comprime vídeo y audio, decodifica HEIC) y verificador del paquete 7/7 con Electron 44 como motor.
- Las dos variantes de Mac: construidas, fusionadas e inspeccionadas (moderna: `LSMinimumSystemVersion` 13.0.0; antigua: 10.13.0; las dos con Intel + Apple Silicon, seis `InfoPlist.strings` y las claves de permisos).
- Instalador de Windows 1.2.2 (Electron 44.9.1, solo `sharp-win32-x64`, sin `sharp-wasm32`): construido sin ningún aviso y con `src/` idéntico al fuente.

**Trampas del entorno de pruebas descubiertas en esta revisión.** (1) Alternar `sharp` 0.33.5 ↔ 0.35.5 en el mismo `node_modules` deja binarios nativos de una versión con el JS de la otra: `sharp` cae en silencio a su respaldo
`@img/sharp-wasm32` (más lento) y Node imprime 97 veces `DEP0111 process.binding() is deprecated` desde ese paquete. No es un fallo del producto; basta `npm ci` al cambiar de pareja. (2) Al usar `sharp` dentro de Electron EN LINUX, `sharp`
imprime su propio `[SharpElectronLinux] Warning: Binaries provided by Electron for use on Linux may be incompatible with sharp` (y a veces `GLib-CRITICAL`): solo Linux, no aplica a Windows ni a Mac.

**Lo que sigue SIN poder afirmarse.** Nada de esto se ha ejecutado en macOS 10.13–12 ni en Windows real. La variante antigua se ha probado (Linux, Node 18) y construido, y GitHub la prueba en macOS reciente, pero no en un
macOS antiguo; el motor es de 2023 y puede fallar algo propio de esos sistemas. Windows 7/8 no se soportan (Electron 23 en adelante); Windows 10 o superior.

### 7.26 — Revisión exhaustiva antes de publicar 1.2.2: código muerto, desajustes y estado final

**Se pidió:** revisar absolutamente todo (Windows, Mac moderno y Mac antiguo) sin que se haya perdido nada, sin desajustes, sin código muerto ni obsoleto, sin arreglar por un lado y romper por otro, sin código espagueti.
Método: diff contra la 1.1.0 original, ESLint 9 (instalado FUERA del proyecto, `no-undef`, `no-unused-vars`, `no-unreachable`, etc., sobre `src`, `scripts` y `tests`), búsqueda de claves de idioma y clases CSS sin uso, cruce de
`package.json` ↔ flujo ↔ pruebas ↔ documentación, y repetición completa de las pruebas con cada pareja de motor.

**Código de la app (diff contra 1.1.0).** Los cambios en `src/` son los previstos y nada más: menú, ventana de Mac y pantalla completa, `platform` en el preload, ffmpeg (Rosetta), y dos extracciones mecánicas sin cambio de lógica
(`processEntry` en `zip-extractor.js`, `compareWith` en `duplicates.js`). ESLint: **ninguna variable sin definir ni sin usar en `src/` ni en `scripts/`** (lo que demuestra que las extracciones no dejaron nada colgando). Los únicos avisos que quedan son
falsos positivos conocidos y deliberados: `self`/`document` en `src/shared/` (módulos que corren en Node y en el navegador a la vez) y la expresión regular de caracteres de control de `file-names.js` (filtra nombres inválidos de Windows).

**Código muerto encontrado y eliminado** (casi todo venía de la 1.1.0):
1. Claves `settings.audioFormat.opus` y `.flac` en los 6 idiomas: «Opus» y «FLAC» son nombres propios escritos en el HTML y nunca las usaron.
2. Restos en pruebas: `fsSync` y `pcmMd5` (`audio-efficiency`), un `require` entero (`audio-queue`), `path` (`helpers/make-audio`), el parámetro `color` (`sibling-cache`), un parámetro `t` y un `let` que debía ser `const` (`ui-test-electron`),
   y 7 escapes innecesarios en cadenas (sin cambiar su valor).
3. Un archivo vacío (0 bytes) `codigo-fuente/LEEME.txt`, y dos scripts de `package.json` sin uso ni documentación: `dist:all` y su `predist:all` (el `.dmg` solo se genera en un Mac: no se puede encadenar con el resto).
4. El flujo auxiliar `.github/workflows/test-mac.yml` (solo servía para diagnosticar; nada lo usaba) y los restos `tee build.log` / `set -o pipefail` del flujo principal, que ya no leían nada.
5. Sin uso confirmado: ninguna clase CSS (las tres `queue-item--…` se construyen con el estado de cada trabajo), ninguna clave de idioma más (los plurales `.one/.other` y `menu.*` se construyen dinámicamente), ninguna dependencia.

**Desajustes entre código, pruebas y documentación corregidos** (frases que describían el estado ANTERIOR como si fuera el actual): el motor fijado en `dist:mac` (ahora solo en `dist:mac-legacy`); `sharp` 0.33.5 «en todas las plataformas» (ahora solo la
variante antigua); «un solo instalador» en limitaciones, README, PRUEBAS-EN-MAC y MEJORAS; la tabla de compatibilidad de 7.15 («macOS 10.14 o anterior: no») marcada como histórica; los comandos de la guía de continuación (13.4); la referencia a un apartado
que no existía («Si algún día hay certificado» → 7.23, punto 3); y los recuentos de pruebas.

**Para que lo verificado no dependa de scripts sueltos:** el lector de cabeceras Mach-O sale de `ffmpeg.js` a `src/main/macho.js` (sin duplicar) y las comprobaciones que antes se hacían con programas en `/tmp` son ahora `scripts/mac-app-tools.js`
(`check` y `merge`, ver 7.23) con 10 pruebas sobre binarios Mach-O fabricados (`tests/helpers/make-macho.js`). Dio los mismos números que las mediciones anteriores hechas con otro programa. El flujo de GitHub lo ejecuta también en Macs reales y lo contrasta con `lipo`.

**Estado final de las pruebas (código de 1.2.2, instalación limpia entre una pareja y otra):**
- Pareja moderna (Node 22 + `sharp` 0.35.5): 474 pruebas, 463 pasan, 11 omitidas (sin `rar`), 0 fallan, 0 avisos de obsolescencia. Interfaz 47/47 con Electron 44, idiomas 17/17, auditoría de código limpia.
- Pareja antigua (Node 18.16 de Electron 26 + `sharp` 0.33.5): 463 pasan, 0 fallan, 0 avisos propios (solo el del ejecutor de pruebas de Node 18, ver 7.24). Interfaz 47/47 con Electron 26, idiomas 17/17.
- Mac moderno y Mac antiguo: construidos, fusionados y revisados con `mac-app-tools` (moderno: macOS 13.0.0 declarado, 19 piezas; antiguo: 10.13.0, 20 piezas; en las dos, Intel + Apple Silicon y `src/` del `.asar` idéntico al fuente).
- Paquete de Linux (arranca, ZIP, vídeo, audio, HEIC) y verificador del paquete 7/7 con Electron 44. Instalador de Windows 1.2.2 (Electron 44.9.1, solo `sharp-win32-x64`) sin avisos y con `src/` idéntico al fuente.

**Lo que esta revisión NO puede asegurar:** lo mismo que en 7.25 (nada se ha ejecutado en macOS 10.13–12 ni en Windows real; GitHub todavía no ha corrido el flujo con estos cambios) y, por su naturaleza, cualquier fallo que solo se vea con un Mac o un Windows de verdad.

### 7.27 — Fallo que SOLO apareció en GitHub: electron-builder 26 ya no firma si no hay certificado

**Síntoma.** En la primera ejecución real de 1.2.2 (etiqueta `v1.2.2`) los dos `.dmg` y el `.exe` se construyeron, pero las 4 pruebas en Macs reales fallaron en el paso «Firma» (`codesign --verify`), que sí pasaba con 1.2.0.
**Causa (leída en `node_modules/app-builder-lib/out/macPackager.js` y `mac/MacTargetHelper.js`).** En electron-builder 25, si no había certificado pero sí `build.mac.sign`, se llamaba a esa función propia (`scripts/mac-sign.js`, que firmaba ad-hoc).
En la 26, `sign()` hace `if (!identity) return false` ANTES de mirar `sign`: sin certificado no firma nada ni llama a nuestra función. El `.app` salía SIN firma (en Apple Silicon: «está dañado»). Desde la 26 hay firma ad-hoc nativa: `identity: "-"`.
**Arreglo.** `build.mac.identity = "-"` + `build.mac.timestamp = "none"` (sin sello de hora de Apple, que necesita red) + `hardenedRuntime: false` (ya estaba). Se retira `scripts/mac-sign.js` y su prueba (código que la versión nueva hace innecesario);
`tests/mac-build-config.test.js` vigila ahora `identity`, `timestamp`, `hardenedRuntime` y que no vuelva la función propia.
**Lección.** La firma NO se puede probar desde Linux (`isSignAllowed()` es falso fuera de macOS): el paso «Firma» del flujo, en Macs reales, es la única comprobación, y detectó el fallo ANTES de publicar (el Release no se creó: depende de que las pruebas pasen).
**Estado:** corregido y CONFIRMADO en GitHub: tras el cambio, el paso «Firma» pasó en las 4 pruebas.

**Segundo hallazgo de la misma ejecución: Electron 44 y el Mac Intel de GitHub.** Solo fallaba «Mac moderno en Intel», en «Abrir la app de verdad». Se leyó el registro con un paso temporal que lo guardaba en una rama (luego retirado): en esa máquina virtual (macOS 15.7.9, sin tarjeta gráfica) `Initialization of all (1) EGL display types failed` →
`Exiting GPU process due to errors during initialization`; la página sí cargaba (`did-finish-load`) pero la captura (`UnknownVizError`) nunca terminaba. La misma app tardó 5 s en abrirse y capturar en Apple Silicon (macOS 26.6.2, con GPU virtual) y la variante antigua (Electron 26) pasa en la misma máquina Intel. Es una limitación del
servidor de pruebas, no de un Mac real; el paso lanza ahora la app con `--disable-gpu` (como las pruebas de Linux). **Posible mejora, no hecha:** Chromium reciente ya no cae solo a SwiftShader; quien ejecute el Mac moderno en una máquina virtual sin aceleración gráfica podría ver la ventana sin dibujar
(solución: `--disable-gpu` o `app.disableHardwareAcceleration()` automático ante la caída del proceso de GPU). La variante antigua no tiene ese problema.

## 8. Funciones agregadas sobre la marcha

- **Concurrencia segura**: procesamiento en paralelo (1 a 4 imágenes a la
  vez, según núcleos del equipo) en vez de estrictamente una por una. Es
  seguro porque cada trabajo es 100% independiente (su propio archivo de
  entrada y salida, sin estado compartido) — no hay condición de carrera
  posible entre trabajos concurrentes.
- **Botón Detener / Reanudar**: pausa la cola sin perder ni repetir trabajo.
  La imagen a mitad de proceso termina normalmente; ninguna nueva empieza
  hasta que se pulse Reanudar.
- **Botón Eliminar pendientes**: aparece junto a "Reanudar" cuando la cola
  está detenida y todavía queda algo en espera. En vez de continuar con lo
  pendiente, lo descarta por completo (pide confirmación antes, por ser
  irreversible): se quita de la lista y se borra su copia interna en
  `input/`, para que no reaparezca solo la próxima vez que se abra la app
  (la reanudación automática, ver sección 5, re-encola cualquier cosa que
  siga existiendo en `input/` sin salida en `output/`). Lo que ya estaba a
  mitad de proceso en ese momento no se toca, termina normalmente; lo que
  ya había terminado tampoco, para eso está "Limpiar completados".
- **Pegar con Ctrl+V**: soporta tanto archivos reales copiados (por ejemplo
  desde el explorador de Windows) como datos de imagen crudos sin archivo de
  origen (por ejemplo, una captura de pantalla copiada directo al
  portapapeles).
- **Perfiles de compresión**: además de los tres ajustes sueltos (calidad,
  modo agresivo, convertir a WebP), ahora se pueden guardar como perfiles
  con nombre propio (por ejemplo "Para imprimir" / "Para proyector") y
  cambiar entre ellos con un desplegable en el panel de Ajustes. Se puede
  crear, renombrar y eliminar perfiles (no se permite borrar el último que
  quede). Internamente, `quality`/`aggressive`/`convertToWebp` en la raíz
  del archivo de ajustes siguen siendo los valores "en uso" — el pipeline
  de compresión (`queue-manager.js`, `raster-optimizer.js`) no cambió ni
  una línea; los perfiles son una capa encima en `settings-store.js` que
  simplemente copia los valores del perfil elegido a esos tres campos al
  cambiar de perfil, y los escribe de vuelta al perfil activo cuando se
  toca un slider/interruptor directamente.
- **Manejo de errores de punta a punta**: cualquier error inesperado en el
  proceso principal se comunica a la interfaz con un aviso visible, en vez
  de fallar en silencio o cerrar la app.
- **Aviso al importar archivos no compatibles** (por ejemplo `.heic` de
  iPhone): antes se ignoraban en silencio; ahora se cuentan y, si son HEIC,
  se avisa explícitamente que hay que convertirlos a JPG primero. Aplica a
  las cuatro formas de importar (arrastrar, botón de archivos, botón de
  carpeta, pegar).
- **Notificación del sistema** al terminar de procesar 5 fotos o más de
  una vez, solo si la ventana no tiene el foco.
- **Atajo de teclado**: barra espaciadora alterna Detener/Reanudar (se
  ignora si el foco está en un campo de texto/slider o con Ajustes abierto).
- **Cuadro de diálogo propio** para pedir texto/confirmar (crear/renombrar
  perfil, eliminar pendientes): reemplaza a `window.prompt`/`window.confirm`,
  que en Electron no son fiables (ver 7.9).
- **Notificación de lote terminado por dos canales**: un aviso dentro de la
  propia app (siempre se ve) y la notificación del sistema operativo,
  independientes entre si.

## 9. Verificación realizada

- **65 pruebas automatizadas** (`npm test`), que además de todo lo de la
  sección anterior cubren: el grupo de workers y el resumen real de lote
  (`tests/queue-batches.test.js`), el aviso de lote terminado
  (`tests/notifier.test.js`), la seguridad y las URLs del protocolo de
  archivos (`tests/protocol.test.js`), las colisiones de nombre de salida
  y los ajustes inválidos (`tests/raster-optimizer-extra.test.js`,
  `tests/settings-store-hardening.test.js`), y que el id de Windows no se
  desincronice de `package.json` (`tests/app-id.test.js`, ver 7.12).
- **Prueba de interfaz real** (`npm run test:ui`, `tests/ui-test-electron.js`):
  abre la app de Electron de verdad (no simulada) y hace clic (incluido con
  coordenadas de ratón reales, no solo `.click()` por JavaScript — ver
  7.11), teclea y cierra/reabre la ventana como lo haría una persona — 25
  verificaciones, incluyendo el escenario exacto de macOS (cerrar la
  ventana y reabrirla desde el Dock) sin tener una Mac disponible para
  probar, emulando `process.platform`, y todos los bugs reportados de 7.10
  y 7.11 reproducidos y corregidos. Existe porque varios de esos bugs eran
  invisibles para pruebas unitarias que no abren una ventana real — pero,
  igual que `npm test`, corre sobre el código fuente sin empaquetar, no
  sobre el `.asar` real (ver el punto siguiente).
- **Prueba sobre el `.asar` YA EMPAQUETADO** (`npm run build:linux-dir` +
  `npm run test:packaged`, `tests/packaged-smoke-test-electron.js`, nueva
  en 7.12): arranca el paquete real que sale de `electron-builder` — el
  mismo `package.json` recortado, el mismo código ya empaquetado — y
  comprueba que no lanza ninguna excepción al arrancar y que la ventana
  carga bien. Existe porque las otras dos pruebas, por completas que sean,
  corren sobre el código fuente y no pueden detectar un bug que solo
  existe en la diferencia entre el código fuente y el paquete final (ver
  7.12 para el caso real que la motivó). Se corre sobre Linux por
  simplicidad (no hace falta wine para generar este build, solo para el
  instalador de Windows final), pero el empaquetado con `electron-builder`
  recorta `package.json` de la misma forma sea cual sea el sistema
  operativo de destino, así que la prueba es igual de válida.
  (perfiles, miniaturas, macOS, foco del teclado, area de clic real) eran
  invisibles para pruebas unitarias que no abren una ventana real.
- **Prueba end-to-end sobre Electron real** (`npm run test:e2e`): importa un
  lote de 12 fotos dentro de una carpeta con subcarpetas, verifica que se
  procesan todas sin error, que no quedan temporales huérfanos, que todos
  los archivos de salida son válidos, y que la reanudación detecta
  correctamente un archivo nuevo agregado después.
- **Prueba manual de pausa/reanudación sobre Electron real**: se encoló un
  lote, se pausó a mitad de camino (quedaron 7 de 8 pendientes), se reanudó,
  y terminaron las 8 sin errores.
- **Instalación real dentro de Windows emulado (Wine)**: se instaló el
  `.exe` de verdad (modo silencioso `/S`), confirmando que el desinstalador
  se genera solo (`Uninstall Compacta.exe`), que queda registrado
  correctamente en el sistema (`Publisher`, `DisplayName`,
  `UninstallString`), y que desinstalar el programa no toca la carpeta de
  fotos del usuario (que vive en `Documentos\Compacta`, fuera de la carpeta
  de instalación del programa).

## 10. Decisiones de diseño y por qué

- **¿Por qué no vectorizar las fotos (convertir a SVG)?** Se consideró
  explícitamente. Para fotografías reales no aporta ahorro real (los
  compresores raster modernos ya comprimen las zonas planas casi al límite
  teórico) y sí introduce riesgo de artefactos visibles en los bordes entre
  zonas vectorizadas y zonas raster, además de ser mucho más lento. Solo
  tendría sentido para logos/íclike 100% planos sin fotografía de por medio
  — una función aparte, no aplicable al caso de uso de fotos de la iglesia.
- **¿Por qué concurrencia acotada (máx. 4) y no ilimitada?** Da la mayor
  parte de la ganancia de velocidad disponible sin arriesgar saturar
  memoria o disco con lotes muy grandes en equipos modestos.
- **¿Por qué instalación "por usuario" (sin pedir admin) en vez de "por
  máquina"?** Las computadoras de iglesia suelen tener permisos
  restringidos; instalar sin necesitar contraseña de administrador elimina
  una fuente común de fricción para gente sin conocimientos técnicos.
- **¿Por qué no deshabilitar la posibilidad de desinstalar?** Un programa
  que no se puede desinstalar normalmente es indistinguible, en
  comportamiento, de software malicioso — dispararía advertencias de
  antivirus y rompería la confianza de quien lo recibe. El desinstalador
  estándar de Windows (incluido de fábrica en este tipo de instalador) se
  dejó funcionando normalmente.

## 11. Cómo compilar / distribuir

El ffmpeg de cada plataforma lo prepara `scripts/prepare-ffmpeg.js` (en
`vendor/`, ver 7.15); los scripts `predist:*` lo hacen solos. Para empaquetar
desde Linux ver la receta de la sección 13.

Ver `README.md` para instrucciones completas de desarrollo y compilación
(`npm start`, `npm test`, `npm run dist:win`, `npm run dist:mac`, `npm run dist:mac-legacy`, y el flujo
de GitHub Actions incluido en `.github/workflows/build.yml`, que genera el `.dmg`
único de Mac y el `.exe` en la nube, y PRUEBA el `.dmg` en Macs reales; ver 7.23).

## 12. Limitaciones conocidas

- El `.dmg` de macOS no se puede generar desde Linux/Windows (la fusión Intel + Apple Silicon necesita `lipo` y el `.dmg` `hdiutil`): se genera en GitHub
  Actions (ver 7.23 y 7.25). Desde Linux sí se pueden construir y fusionar los `.app` para inspeccionarlos.
- **Mac:** dos instaladores, moderno (macOS 13 o posterior) y antiguo (macOS 10.13 a 12; Intel desde 10.13, Apple Silicon desde 11), ver 7.25. macOS 10.12 o anterior no se soporta (el hardware que corre
  10.12 puede actualizarse gratis a 10.13). Nada específico de Mac se ha ejecutado en un Mac real aparte de lo que hace GitHub (macOS reciente). Sin certificado de Apple,
  la primera vez hay que abrirla con «Abrir» / «Abrir igualmente». RAR5 puede no abrirse con el `tar` de un macOS antiguo (respaldo con 7-Zip; ver 7.15).
- Subtítulos en archivo aparte: desde la 1.0.9 viajan con el video (7.16). Un
  `.srt` sin video al lado, o de otra película, se cuenta como no compatible.
- Un video con subtítulos ASS o de imagen sale como `.mkv`, no `.mp4`.
- La conversión a AVIF no está expuesta como opción en la interfaz (el
  motor la soporta si se recibe un archivo `.avif`, pero no hay un botón
  "convertir a AVIF").
- El botón Detener no interrumpe lo que ya está a mitad de codificación
  (termina eso, no arranca lo siguiente) — evita dejar un archivo a medias.
  En un video largo eso puede tardar varios minutos.
- Los `.heic`/`.heif` se leen desde 1.1.0 (7.21), pero HEIC ya es muy eficiente: si pasarlo a JPG/WebP pesa más, se
  conserva tal cual. Se decodifica de una en una (~2-3 s por foto de 12 MP). Solo se corrigen los colores Display P3.
- Si la carpeta `Documentos` del usuario está redirigida a un servicio de
  sincronización en la nube (OneDrive en Windows, iCloud Drive en Mac) con
  la opción de liberar espacio/"archivos bajo demanda" activada, es posible
  que el contenido de `Documentos\Compacta\output` no esté disponible
  localmente en todo momento, lo que podría interferir con la detección de
  "ya procesado" al reabrir la app (ver 7.6, en investigación).

## 13. Guía para continuar en otro chat (leer ANTES de tocar nada)

Esta sección existe porque el trabajo se ha ido pasando entre conversaciones
y los mismos errores se repiten si no están escritos. Léela entera.

### 13.1 Estado actual (v1.2.2)
- **Revisión exhaustiva previa a publicar (7.26):** código muerto eliminado, desajustes de documentación corregidos, herramienta permanente `scripts/mac-app-tools.js`, pruebas completas con cada pareja de motor.
- **1.2.2 (7.25): dos instaladores de Mac** (moderno macOS 13+ con el mismo motor que Windows; antiguo macOS 10.13–12 con Electron 26), paridad Windows↔Mac revisada, menú de ejemplo quitado en Windows,
  avisos de permisos de macOS en 6 idiomas, `sharp` 0.35.5 salvo en el Mac antiguo.
- **1.2.0 (7.23): Mac terminado.** Un solo `.dmg` universal (Electron 26, desde macOS 10.13), botones de ventana, menú propio, Rosetta para Apple Silicon con macOS 11,
  firma ad-hoc, flujo de GitHub que lo prueba en Macs reales. Windows sin cambios de funcionamiento. Pruebas: ver 7.23 y 7.24 (revisión de calidad).
- **1.1.0 (7.21 y 7.22):** carpetas con el mismo nombre se unen (sin «(2)»), ZIP con contraseña, opción HEIC → JPG; empieza a comprimir antes (índice de duplicados compartido y entrega por tandas), 6 idiomas (es, en, de, it, vi,
  ar con RTL; se elige en Ajustes), fotos HEIC (libheif-js en un hilo), audio con un solo ffmpeg para analizar. Pruebas: 394
  unitarias, 40 de interfaz, 17 de idiomas, paquete real de Linux.
- **Audio** (v1.0.11, ver 7.18; mejorado en 1.0.12, ver 7.19): más de 40 formatos, también los de Mac; mono real, modo voz, formato Compatible/Opus/FLAC, portadas reducidas.
- Fotos (JPG, PNG, WebP, TIFF, AVIF, GIF), **videos** (45 formatos desde 1.0.12, salen
  `.mp4`, o `.mkv` si llevan subtítulos que el MP4 no admite) y
  **comprimidos** (zip, rar, 7z, tar, tar.gz/bz2/xz, también anidados).
- Además (1.0.9, corregido en 1.0.10 ver 7.17): progreso global con tiempo restante, vista previa antes/después,
  carpeta de salida elegible, omitir duplicados, subtítulos en archivo aparte y
  reordenar la cola (ver 7.16).
- Verificado de verdad: pruebas unitarias (309 en total; en este sandbox 8 omitidas por no haber `rar` y con `bsdtar` instalado pasan todas las demás), 39 de
  interfaz en Electron real (incluye arrastre real de la vista previa, ventana de 760×520 y vista previa de video), el paquete real de Linux, y los videos contra el
  `ffmpeg.exe` exacto del instalador bajo wine.
- **NO verificado: ejecutar el instalador en un Windows real; todo lo que sea
  ejecutar en un Mac real** (ver 7.15, 7.23 y 7.25; GitHub prueba los dos `.dmg` en un Mac Intel y uno Apple Silicon recientes, no en macOS 10.13–12).
  Ante un reporte de un Mac, es lo primero que hay que sospechar.

### 13.2 Preferencias de la persona (importantes)
- Habla en español. Valora código bueno y eficiente, **sin dependencias
  innecesarias**, sin "cosas raras" ni llamadas raras, sin romper lo que ya
  funciona. Las dependencias actuales: `sharp`, `yauzl`, `libheif-js` (HEIC, 1.1.0, ver 7.21; LGPL-3.0) y, solo de desarrollo,
  `electron`, `electron-builder`, `ffmpeg-static`. No añadir otras sin una
  razón fuerte que se le explique.
- Para el usuario final todo debe ser "instalar y usar": nada que instalar
  aparte (ffmpeg va dentro; los comprimidos usan el `tar` del sistema).
- **Entrega siempre como UN solo zip** con esta estructura (la del zip
  original que él mandó): `Compacta/` con `Compacta Setup X.Y.Z.exe`,
  `LEEME.txt` y `codigo-fuente/` (sin `node_modules`, `dist`, ni `vendor`).
  El `.exe` debe ser de la MISMA versión y del MISMO código que el fuente.
- Quiere que se **verifique de verdad** y se le diga con honestidad lo que
  no se pudo probar. Se enfada (con razón) cuando se afirma algo sin
  comprobarlo o cuando se entrega algo que no coincide con lo anunciado.
- Quiere los `.md` actualizados con lo hecho y los bugs encontrados.

### 13.3 Entorno de trabajo (sandbox Linux) y cómo reconstruirlo
La red del sandbox solo permite `github.com`, `registry.npmjs.org`, los
repositorios de Ubuntu y poco más. Receta:
```
npm install                                   # en codigo-fuente/
apt-get install -y xvfb libarchive-tools p7zip-full rar   # pruebas (rar: multiverse)
# Para generar el .exe de Windows desde Linux hace falta wine COMPLETO:
dpkg --add-architecture i386 && apt-get update
apt-get install -y wine64 wine32:i386
ln -sf /usr/lib/wine/wine /usr/bin/wine       # electron-builder busca "wine"
export WINEDEBUG=-all WINEPREFIX=/tmp/wineprefix2 DISPLAY=
```
- Falta `wine32` -> falla el paso del desinstalador NSIS y el instalador sale
  de ~570 KB (incompleto) sin que parezca un error grave. `wine64` solo no
  basta: `rcedit` y NSIS usan binarios de 32 bits.
- El `apt-get update` da error por el repositorio de nodesource (403); es
  inofensivo para lo demás.
- **Disco:** wine + Electron + cachés ocupan varios GB y el sandbox tiene poco libre (se acabó en 1.1.0: «No space left on device»
  dentro de wine, con un error confuso de `rcedit`). Borrar datos de medición (`/tmp/...`), `dist/*-unpacked` y `apt-get clean`.
- Para los HEIC de prueba: `pip install pillow-heif pillow --break-system-packages` (sin eso, esas pruebas se omiten).

### 13.4 Comandos de verificación (todos desde `codigo-fuente/`)
```
npm test                                                        # unitarias (~4 min)
xvfb-run -a npx electron --no-sandbox --disable-gpu tests/ui-test-electron.js   # interfaz real
npm run build:linux-dir && xvfb-run -a npm run test:packaged -- --no-sandbox    # paquete real
npm run dist:win                                                # instalador Windows (~5 min)
COMPACTA_SHOTS=/tmp/shots xvfb-run -a npx electron --no-sandbox tests/ui-i18n-electron.js   # idiomas (y capturas para MIRAR)
xvfb-run -a npx electron --no-sandbox --force-device-scale-factor=2 tests/ui-test-electron.js   # alta densidad simulada
npm run predist:mac && npx electron-builder --mac dir --universal                                    # los dos .app del Mac MODERNO (la fusion: ver 7.23)
npm run predist:mac-legacy && npx electron-builder --mac dir --universal -c.electronVersion=26.6.10 -c.mac.minimumSystemVersion=10.13.0   # los del ANTIGUO
node scripts/mac-app-tools.js merge && node scripts/mac-app-tools.js check   # (Linux, con lipo) fusiona los dos paquetes y revisa arquitecturas y macOS minimo de cada pieza
npm ci   # entre una pareja de sharp y otra (0.35.5 <-> 0.33.5): si no, sharp cae al respaldo wasm y Node avisa (7.25)
ELECTRON_RUN_AS_NODE=1 /ruta/electron26 --test tests/*.test.js                 # pruebas con el Node 18 del Mac antiguo (con sharp 0.33.5)
ELECTRON_RUN_AS_NODE=1 <motor> scripts/verify-packaged-engine.js <carpeta resources>   # comprime de verdad con el paquete
COMPACTA_FFMPEG_PATH=/tmp/ffwine.sh node --test tests/video-optimizer.test.js   # video con ffmpeg.exe
```
Para `COMPACTA_FFMPEG_PATH`: `/tmp/ffwine.sh` es un script de 3 líneas que
hace `exec wine <ruta>/ffmpeg.exe "$@"`.

### 13.5 Trampas del proceso (cada una costó tiempo o credibilidad)
1. **Comandos de más de ~300 s se cortan, y los procesos en segundo plano
   mueren al terminar la llamada** (incluso con `nohup`/`setsid`; a veces
   sobreviven y a veces no). `npm run dist:win` tarda ~5 min: ejecutarlo en
   PRIMER plano con `timeout 295`. Las pruebas largas se parten en tandas
   (`--test-name-pattern`).
2. **Verificar contra el código que se entrega.** Se dio un instalador 1.0.7
   sin videos cuando ya se hablaba de videos; el usuario lo probó y "no
   reconocía nada". Antes de investigar un "no funciona", confirmar QUÉ
   versión tiene la persona. Y reconstruir el `.exe` si se toca CUALQUIER
   archivo de `src/` después de compilarlo (se comprueba extrayendo un archivo
   del asar a una carpeta temporal y haciendo `diff`).
3. **Probar el paquete real, no el código fuente.** Dos veces falló el
   paquete (`.asar`) estando el fuente bien (`appId`, módulos nativos).
4. **Pruebas que miran el mecanismo y no el resultado** dejan pasar bugs: la
   prueba de la "X" del aviso comprobaba la clase `hidden`, no que dejara de
   verse. Comprobar lo que SE VE (`getComputedStyle`, alto real).
5. **No afirmar una verificación que no se hizo.** Se dijo que los formatos
   se habían probado con el ffmpeg de Windows cuando la variable de entorno
   usada no existía en el código. Si una prueba "pasa" sorprendentemente
   rápido o sin cambios, comprobar que ejerce lo que dice ejercer.
6. **Comando de comprobación destructivo:** `npx asar extract-file` extrae en
   el directorio actual (pisó `package.json`). Extraer siempre en `/tmp/…`.
7. **CSS:** `.hidden` lleva `!important` a propósito; sin eso, cualquier
   `display` de un componente declarado después lo anula (7.13).
8. **Las pruebas de teclado de la interfaz necesitan un lote LENTO**; con el
   JPG rápido por defecto acaban en un parpadeo. Usan `maxCompression: true`.
9. **`files` por plataforma sustituye al global** en electron-builder (7.15).
10. **ffmpeg:** el analizador de `ffmpeg -i` no puede suponer un formato fijo
    (comas dentro de paréntesis en `yuv420p10le(tv, bt709…)`, subtítulos con
    `[0x..]` antes o después del idioma). La build estática de Linux se cae
    (SIGSEGV) leyendo MPEG-TS; la de Windows no.
11. **7-Zip/tar:** ver los puntos 2–5 de "Bugs encontrados" en 7.15.
12. **Grandes listas:** no usar `push(...lista)` (revienta a ~100.000
    elementos); no recorrer la lista entera por evento (cola, 7.13).
13b. **(1.1.0) `npm run dist:win` reemplaza `sharp` por el de Windows** (`predist:win`): después las pruebas locales de Linux no
    funcionan hasta un `npm install`. Orden: pruebas y paquete de Linux PRIMERO, instalador de Windows al final.
13c. **(1.1.0) Mirar las capturas.** Los desórdenes del árabe (tamaños invertidos) y la fuente que no tenía las tildes del
    vietnamita solo se vieron mirando las imágenes; ninguna prueba automática los detectaba. Hacer **mutaciones** (romper la
    pieza a propósito y ver que la prueba falla): una prueba mía de «hermanos» pasaba sin ejercer lo que decía ejercer.
13. **Windows:** un antivirus puede tener el archivo "agarrado" justo tras
    crearlo; el renombrado se reintenta (`renameWithRetry`).
14. **Instalar `sharp` de otra plataforma** (`predist:*`) cambia los
    binarios nativos de `node_modules`; las pruebas de Linux siguen
    funcionando porque el de Linux no se borra, pero conviene correr primero
    las pruebas y después los `predist`.
15. **No ejecutar `rar`/`7z` de prueba con sus opciones por defecto** y fiarse:
    RAR 7.0 comprime con un diccionario enorme que 7-Zip 23 no abre; las
    pruebas fijan `-md32m` o `-m0` según lo que midan.

16. **No borrar `dist/` después de compilar el instalador.** Se hizo
    (`rm -rf dist` para reconstruir el paquete de Linux de pruebas) y hubo que
    recompilar el `.exe` de Windows (5 minutos). En cuanto termine
    `npm run dist:win`, copiar el `.exe` a un sitio seguro (`/tmp/release/`).
17. **Orden recomendado de trabajo:** primero el código y las pruebas;
    después los `predist`/paquetes; al final, copiar el instalador, verificar
    su contenido (`diff -r src` contra el asar extraído a `/tmp`) y armar el zip.

18. **Mac ya no está aplazado (v1.2.0, 7.23).** Lo que NO se puede dar por hecho: que funcione en un Mac real. Mantener `PRUEBAS-EN-MAC.md` al día con cada función nueva y,
    ante cualquier cambio de `package.json` → `build.mac`, de la firma (`identity`/`timestamp`) o del `.github/workflows/build.yml`, repetir la fusión universal de 7.23 (la rompió ya una vez algo tan
    pequeño como un archivo de licencia distinto). El Mac se compila con otro Electron que Windows: **toda función nueva debe probarse con los dos** (ver 13.4).
19. **Una función nueva que toque importación necesita revisar `skipDuplicates`
    en las pruebas** (ver 7.16): si importa el mismo archivo sintético varias
    veces, hay que apagarlo en esa prueba, o dar contenido distinto a cada archivo
    (la prueba del paquete añade unos bytes finales distintos a un JPEG mínimo: un
    JPEG ignora lo que va después de su marcador de fin).
20. **Aislar los datos de una prueba bajo Electron con `app.setPath`**, no con
    `COMPACTA_TEST_BASE_DIR` (ver 7.16, punto 10).
21. **Comprobar el código de salida de las pruebas, no solo filtrar su texto con
    `grep`**: un `exit=124` (tiempo agotado) es una prueba colgada, aunque el
    filtro no muestre ningún FAIL. Y no filtrar con `grep -v ERROR` al buscar la
    causa de un cuelgue: se esconde el mensaje real.

### 13.6 Variables de entorno de diagnóstico
`COMPACTA_TEST_BASE_DIR` (aísla datos en pruebas), `COMPACTA_FFMPEG_PATH`,
`COMPACTA_TAR_PATH`, `COMPACTA_SEVENZIP_PATH` (`none` lo desactiva),
`COMPACTA_DEBUG` y `COMPACTA_SCREENSHOT=<ruta.png>` (captura de la ventana,
útil para revisar la interfaz sin pantalla). En la prueba de interfaz,
`UI_SHOT_DIR=<carpeta>` guarda capturas del modal y de Ajustes para revisarlas a
ojo (así se encontró el deslizador demasiado corto).

### 13.7 Mapa de pruebas
`tests/*.test.js` (unitarias; `node --test`), `tests/ui-test-electron.js`
(interfaz real), `tests/packaged-smoke-test-electron.js` (paquete real),
`tests/smoke-test-electron.js` (arranque), `tests/ui-i18n-electron.js` (idiomas, 1.1.0), `tests/zip-password.test.js` y `tests/import-merge.test.js` (1.1.0, 7.22), `tests/app-menu.test.js`, `tests/preload-compat.test.js`, `tests/mac-build-config.test.js`, `tests/macho.test.js` y `tests/mac-app-tools.test.js` (1.2.0 y 1.2.2, 7.23 y 7.25), y `tests/helpers/` con
generadores de ZIP (`make-zip.js`), videos reales (`make-video.js`,
`make-video-formats.js`, con subtítulos incluidos) y comprimidos reales
(`make-archive.js`: usa `tar`, `7z` y `rar` si están instalados; `make-heic.js`: HEIC reales con `pillow-heif`; `make-encrypted-zip.js`: ZIP cifrados reales con `zip` y `pyzipper` (`pip install pyzipper --break-system-packages`); si falta
una herramienta, esa prueba se omite en vez de fallar).

### 13.8 Qué conviene hacer a continuación
Ver `MEJORAS.md` (sección "Pendientes"). Lo más importante antes de nada
nuevo: que alguien pruebe el instalador en un Windows real y la app en un
Mac real (Intel y Apple Silicon) y se anote aquí qué pasó.
