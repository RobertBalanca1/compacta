# Compacta en Mac: qué se implementó y cómo comprobarlo

**Estado (v1.2.2): implementado y verificado todo lo que se puede verificar SIN un Mac; lo demás lo prueba GitHub en Macs reales
(Intel y Apple Silicon) en cada ejecución del flujo, y el resto está en esta lista para probarlo a mano.** Qué se hizo y cómo se
midió: `DOCUMENTACION-PROYECTO.md`, 7.23. Este archivo sirve para que cualquiera con un Mac compruebe rápido qué funciona y mande el
resultado de forma que se pueda arreglar sin adivinar.

---

## 1. Cómo ayudar (5 minutos)

1. Obtén la app de Mac (sección 2).
2. Haz las pruebas de la sección 4 que puedas; no hace falta todas.
3. Rellena la plantilla de la sección 7 y envíala (con capturas de pantalla si algo se ve raro).

Dato imprescindible de cada prueba: **modelo de Mac (Intel o Apple Silicon), versión de macOS** (menú Apple → Acerca de este Mac) y
versión de Compacta (se ve en el nombre del instalador). Las versiones viejas de macOS (10.13, 10.14, 10.15) son las que GitHub
NO puede probar: si tienes una, es la ayuda más valiosa. (¿Un Mac con macOS 10.12 o más viejo? Apple publica la misma lista de equipos compatibles para 10.12 y para
10.13, así que se actualiza gratis a 10.13 desde la App Store; Compacta no arranca en 10.12.)

---

## 2. Cómo conseguir la app para Mac

Hay **dos instaladores** (cada uno un solo `.dmg` universal, Intel + Apple Silicon): `Compacta-1.2.2-Mac.dmg` (macOS 13 o superior, mismo motor que Windows) y
`Compacta-1.2.2-Mac-antiguo.dmg` (macOS 10.13 a 12, motor Electron 26; puede tener algún problema que la normal no tiene). Ninguno se puede generar fuera de un Mac. Dos caminos:

- **GitHub Actions** (recomendado): subir `codigo-fuente/` a un repositorio de GitHub y ejecutar el flujo `.github/workflows/build.yml`
  (pestaña Actions → Construir instaladores → Run workflow). Genera los dos `.dmg`, los prueba en un Mac Intel y uno Apple Silicon reales, y
  los deja en «Artifacts» (o en «Releases» si se lanza con una etiqueta `v…`).
- **En un Mac**: `cd codigo-fuente && npm ci && npm run dist:mac` (o `npm run dist:mac-legacy`) (descarga las librerías de imagen y el ffmpeg de las dos
  arquitecturas; necesita internet).

**Al abrirla por primera vez** macOS dirá que no puede verificar al desarrollador (la app lleva firma «ad-hoc», gratuita, pero no está
notarizada por Apple). Es lo esperado:

- **macOS 14 (Sonoma) o anterior:** clic derecho (o Control + clic) sobre la app → **Abrir** → **Abrir**.
- **macOS 15 (Sequoia) o posterior:** el clic derecho ya no sirve. Intenta abrirla una vez (saldrá el aviso; pulsa «Hecho»/«Cancelar»), y
  ve a **Ajustes del Sistema → Privacidad y seguridad**, baja hasta «Seguridad» y pulsa **Abrir igualmente**.
- Si no aparece el botón, o dice «dañada»: en la app **Terminal**, `xattr -dr com.apple.quarantine /Applications/Compacta.app`.

---

## 3. Qué se verificó SIN Mac (y qué no)

Verificado (repetible: `DOCUMENTACION-PROYECTO.md`, 7.23 y 7.25), en las DOS variantes (moderna y antigua):

| Qué | Resultado |
|---|---|
| Un solo `.app` por variante con las dos arquitecturas | Ejecutable, Electron y ffmpeg son «fat» (x86_64 + arm64), fusionados con la misma herramienta (`@electron/universal`) que usa electron-builder |
| macOS mínimo declarado (`LSMinimumSystemVersion`) | Moderna: 13.0.0. Antigua: 10.13.0 |
| Mínimos medidos en las cabeceras Mach-O | **Moderna** (Electron 44, `sharp` 0.35): Electron 13.0 en Intel y Apple Silicon; `sharp`/libvips 10.15 (Intel) y 11.0 (Apple Silicon); ffmpeg 10.13 y 12.0. **Antigua** (Electron 26, `sharp` 0.33.5): Intel todo 10.13; Apple Silicon 11.0 salvo ffmpeg **12.0** (cubierto con Rosetta en macOS 11) |
| Menú, hueco de los botones, pantalla completa | Probados en la interfaz real de Electron (simulando Mac): 47/47 con Electron 44 (Mac moderno y Windows) y con Electron 26 (Mac antiguo) |
| Las pruebas del proyecto con el motor de cada variante | Moderna: Node 22 + `sharp` 0.35.5. Antigua: el Node 18.16 de Electron 26 + `sharp` 0.33.5. Las dos pasan completas |
| `.asar` de cada `.dmg` | Su `src/` es idéntico al del código fuente |

**NO verificado** (hay que verlo en un Mac real; GitHub cubre parte, ver la sección 3 bis): que macOS deje ejecutar el ffmpeg incrustado,
que `/usr/bin/tar` abra cada formato en cada versión de macOS, el aspecto real de los botones de la ventana sobre la barra, notificaciones,
Dock, diálogos nativos, permisos de Documentos/Escritorio, y **todo en macOS 10.13–10.15 y en Apple Silicon con macOS 11 (Rosetta)**.

### 3 bis. Lo que prueba GitHub en cada ejecución (cada una de las dos variantes, en un Mac Intel y uno Apple Silicon reales: 4 pruebas, macOS reciente)

Abre el `.dmg` y copia la app; comprueba las dos arquitecturas y el macOS mínimo; `codesign --verify --deep --strict` y firma ad-hoc;
**comprime de verdad una foto JPG, un HEIC (fabricado por el propio macOS), un vídeo y un audio** con el Electron, `sharp`, libvips,
libheif y ffmpeg que lleva la app; abre la app real y comprueba que la ventana carga (guarda una captura); y (en la variante moderna) pasa `npm test`. Si algo de
eso falla, el flujo se pone en rojo y dice qué.

---

## 4. Lista de comprobaciones

Cada una: **qué se implementó → cómo comprobarlo → resultado esperado → dónde
mirar si falla.**

### A. Instalación, arranque y ventana

**A1. La app arranca.**
Abrir la app tras el paso de la sección 2. Esperado: ventana con "Compacta" y
la zona de soltar archivos, sin errores. Si no abre: lanzarla desde Terminal
(`/Applications/Compacta.app/Contents/MacOS/Compacta`) y copiar lo que imprima.

**A2. Botones de la ventana (CORREGIDO en 1.2.0, falta verlo en un Mac real).**
Implementado: `titleBarStyle: 'hiddenInset'` con `trafficLightPosition` `{x: 18, y: 25}` (`src/main/index.js`); la interfaz marca
`html[data-platform='mac']` y la barra superior deja 88 px a la izquierda (también en árabe: en macOS los botones no se invierten), mide 64 px
para quedar centrada con ellos, y en pantalla completa el hueco desaparece (`styles.css`, `.topbar`). Probado con Electron simulando Mac
(geometría en español y árabe, ventana normal y mínima). **Comprobar en un Mac real:** que los tres botones quedan a la izquierda del
logotipo, centrados con él y sin tocarlo; que se puede arrastrar la ventana agarrando la barra; que en pantalla completa (⌃⌘F) el logotipo
se mueve a la izquierda.

**A3. Icono.** Debe verse el icono de Compacta en el Dock y en Aplicaciones
(`build/icon.icns`). Si sale el icono genérico de Electron, está mal generado.

**A4. Menú de la aplicación (HECHO en 1.2.0, falta verlo en un Mac real).**
Menú propio (`src/main/app-menu.js`) en el idioma de la app: Compacta (Acerca de, Ocultar, Salir), Archivo (Abrir carpeta de salida ⇧⌘O,
Cerrar ventana), Edición (Deshacer…Seleccionar todo), Visualización (pantalla completa) y Ventana. **Sin** «Herramientas de desarrollo» (solo con
`npm run dev`). Comprobar: ⌘Q cierra del todo, ⌘C/⌘V/⌘X/⌘Z funcionan (también ⌘V con una imagen en el portapapeles), ⌘W cierra la ventana,
⌘H oculta, y que al cambiar el idioma en Ajustes el menú cambia de idioma al instante.

**A5. Cerrar la ventana no cierra la app (comportamiento normal de Mac).**
Cerrar con el botón rojo y pulsar el icono del Dock: la ventana vuelve
(`activate` en `src/main/index.js`). ⌘Q sí cierra.

### B. Fotos

**B1. Elegir archivos / carpetas / ZIP.**
Botones "Elegir archivos", "Elegir carpetas" y "Elegir comprimido". En "Elegir
carpetas" se pueden seleccionar varias con **⌘+clic**. Esperado: las fotos se
comprimen y salen en `~/Documents/Compacta/output/` con la misma estructura de
carpetas.

**B2. Arrastrar y soltar.** Arrastrar fotos y carpetas desde el Finder a
cualquier parte de la ventana. Esperado: se importan. (Soltar fuera del recuadro
no debe hacer que la ventana "abra" la foto.)

**B3. Pegar desde el portapapeles.** Copiar una imagen (⌘C en el navegador o una
captura al portapapeles con ⌃⇧⌘4) y pulsar **⌘V** en la ventana. Esperado: se
importa como imagen pegada. El texto de ayuda debe decir "⌘V", no "Ctrl+V"
(`src/renderer/js/app.js`).

**B4. Permiso de macOS para Documentos.**
La primera vez, macOS puede preguntar "Compacta quiere acceder a archivos de la
carpeta Documentos": hay que aceptar. Si se deniega, los errores de escritura
deberían verse claramente en la cola. Anotar qué se ve.

**B5. Aviso de iCloud.**
Con "Escritorio y Documentos en iCloud Drive" activado, Compacta debería mostrar
el aviso amarillo (el texto menciona OneDrive/iCloud) y la "X" debe cerrarlo
(`src/main/paths.js`, detección de `~/Library/Mobile Documents/...`).

**B6. Nombres con tilde y emoji.** Fotos llamadas `Canción 🎉 ñandú.jpg`. Esperado:
se procesan, y al reabrir la app **no** se vuelven a procesar (los nombres se
comparan en forma Unicode normalizada: `foldName` en
`src/main/processor/formats.js`; macOS suele guardarlos descompuestos).

### C. Vídeo

**C1. Mac Intel (x64) y Apple Silicon con macOS 12 o superior.**
Implementado: un ffmpeg distinto por arquitectura dentro de cada `.app`
(`Contents/Resources/ffmpeg/ffmpeg`), elegido por `extraResources` con la macro
`${arch}` (`package.json`) y localizado en `src/main/processor/ffmpeg.js`.
Comprobar con un `.mp4`, un `.mov` de iPhone y un `.mkv`. Esperado: la fila
muestra "Comprimiendo vídeo… NN %", termina y sale un `.mp4` más pequeño que
**se reproduce** en QuickTime.
Si falla con un error del sistema ("no se puede abrir", "operation not
permitted", "killed"): es Gatekeeper o la falta de firma del ffmpeg incrustado.
Anotar el mensaje exacto. Pistas: `ls -l@ .../Resources/ffmpeg/ffmpeg` y
`xattr -l`; probar `xattr -dr com.apple.quarantine /Applications/Compacta.app`.

**C2. Apple Silicon con macOS 11 (Big Sur) — por Rosetta (NUEVO en 1.2.0, no ejecutado en un Mac con macOS 11).**
Implementado: el ffmpeg de Apple Silicon pide macOS 12, pero el mismo archivo lleva también la parte Intel (es «fat»); `ffmpegLaunch()`
(`ffmpeg.js`) lo lanza con `arch -x86_64` cuando detecta arm64 + Darwin < 21 y que Rosetta funciona. Esperado: con Rosetta instalada, los
vídeos y audios se comprimen con normalidad (algo más lentos: es traducción). Sin Rosetta: mensaje claro con el comando
`softwareupdate --install-rosetta --agree-to-license`, y las fotos funcionan igual. **Anotar** si funcionó y la velocidad.

**C3. Un vídeo de iPhone en HDR (HEVC 10 bits).** Esperado: sigue siendo HEVC de
10 bits (`hvc1`), con los colores correctos (no apagados).

**C4. Prioridad y cierre.** Mientras se comprime un vídeo largo, la interfaz debe
seguir fluida (`os.setPriority`). Al cerrar la app con ⌘Q **no** debe quedar un
proceso `ffmpeg` en la Monitor de Actividad (`will-quit` en `index.js`).

### D. Subtítulos

**D1. Dentro del vídeo.** Un `.mkv` con subtítulos SRT/ASS y otro con PGS.
Esperado: la salida conserva todos (SRT en `.mp4`; ASS o de imagen → sale
`.mkv`). Comprobar en VLC o IINA: aparecen las pistas con su idioma.

**D2. En archivo aparte.** `Peli.mp4` + `Peli.es.srt` en la misma carpeta, soltar
la carpeta. Esperado: en `output/` salen `Peli.mp4` y `Peli.es.srt`. Repetir con
un nombre con tilde (`Canción.mp4` + `Canción.srt`).

### E. Comprimidos

Implementado: ZIP con extractor propio (`zip-extractor.js`); RAR, 7z, tar,
tar.gz/bz2/xz con **`/usr/bin/tar`** del sistema (`system-archive.js`); 7-Zip
como respaldo si está instalado (Homebrew: `/opt/homebrew/bin`, `/usr/local/bin`).

**E1.** Un `.zip`, un `.7z`, un `.rar`, un `.tar.gz`: cada uno con fotos y un
vídeo. Esperado: se abren solos y salen las fotos y los vídeos.

**E2. RAR5 en macOS antiguo (RIESGO CONOCIDO).** Un `.rar` creado con WinRAR
reciente. En macOS anteriores a 12 el `tar` puede no abrirlo. Esperado: o se abre,
o el aviso dice "usa el formato RAR5, que este equipo no sabe abrir… instala
7-Zip". Con `brew install sevenzip` (o `p7zip`) debe abrirse. **Anotar qué versión
de macOS y qué pasó.**

**E3. Con contraseña / dañado.** Un `.7z` o `.rar` con contraseña y un archivo
corrupto: aviso claro, sin bloquear el resto.

**E4. Ficheros de macOS dentro.** Un ZIP creado con el Finder ("Comprimir") trae
`__MACOSX/` y `._archivo`: se ignoran sin avisos.

### F. Funciones nuevas (1.0.9, 1.0.10 y 1.0.11)

**F1. Progreso global.** Con 5 o más fotos, aparece la barra con "N de M" y
tiempo restante.

**F2. Vista previa antes/después.** Botón del ojo en una foto terminada; el modal
muestra las dos versiones y el deslizador las compara. **Mirar con atención si se
ve bien** (en Windows hubo un defecto visual con miniaturas en la lista que nunca
se reprodujo; ver `DOCUMENTACION-PROYECTO.md` 7.11 y 7.16).

**F3. Carpeta de salida.** Ajustes → "Cambiar…": el diálogo nativo debe permitir
**crear una carpeta nueva**. Probar con una carpeta normal y con un disco
externo (`/Volumes/...`); desenchufar el disco y soltar una foto: debe avisar y
guardar en la carpeta de siempre.

**F4. Duplicados.** Soltar la misma foto dos veces: la segunda se omite con un
aviso que se queda en pantalla y un botón «Procesar de todos modos» (1.0.11). 1.0.10: borrar la salida de esa foto y soltarla otra vez: debe procesarse.
Dos fotos parecidas pero distintas (boca abierta/cerrada) entran las dos.

**F6. Ventana pequeña (1.0.10).** Reducir la ventana a lo mínimo (760 × 520): la
cola debe verse sin bajar, nada se sale, Ajustes se puede recorrer hasta el final.
Revisar que los botones del semáforo de macOS no tapan el logotipo (ver A2).

**F5. Reordenar la cola.** Pausar ("Detener"), meter varias fotos y arrastrar el
asa de una fila sobre otra. Con teclado: foco en el asa y **⌥ (Option) + flecha**
arriba/abajo. Comprobar que no choca con VoiceOver si está activado.

### I. Audio (1.0.11)

Es nuevo y NO se ha probado en un Mac real. El ffmpeg de Mac es otro binario que el de
Windows y Linux (con los que sí se probó): si no trae el codificador MP3 (`libmp3lame`),
Opus o Vorbis, la app usa AAC (M4A) en su lugar, pero eso solo se comprobó con pruebas
automáticas, no en un Mac.

**I1.** Soltar un `.wav`, un `.aiff`, un `.caf` y un `.m4a` (una nota de voz de la app
«Notas de voz» sirve): deben comprimirse y salir como `.mp3` (o `.m4a` el AAC).
Reproducirlos en Música / QuickTime: deben sonar bien y con la misma duración.
**I2.** Un `.m4a` de iTunes con portada: la portada debe seguir viéndose en Finder.
**I3.** Un `.m4b` (audiolibro) con capítulos: deben seguir los capítulos.
**I4.** Un audio ya ligero (MP3 de 128 kbps): debe decir «Sin cambios».
**I5.** Soltar el mismo audio dos veces: la segunda se omite con el aviso y el botón
«Procesar de todos modos».
**I7 (1.0.12).** Una predicación o nota de voz de la app «Notas de voz» (suele ser estéreo con el mismo sonido):
debe salir en **mono** y la cola decir «mono». Reproducirla: debe sonar igual. Probar también en Ajustes «Tipo de audio → Solo voz».
**I8 (1.0.12).** Un `.m4a`/`.mp3` de iTunes con portada grande: debe bajar de peso (cola: «portada reducida») y la portada seguir
viéndose en Finder; el audio no debe cambiar. **I9 (1.0.12).** Ajustes → «Formato de audio → FLAC» con un `.wav` o `.aiff`: sale `.flac`
y se reproduce en Música/QuickTime (Música no lee FLAC en versiones antiguas de macOS: si falla, usar VLC y anotarlo).
**I6.** Si algo falla, anotar el mensaje exacto y la salida de `ffmpeg -encoders` del ffmpeg
incluido (en `Compacta.app/Contents/Resources/...`).

### G. Comportamiento propio de macOS

**G1. Notificación al terminar un lote.** macOS pide permiso de notificaciones la
primera vez; debe salir la notificación y el icono del Dock debe **rebotar**
(`app.dock.bounce`, `src/main/notifier.js`).

**G2. Carpeta Documentos con otro nombre.** En un Mac con el sistema en otro
idioma, "Documents" puede llamarse "Documentos": la salida debe ir a la carpeta
de documentos real del usuario (`app.getPath('documents')`).

**G3. Rutas con espacios y acentos** en el Finder (`/Users/María/Mis Fotos/…`).

### H. Rendimiento

**H1.** Un lote de ~100 fotos grandes: la app no se congela y usa varios núcleos.
Anotar el modelo de Mac, el tiempo total y si el Mac se calentó o se puso lento.

---

## 5. Dónde está cada cosa específica de Mac en el código

| Tema | Archivo y lugar |
|---|---|
| Un ffmpeg por arquitectura (se fusionan en uno «fat») y sus licencias aparte | `package.json` → `build.mac.extraResources` (`vendor/ffmpeg/darwin-${arch}`) y `scripts/prepare-ffmpeg.js` |
| Localizar el ffmpeg en la app | `src/main/processor/ffmpeg.js` → `resolveFfmpegPath()` |
| Apple Silicon + macOS 11: Rosetta, o aviso | `ffmpeg.js` → `needsRosetta()`, `ffmpegLaunch()`, `videoEngineProblem()` (Darwin 21 = macOS 12) |
| `tar` de macOS | `src/main/system-archive.js` → `findTarBinary()` (`/usr/bin/tar`) |
| 7-Zip de respaldo (Homebrew) | `system-archive.js` → `findSevenZip()` |
| Nombres Unicode (NFC/NFD) | `src/main/processor/formats.js` → `foldName()` |
| Barra de título, botones y pantalla completa | `src/main/index.js` (`titleBarStyle`, `trafficLightPosition`, `enter/leave-full-screen`), `preload.js` y `styles.css` (`html[data-platform='mac'] .topbar`) |
| Menú de la app | `src/main/app-menu.js` (y `menu.*` en `src/shared/locales/`) |
| Dos `.dmg` universales (moderno y antiguo), firma ad-hoc | `package.json` → `build.mac` (`identity "-"`), `dist:mac` y `dist:mac-legacy` |
| Prueba del `.dmg` en Macs reales | `.github/workflows/build.yml` y `scripts/verify-packaged-engine.js` |
| Revisión de un `.app` (arquitecturas y macOS mínimo de cada pieza) y fusión Intel + Apple Silicon desde Linux | `scripts/mac-app-tools.js` (`check` / `merge`) y `src/main/macho.js` |
| Rebote del Dock | `src/main/notifier.js` |
| Reabrir desde el Dock / no salir al cerrar | `src/main/index.js` (`activate`, `window-all-closed`) |
| Texto "⌘V" en vez de "Ctrl+V" | `src/renderer/js/app.js` (`window.api.platform`) |
| Detección de iCloud Drive | `src/main/paths.js` |
| Librerías de imagen de las dos arquitecturas | `package.json` → scripts `predist:mac` (`sharp` 0.35) y `predist:mac-legacy` (`sharp` 0.33.5) |
| Clonado de archivos en APFS | `src/main/importer.js` (`COPYFILE_FICLONE`) |

---

## 6. Sospechas conocidas (lo que aún podría fallar en un Mac real)

1. **Los botones de la ventana** (A2): corregido y probado simulando; falta ver el aspecto real (la posición `y: 25` se calculó para una barra de 64 px).
2. **ffmpeg incrustado y Gatekeeper/cuarentena** (C1): la app lleva firma ad-hoc, incluido el ffmpeg; si aun así macOS lo bloquea, mirar `xattr` (ver C1).
3. **RAR5 en macOS antiguo** (E2).
4. **Permisos de macOS** (Documentos, Escritorio, volúmenes externos): un permiso denegado produce errores de escritura (B4, F3).
5. **Apple Silicon + macOS 11 por Rosetta** (C2): lógica probada, sin ejecutar en ese sistema.
6. **macOS 10.13–12 (variante antigua)**: Electron 26 y las librerías declaran 10.13, pero GitHub no ofrece ese sistema; nadie lo ha ejecutado aún.
7. **Teclas**: `Espacio` ignora ⌘/⌥, pero no se ha probado ⌥+flecha con VoiceOver (F5).
8. **Electron 26 (solo la variante antigua) en macOS muy reciente** (macOS 26 «Tahoe»): sin los parches de Electron de 2025; Apple lo mitigó en el propio sistema (26.2). Si se nota
   lentitud de la ventana con el sistema reciente, es el primer sospechoso (ver 7.23).

---

## 7. Plantilla para devolver los resultados

```
Mac: [modelo] — [Intel / Apple Silicon] — macOS [versión]
Compacta: [versión]
Cómo se instaló: [dmg / compilado / otro]

A1 arranque:            OK / FALLA — [qué se ve]
A2 botones de ventana:  OK / SE SOLAPAN con el logo [captura]
A3 icono:               OK / FALLA
A4 menú y atajos:       OK / FALLA — [qué]
B1 fotos y carpetas:    OK / FALLA — [qué]
B2 arrastrar:           OK / FALLA
B3 pegar (⌘V):          OK / FALLA
B4 permiso Documentos:  [pidió permiso: sí/no] — [qué pasó]
B5 aviso iCloud:        OK / FALLA / no aplica
B6 nombres con tilde:   OK / FALLA
C1 vídeo:               OK / FALLA — [mensaje exacto]
C2 Apple Silicon + 11:  OK (mensaje claro) / FALLA / no aplica
C3 HDR iPhone:          OK / FALLA / no probado
C4 cierre y procesos:   OK / FALLA
D1 subtítulos dentro:   OK / FALLA
D2 subtítulos aparte:   OK / FALLA
E1 comprimidos:         OK / FALLA — [qué formato]
E2 RAR5:                OK / aviso claro / FALLA — [versión de macOS]
E3 contraseña/dañado:   OK / FALLA
E4 ZIP del Finder:      OK / FALLA
F1..F5 funciones 1.0.9: OK / FALLA — [cuál]
G1 notificación+Dock:   OK / FALLA
G2 carpeta Documentos:  OK / FALLA
H1 rendimiento:         [tiempo, núcleos, temperatura]

Notas y capturas:
```

Cuando se arreglen cosas de esta lista, **actualizar este archivo y la sección
13.1 de `DOCUMENTACION-PROYECTO.md`** con lo que se verificó de verdad.
