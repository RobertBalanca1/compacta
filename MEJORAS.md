# Mejoras propuestas para Compacta

Lista viva. Cuando una mejora se implementa, se marca `[x]` y se anota la
versión/fecha entre paréntesis. No se borran las ya hechas — sirven de
registro de qué se fue agregando y cuándo.

## Hechas

- [x] Botón Detener / Reanudar la cola (ya estaba en la versión original)
- [x] Botón "Eliminar pendientes" junto a Reanudar, para descartar lo que
      quedó en espera en vez de continuarlo (v1.0.1)
- [x] Corrección: la app ya no reprocesa fotos ya terminadas en cada
      apertura por diferencias de mayúsculas/minúsculas o por conversión a
      WebP (v1.0.1)
- [x] Perfiles de compresión: crear, renombrar, eliminar y cambiar entre
      combinaciones guardadas de calidad/modo agresivo/WebP (v1.0.2)
- [x] Registro interno de "ya procesado" independiente de mirar `output/`
      (vive en la carpeta de datos de usuario, no en Documentos) — refuerza
      la corrección anterior para el caso de que OneDrive/iCloud no haya
      sincronizado `output/` a tiempo al reabrir la app (v1.0.3)
- [x] Aviso en la app si `Documentos` parece estar sincronizada con
      OneDrive/iCloud (v1.0.3)
- [x] Aviso cuando se arrastran fotos `.heic`/`.heif` (no se procesan, pero
      ahora se avisa en vez de ignorarlas en silencio) (v1.0.3)
- [x] Notificación del sistema al terminar un lote de 5 o más fotos, si la
      ventana no está en foco (v1.0.3)
- [x] Atajo de teclado: barra espaciadora para Detener/Reanudar (v1.0.3)
- [x] Revisión exhaustiva de bugs y código muerto — 22 hallazgos corregidos,
      incluyendo que los perfiles y "Eliminar pendientes" NO funcionaban de
      verdad (`window.prompt`/`confirm` no son fiables en Electron), que las
      notificaciones de lote nunca aparecían, que las miniaturas de la cola
      nunca cargaban, y que cerrar la ventana en Mac rompía la app hasta
      reiniciarla. Ver `DOCUMENTACION-PROYECTO.md` sección 7.9 (v1.0.4)
- [x] Corrección de dos bugs reportados en uso real con la 1.0.4 (lote de
      muchas copias de una misma foto grande), más una revisión de
      rendimiento en lotes grandes. Ver `DOCUMENTACION-PROYECTO.md` sección
      7.10 (v1.0.5):
      - Con el foco todavía en "Elegir carpeta"/"Elegir archivos"/"Abrir
        carpeta de salida" (Chromium deja el foco ahí tras un clic), pulsar
        espacio para Detener/Reanudar en realidad volvía a activar ESE
        botón (reabría el selector) en vez de detener nada.
      - Las miniaturas de la cola cargaban el archivo ORIGINAL completo
        (varios MB, varios miles de px) solo para dibujar un círculo de
        38px; con lotes grandes eso causaba lag severo y, probablemente, el
        recuadro con flecos de color que se veía superpuesto a la lista.
        Ahora se genera y cachea una miniatura real y pequeña.
      - `settings.json` y el manifiesto de "ya procesado" se releían y
        reescribían enteros, de forma síncrona, en cada foto del lote; ahora
        se mantienen en memoria durante la sesión.
- [x] Corrección de lo reportado tras instalar la 1.0.5, y una mejora
      pedida. Ver `DOCUMENTACION-PROYECTO.md` sección 7.11 (v1.0.6):
      - La miniatura de la foto en la cola se QUITÓ del todo (decisión, no
        solo arreglo): la versión de 1.0.5 generaba de verdad una miniatura
        pequeña y quedó verificado que sí lo hacía, pero en la práctica se
        seguía viendo mal de un modo no reproducible fuera de esa máquina
        (probablemente un problema de composición de la GPU). Se
        reemplazó por un icono genérico igual para todas las fotos: cero
        decodificación de imágenes ajena a la barra de progreso, cero
        superficie para este tipo de problema.
      - El aviso de OneDrive/iCloud: la "X" para cerrarlo sí funcionaba y
        sí quedaba recordada, pero el área donde se podía hacer clic era
        casi el ancho justo del propio carácter "×" — muy fácil de fallar
        por un par de píxeles. Se agrandó el área de clic.
      - Las notificaciones del sistema mostraban "electron.app.Compacta"
        con un icono genérico en vez de "Compacta" con el icono de la app,
        porque nunca se le decía a Windows la identidad de la app en
        tiempo de ejecución. Corregido.
      - Añadido (a petición): un sonido corto al terminar un lote, a la
        vez que aparece el aviso verde dentro de la app (mismo criterio de
        "no molestar" en lotes pequeños que ya tenía el aviso).
- [x] **La 1.0.6 no arrancaba: "Cannot read properties of undefined
      (reading 'appId')".** Van DOS veces que algo pasa todas las pruebas y
      aun así no funciona en la app instalada de verdad — ver
      `DOCUMENTACION-PROYECTO.md` sección 7.12 para el motivo (de fondo,
      el mismo motivo las dos veces: se prueba el código fuente, no el
      programa ya empaquetado) y la solución de raíz que se le dio esta
      vez: una prueba que arranca el `.asar` real, no el código fuente.
- [x] Corrección del aviso de OneDrive/iCloud que "no se cerraba", varias
      carpetas, ZIP y una pasada de rendimiento. Ver
      `DOCUMENTACION-PROYECTO.md` sección 7.13 (v1.0.7):
      - **El aviso de OneDrive/iCloud no se cerraba de verdad.** La "X" sí
        ejecutaba su código, pero una regla de CSS (`.cloud-banner
        { display: flex }`) ganaba a `.hidden { display: none }` por ir
        después en la hoja de estilos, así que el aviso se quedaba a la
        vista. La 1.0.6 había "arreglado" el tamaño del área de clic, que no
        era el problema. Ahora `.hidden` no se puede anular, y la prueba
        comprueba lo que se VE (display/altura), no solo la clase.
      - **Varias carpetas** a la vez (selector con selección múltiple y
        arrastrando varias).
      - **ZIP**: soltarlos o elegirlos con el botón nuevo; también los ZIP
        que haya dentro de una carpeta y los ZIP anidados. Streaming, sin
        cargar el ZIP en memoria; protegido contra rutas `../` (zip-slip) y
        contra bombas de descompresión; un ZIP roto o con contraseña se
        avisa sin parar el resto.
      - **Soltar archivos fuera del recuadro** ya no hace que la ventana
        navegue al archivo (toda la ventana acepta soltar).
      - **Rendimiento** (lote de 180 fotos de 6 MP: 195 s → 22 s): JPG con
        libjpeg-turbo por defecto (mozjpeg pasa a ser el ajuste opcional
        "Compresión máxima"), AVIF con effort 3 (10× más rápido, mismo
        tamaño), la cola ya no es O(n²), importación en paralelo y
        encolando carpeta a carpeta mientras se sigue copiando, límite de
        procesos en paralelo según núcleos Y memoria (antes tope fijo de 4).
- [x] Videos y todos los comprimidos, y reorganización del código. Ver
      `DOCUMENTACION-PROYECTO.md` sección 7.14 (v1.0.8):
      - **Videos** (25 formatos): se comprimen con la misma barra de calidad,
        modo agresivo y compresión máxima que las fotos; calidad constante,
        sin reescalar, audio AAC/MP3 copiado, HDR conservado, y si no
        ahorra al menos un 5 % se deja el original intacto.
      - **Comprimidos**: zip, rar, 7z, tar, tar.gz, tar.bz2, tar.xz y
        anidados de formatos mezclados, con avisos claros (contraseña,
        dañado). RAR/7z usan el `tar` que ya trae Windows/macOS.
      - El instalador 1.0.7 NO tenía videos; llegan en 1.0.8.
      - Código: `file-manager.js` dividido por responsabilidad, duplicación
        eliminada, exports sin uso quitados.
- [x] Mac (Intel y Apple Silicon), subtítulos y respaldo para RAR en sistemas
      antiguos. Ver `DOCUMENTACION-PROYECTO.md` sección 7.15 (v1.0.8):
      - **ffmpeg por plataforma Y arquitectura**: cada `.app` de Mac lleva el
        suyo (x64 o arm64), verificado por dentro; `ffmpeg-static` pasó a
        dependencia de desarrollo y el binario sale del `.asar`.
      - **Compatibilidad medida (SUPERADA en 1.2.0: ahora desde macOS 10.13, ver más abajo)**: Mac Intel desde macOS 10.15; Apple Silicon
        desde 11 para fotos y **desde 12 para video** (aviso claro antes de
        fallar). Nada de esto se pudo ejecutar en un Mac real.
      - **Subtítulos conservados**: texto simple dentro del MP4; ASS o de
        imagen (PGS, DVD) -> el video sale como MKV copiándolos con idioma y
        marcas intactos.
      - **RAR5 en sistemas antiguos**: respaldo con 7-Zip si está instalado, y
        aviso con la causa real si no.
      - **Nombres con tilde** (NFC/NFD, típico de macOS) ya no hacen repetir
        lo procesado.
      - Bug de empaquetado: `files` por plataforma sustituía al global
        (instalador de 162 MB con todo el proyecto dentro); ya son 108 MB.
      - Nueva sección 13 de la documentación: guía para continuar en otro chat
        (entorno, comandos, trampas del proceso, preferencias de la persona).
- [x] Progreso global, vista previa, carpeta de salida, duplicados, subtítulos
      en archivo aparte y reordenar la cola. Ver `DOCUMENTACION-PROYECTO.md`
      sección 7.16 (v1.0.9):
      - **Barra de progreso global** con "N de M" y tiempo restante, estimado
        por separado para fotos y vídeos (gana el carril más lento).
      - **Vista previa antes/después** (botón del ojo en fotos terminadas),
        reducida con `sharp`; sin `<img>` en la lista (lección de 7.11).
      - **Carpeta de salida elegible**, validada, con vuelta automática a la de
        siempre (y aviso) si el disco no está.
      - **Omitir duplicados** (idénticos byte a byte), desactivable.
      - **Subtítulos en archivo aparte** viajan con el vídeo y se copian a la
        salida (también desde ZIP y tar).
      - **Reordenar la cola** arrastrando el asa o con Alt+flecha.
      - **HEIC investigado y NO implementado** (el ffmpeg 6.1.1 de Windows no
        lee HEIF); ver el motivo y el camino posible en 7.16.
- [x] Correcciones de lo reportado en la 1.0.9 (vista previa, ventana, duplicados,
      barra y tiempo) y dos mejoras de la lista. Ver `DOCUMENTACION-PROYECTO.md`
      sección 7.17 (v1.0.10):
      - **Vista previa que "no hacía nada"**: ahora la línea se ve y se arrastra, el
        escenario tiene la proporción de la foto, y hay **detalle al 100 %** (zona sin
        reducir, PNG, con mapa pequeño). Es lo que permite ver diferencias reales.
      - **Ventana sin maximizar**: zona de arrastrar compacta con cola, cola con su
        propio scroll, encabezados que se parten, Ajustes y diálogos con alto máximo,
        mínimo de ventana 760 × 520.
      - **"Omitir duplicados" omitía todo**: comparaba contra todo lo que alguna vez
        entró en `input/`. Ahora solo cuenta lo idéntico a algo de la misma
        importación o cuyo resultado sigue existiendo. Fotos parecidas pero distintas
        nunca se omiten (comprobado con pruebas).
      - **Barra que retrocedía**: lote abierto durante la importación, "Limpiar
        completados" ya no resta, fracción monótona. **Tiempo restante** con ritmo
        reciente en ventana y suavizado (error < 20 % en simulación).
      - Vista previa de **vídeos** (un fotograma del original y del resultado).
      - Reordenar la cola agarrando la **fila entera**.

- [x] **Audio** y arreglo de «Omitir duplicados» (v1.0.11). Ver `DOCUMENTACION-PROYECTO.md`
      sección 7.18:
      - **Audio en cualquier formato** (más de 40 extensiones, incluidos los de Mac:
        m4a/m4b/m4r, aiff/aif/aifc, caf): sin pérdida -> MP3 transparente; con pérdida
        solo si pesa claramente más de lo necesario; etiquetas, portada y capítulos
        conservados; carril propio en la cola; notas de voz en `.mp4/.3gp/.webm/.mkv`
        sin imagen tratadas como audio.
      - **Duplicados**: un fallo al comparar ya no tumba la importación; la comprobación
        dejó de ser cuadrática (volver a soltar miles de archivos congelaba la app);
        el portapapeles ya avisa; el aviso ahora **se queda** y trae el botón
        **«Procesar de todos modos»** (mejora de la lista, hecha).

- [x] **Audio más pequeño sin perder calidad y más formatos de vídeo** (v1.0.12). Ver
      `DOCUMENTACION-PROYECTO.md` sección 7.19:
      - **Audio**: estéreo que en realidad es mono -> mono (medido, estricto en música); recodificar con
        pérdida solo si una prueba real ahorra ≥ 20 %; **modo «Solo voz»** (2-3 veces menos, PESQ 4,58-4,63 de 4,64);
        **formato Compatible / Opus / FLAC** (FLAC bit a bit); **portadas** a 600 px, y si el audio ya era
        óptimo se copia sin recodificar; toda salida se verifica antes de reemplazar (red de seguridad).
      - **Vídeo**: 20 extensiones nuevas (todas con clip real y probadas con el `ffmpeg.exe` del instalador);
        vídeos con dos pistas de vídeo se dejan intactos en vez de perder una; VP9/AV1 -> HEVC.
      - Hecho de la lista: opción «audio sin pérdida (FLAC)» en Ajustes.

- [x] **Más rápido y más limpio** (v1.0.13). Ver `DOCUMENTACION-PROYECTO.md`, sección 7.20:
      - **Rendimiento**: corregida una regresión propia de 1.0.12 (el análisis de audio lanzaba 6 procesos de
        ffmpeg por archivo: un MP3 que no se toca pasó de ~100 ms a ~1,15 s; ahora ~0,4 s); **vídeo: prueba de
        peso de 2 trozos de 8 s** que salta (sin codificar entero) lo que pesaría un 10 % más (estimación a
        ±0,03 de lo real, ~1 s frente a ~11 s por vídeo de 200 s).
      - **Auditoría de código** (`npm run audit`, nueva): cero funciones, variables, imports o dependencias sin uso;
        quitados 8 exports que nadie importaba; **no hay monolitos** (todo `src/` son ~8.200 líneas, el mayor
        archivo JS tiene 523). `setupIpcHandlers` (164 líneas) repartida en 6 funciones por tema, con los mismos
        26 canales; `settingsPanel` con los ajustes sencillos en una tabla (añadir uno = una fila).

- [x] **1.1.0, ajustes tras probarlo** (ver 7.22): (1) **volver a soltar una carpeta con el mismo nombre ya NO crea «Nombre (2)»,
      «(3)»…**: se une a la de antes y solo lo que se llama igual pero es distinto recibe «(2)» en el nombre del ARCHIVO; (2) **ZIP con
      contraseña**: se pide en un cuadro (ZipCrypto y AES de WinZip, comprobado con `zip` y `pyzipper`); (3) opción **«HEIC: pasar siempre
      a JPG»**; (4) funciones largas repartidas (`app.js main`, `settingsPanel.init`, `dialog.show`, `createDuplicateDetector`).
- [x] **Versión 1.1.0: la app empieza antes, habla 6 idiomas y lee fotos HEIC.** Ver `DOCUMENTACION-PROYECTO.md`, 7.21:
      - **Menos espera antes de empezar a comprimir.** Medido (20.000 archivos de historial en `input/`, 400 fotos):
        el primer archivo empieza a los **99 ms en vez de 577 ms**; el total no cambia (comprimir sigue siendo lo
        que tarda). Causas arregladas: se recorría y se hacía `stat` de TODO `input/` en cada importación (ahora un
        índice compartido que se arma una vez al abrir la app), nada se encolaba hasta copiar la carpeta ENTERA (ahora
        por tandas, la primera de 8), la ventana esperaba a validar la carpeta de salida (ahora se abre primero),
        `sharp` se cargaba antes de dibujar la ventana (ahora después), y la prueba de escritura de la carpeta de
        salida se repetía en cada importación (ahora una vez cada 30 s).
      - **Audio: un solo ffmpeg** para el análisis de canales y otro para la prueba de peso (antes uno por trozo: 2 o 3
        cada vez). Mide lo mismo (energías idénticas; la estimación de peso difiere ~2 %).
      - **6 idiomas**: español, inglés, alemán, italiano, vietnamita y árabe (derecha a izquierda). Se elige en Ajustes
        (cambio inmediato, sin reiniciar) o, por defecto, el del sistema. 216 textos × 6 idiomas; los avisos del proceso
        principal salen en el mismo idioma. El instalador de Windows elige solo por el idioma de Windows; vietnamita y árabe tuvieron que
        traducirse a mano (`build/installer.nsh`): `electron-builder` no los trae en la pantalla de «¿para quién?».
      - **Fotos HEIC/HEIF (iPhone)**: se importan y se decodifican en un hilo aparte con `libheif-js` (WebAssembly),
        sin ffmpeg ni nada del sistema. Colores Display P3 convertidos a sRGB. Salen como JPG/WebP **solo si pesan
        menos**; si no, se dejan tal cual (nunca peor que el original).
      - Alta densidad de píxeles: la interfaz completa (40 pruebas) pasa a escala 1,5 y 2 (simulada con Electron).
      - `styles.css` revisado (sin clases sin uso; 2 selectores duplicados fundidos; propiedades lógicas para RTL).

- [x] **Mac, terminado (v1.2.0): UN solo instalador para Intel y Apple Silicon, desde macOS 10.13, y la misma interfaz que Windows.**
      Ver `DOCUMENTACION-PROYECTO.md`, 7.23:
      - **Un solo `.dmg` universal** (`Compacta-1.2.0-Mac.dmg`): Intel + Apple Silicon juntos; ya no hay `.zip` ni uno por arquitectura.
      - **Llega a macOS 10.13 / 10.14** (lo pedido): el build de Mac usa **Electron 26** (el ultimo que arranca ahi; desde la 27 hace falta
        macOS 10.15). Mismo codigo y misma interfaz: las 454 pruebas unitarias (443 pasan, 11 se omiten por no haber `rar`) con Node 22 y con el Node 18 de Electron 26, y las
        47 de interfaz con Electron 44 (Windows) y con Electron 26 (Mac). Minimo medido en los binarios: 10.13 en Intel, 11 en Apple Silicon.
      - **Corregido: los botones de la ventana tapaban el logotipo** (hueco a la izquierda, tambien en arabe, y se quita en pantalla completa).
      - **Menu de Mac propio**, en los 6 idiomas, con «Edicion» (sin el, ⌘C/⌘V no funcionan) y sin «Herramientas de desarrollo».
      - **Apple Silicon con macOS 11: los videos y audios ahora SI funcionan** (con Rosetta, usando la parte Intel del mismo ffmpeg); si no
        esta Rosetta, el aviso dice como instalarla. Antes no se podia.
      - **Firma ad-hoc** (gratis): sin ella, Apple Silicon dice que la app esta «dañada». Ahora sale el aviso normal de «no verificada».
      - **Arrastrar y soltar** funciona con el Electron 26 del Mac (`webUtils` no existe alli; se usa `file.path`).
      - **GitHub Actions** construye el `.dmg` y lo PRUEBA en un Mac Intel y uno Apple Silicon reales (firma, arquitecturas, ventana, y
        comprime de verdad una foto, un HEIC, un video y un audio con lo que lleva dentro) y pasa `npm test` ahi. Antes solo compilaba.
      - Bug evitado de antemano: la fusion Intel + Apple Silicon fallaba porque las licencias de los dos ffmpeg son archivos distintos.

## Cola de optimización del código (pedida en 1.0.13)

Lo que se hizo y lo que queda. Repetir `npm run audit` antes de cada versión.

- [x] Auditoría de código muerto (exports, funciones, variables, imports, dependencias, CSS, archivos huérfanos):
      prácticamente limpio; 8 exports sobrantes quitados. Los «huérfanos» que salen son puntos de entrada
      (`main/index.js`, `processor/index.js`, `preload.js`) y las clases `queue-item--*` se arman dinámicamente.
- [x] Herramienta permanente `npm run audit` (`scripts/audit-code.js`).
- [x] Reparto de `setupIpcHandlers` (164 líneas) y tabla de ajustes en `settingsPanel`.
- [ ] **Funciones largas que quedan** (aviso de `npm run audit`, 1.1.0): `zip-extractor.extractZip` (106) y
      `duplicates.createDuplicateDetector` (91, a un paso del umbral). Repartidas en 1.1.0: `importPaths`, `app.js main`,
      `settingsPanel.init`, `dialog.show`.
      Dividir SOLO con sus pruebas verdes; `extractZip` con mucho cuidado (lleva las protecciones contra ZIP bomb,
      rutas con `..` y enlaces). No dividir por dividir: varias son listas planas de cableado.
- [ ] **Medir el arranque y la memoria en un Windows real** (con antivirus). En mi entorno de pruebas (1 núcleo,
      pantalla virtual) el arranque no es representativo (~20 s), así que no se afirma nada.
- [x] Revisar `styles.css` (1.1.0): sin clases sin uso, 2 selectores duplicados fundidos. Los colores ya eran
      variables. Además se pasó a propiedades lógicas (inicio/fin) para el árabe.
- [ ] Perfilar un lote grande real (miles de archivos) en Windows: memoria y CPU. Hecho en 1.1.0 en el entorno de
      pruebas (400 fotos de 1600×1200: ~62 ms/foto con 1 núcleo, 219 MB de RSS; HEIC de 12 MP: ~2,7 s/foto en un
      solo hilo). Falta Windows real, miles de archivos, y audio/vídeo con lotes grandes.
- [x] El análisis de audio lanzaba 2-3 ffmpeg por archivo estéreo: ahora un solo ffmpeg lee todos los trozos (1.1.0).
      Sigue pendiente medir el efecto en un Windows real (donde cada arranque de ffmpeg cuesta más).

## Pendientes

### Mac (v1.2.0: terminado en código; falta probarlo en Macs REALES)

Ya no está aplazado: se implementó y se verificó todo lo que se puede verificar sin un Mac (ver 7.23). Lo que queda no es código:

- [x] **Flujo de GitHub ejecutado (v1.2.0): en verde.** Construye el `.dmg` (en un Mac Intel, para que sea HFS+) y lo prueba en un Mac Intel y uno Apple Silicon REALES. Salieron 4 fallos
      que en Linux no se veían (publicación automática, enlaces duros, APFS, muestras que el ffmpeg de Apple Silicon no sabe fabricar); todos corregidos: 7.23.
- [ ] **Probar el `.dmg` a mano en un Mac real** siguiendo `PRUEBAS-EN-MAC.md` (sobre todo: aspecto de la ventana con los botones, menú,
      arrastrar desde el Finder, notificaciones, y las versiones viejas de macOS: 10.13/10.14/10.15, que GitHub no ofrece).
- [ ] **Apple Silicon con macOS 11, vídeo y audio por Rosetta**: implementado y probado la lógica (cabeceras Mach-O reales, argumentos), pero
      NO ejecutado en un Mac con macOS 11.
- [ ] macOS **10.12 o anterior**: no se soporta (Electron 26, `sharp`/libvips y ffmpeg piden 10.13 como mínimo), y NO hace falta: Apple publica la
      misma lista de Macs compatibles para Sierra (10.12) y High Sierra (10.13), así que todo Mac con 10.12 se actualiza gratis a 10.13.6. Soportar 10.12 de
      verdad exigiría un Electron ≤ 21, otro `sharp`/libvips y otro ffmpeg, todo sin parches de seguridad: no se recomienda. Si en la iglesia hay un Mac
      con 10.12 que no se deja actualizar, mirar 7.23 (el «unexpected error» del instalador tiene arreglo).
- [ ] Firma de Apple (Developer ID, 99 USD/año) y **notarización**: quitaría el aviso de «no verificada». Cómo activarla: 7.23, sección «Si algún
      día hay certificado». Mientras tanto: ver `LEEME.txt` (en macOS 15 o posterior, Ajustes del Sistema → Privacidad y seguridad → «Abrir igualmente»).
- [ ] Electron 26 lleva Chromium 116 (2023), sin parches. Es el precio de llegar a macOS 10.13/10.14. La app no carga contenido de internet
      (todo es local, con CSP `default-src 'self'`), lo que reduce mucho el riesgo; aun así, si algún día se renuncia a macOS < 10.15, subir el Mac a un
      Electron actual (cambiar la versión en el script `dist:mac`).

### Localización (idiomas)

- [x] **Hecho en 1.1.0** (ver 7.21): vietnamita, árabe, italiano, inglés, alemán y español, en la app y en el
      instalador. Decisiones tomadas (cámbialas si no te gustan): el idioma inicial es el del **sistema operativo**
      (si no es uno de los seis, inglés), sin pantalla de elección en el primer arranque; se cambia en
      **Ajustes > Idioma** al instante. El idioma de la app es independiente del instalador. El árabe invierte toda
      la interfaz (la comparación antes/después sigue siendo «izquierda = original»).
- [ ] **Revisión de las traducciones por personas nativas** (sobre todo vietnamita y árabe, también alemán e
      italiano): las escribí yo; son correctas y coherentes pero no las ha revisado un hablante nativo. Los textos
      están en `src/shared/locales/<código>.js` (uno por idioma, mismas claves).
- [ ] Probar el instalador en un Windows REAL configurado en cada idioma. Se ejecutó bajo wine con el idioma forzado (alemán, italiano,
      vietnamita, árabe: bien); el español es el de la captura de una persona con Windows en español.
- [ ] Los nombres de las carpetas de lote (`Lote_2026-…`) y la frase «Perfil» por defecto viven en el disco/ajustes
      y NO se traducen (son nombres de archivo). Decidir si se quiere.

### Uso diario

- [ ] Audio: probar con el ffmpeg de Mac en un Mac real (ver `PRUEBAS-EN-MAC.md`, sección I; GitHub ya comprime un WAV con él en cada ejecución).
- [ ] **Escucha humana** del audio nuevo (mono y modo voz): las pruebas miden con PESQ (solo voz) y con
      coherencia, no con oídos. Probar con predicaciones reales de la iglesia y comparar A/B.
- [ ] `.ts` de televisión (hoy excluido porque también es TypeScript; ver 7.19). Hay que detectarlo por el
      contenido (sincronía 0x47 cada 188 bytes) en el recorrido de carpetas, el importador y los ZIP.
- [ ] Vídeo: la prueba de peso (1.0.13) se verificó con contenido SINTÉTICO. Con vídeo real (móvil, pantalla,
      descargas) la estimación puede desviarse más; probar con tus vídeos y ajustar `TRIAL_SKIP_RATIO` si hace falta.

- [x] **`.heic`/`.heif`** (1.1.0, ver 7.21): decodificación con `libheif-js` (WebAssembly) en un hilo aparte, sin
      ffmpeg. Probado con HEIC reales (generados con `pillow-heif`) y dentro del `.asar` empaquetado de Linux.
      HEIC ya es muy eficiente y pasarlo a JPG suele pesar MÁS, así que por defecto muchas fotos de iPhone se **conservan
      tal cual** («sin cambios, ya es un HEIC eficiente»). Desde los ajustes de 1.1.0 existe la opción **«HEIC: pasar siempre a
      JPG»** (apagada, por perfil) para quien prefiera compatibilidad a ahorro: la fila muestra «+N %» y lo explica.
- [ ] HEIC: no probado con fotos reales de iPhone (teselas, perfil Display P3 de Apple, Live Photos, HDR de 10 bits);
      las de prueba son sintéticas. Un solo hilo decodifica de una en una (~2,7 s por foto de 12 MP, peor caso).
      Pendiente de revisar contigo: `libheif-js` es **LGPL-3.0** (se distribuye su LICENSE, es un archivo suelto y
      sustituible) y HEVC tiene patentes (decodificar en software para uso gratuito de una iglesia suele ser de bajo
      riesgo, pero no soy abogado).
- [x] **ZIP con contraseña** (1.1.0, ver 7.22): descifrador propio (ZipCrypto y AES-128/192/256 de WinZip) sin dependencias nuevas; la
      contraseña se pide en un cuadro, se reintenta solo ese comprimido y no se guarda. Pendiente: **RAR/7z con contraseña** (`tar` no
      la admite: haría falta 7-Zip instalado) y archivos en varios volúmenes; esos siguen avisando «protegido con contraseña».
- [ ] Vista previa de vídeos con **reproducción** o con varios fotogramas (hoy un solo fotograma, sin detalle al 100 %).
- [ ] Detectar fotos **muy parecidas** (ráfagas) solo para MOSTRARLAS y que la persona
      elija cuál conservar; **nunca** omitirlas solas. Requiere un hash perceptual y
      decidir la interfaz; el riesgo es justo el de boca abierta/cerrada.
- [ ] Probar el comparador en pantallas de alta densidad REALES (Retina, Windows con escala 150 %). En 1.1.0 la
      interfaz entera (40 pruebas) pasa con escala 1,5 y 2 simuladas con Electron (`--force-device-scale-factor`,
      comprobado con `window.devicePixelRatio = 2 y 1,5`), pero no en un monitor real.

### Distribución

- [ ] **Firma de código / ventana azul «Windows protegió su PC – editor desconocido» (SmartScreen).** Investigado el 17-oct-2026 (fuentes:
      Microsoft Learn «code signing options» y «SmartScreen reputation»; **comprobar de nuevo antes de decidir, cambia a menudo**).
      NO es un cambio de código: hace falta una identidad verificada, y aun así el aviso no desaparece al instante.
      - Desde 2024 ni siquiera un certificado EV quita el aviso de golpe: SmartScreen funciona por **reputación** (descargas de ese
        archivo y de ese editor, acumuladas con el tiempo). Un certificado «OV» normal rinde igual que el EV (150-300 USD/año, según la fuente).
      - **Azure Artifact Signing** (antes Trusted Signing, unos 10 USD/mes): para personas físicas solo en EE. UU. y Canadá; en la UE solo para
        **organizaciones** con nombre legal verificable. Para una persona en España no sirve; para una asociación/entidad legal quizá.
      - **Microsoft Store (MSIX):** las apps de la Tienda las firma Microsoft y no salen con ese aviso nunca. Requiere cuenta de desarrollador
        (cuota de alta pequeña; comprobar importe) y un paquete MSIX distinto del instalador actual (`electron-builder` lo soporta; **no probado
        aquí**). Es la vía más barata para quitar el aviso del todo, pero cambia cómo se distribuye.
      - **SignPath Foundation:** firma gratis para proyectos de código abierto (hay que cumplir sus requisitos).
      - Mientras tanto, lo que ya hay: «Más información → Ejecutar de todas formas» (explicado en `LEEME.txt`).
      - Mac: «no se puede verificar el desarrollador» necesita Apple Developer (99 USD/año). Hoy la app lleva firma ad-hoc (gratis, `scripts/mac-sign.js`) para que
        abra en Apple Silicon; con certificado de pago se puede notarizar (7.23).
      - `electron-builder` ya firma solo si encuentra un certificado (variables `CSC_LINK` y `CSC_KEY_PASSWORD`); hoy imprime «signing is skipped».
