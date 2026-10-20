# Manual de uso — Compacta

Compacta comprime tus fotos para que ocupen mucho menos espacio, sin que se note
la diferencia a simple vista. Todo pasa en tu computadora: no sube nada a
internet, no necesita cuenta, no necesita conexión.

## 1. Instalar

1. Abre `Compacta Setup 1.0.4.exe` con doble clic.
2. Si Windows muestra una pantalla azul de "Windows protegió su PC", haz clic
   en **Más información** y luego en **Ejecutar de todas formas**. Esto pasa
   porque el programa es nuevo y no está en la tienda de Windows — no significa
   que tenga algo malo.
3. Sigue el instalador (Siguiente → Siguiente → Instalar). No pide contraseña
   de administrador ni permisos especiales.
4. Al terminar, la app se abre sola. Queda un ícono en el Escritorio y en el
   Menú Inicio para abrirla cuando quieras.

## 2. Agregar fotos, vídeos y audios (cinco formas)

- **Arrastrar y soltar**: toma tus fotos, vídeos y audios, una o **varias carpetas**,
  o un archivo comprimido (**ZIP, RAR, 7z, TAR**…) con el mouse y suéltalos en
  la ventana (sirve soltarlos en cualquier parte, no solo sobre el círculo).
- **Botón "Elegir archivos"**: abre el explorador de Windows para elegir una
  o varias fotos o vídeos.
- **Botón "Elegir carpetas"**: elige una o **varias carpetas** de una vez
  (mantén Ctrl y haz clic en cada una); se respeta la organización en
  subcarpetas que ya tengan.
- **Botón "Elegir comprimido"**: elige uno o varios archivos ZIP, RAR, 7z,
  TAR, TAR.GZ, TAR.BZ2 o TAR.XZ. Compacta los abre sola, comprime las fotos y
  vídeos que lleven dentro (aunque estén en subcarpetas o haya otro
  comprimido dentro) e ignora todo lo demás. Un comprimido también funciona
  si lo sueltas, o si está dentro de una carpeta que sueltas. Si tiene
  contraseña, está dañado o es de varios volúmenes, te lo dice con claridad.
- **Pegar con Ctrl+V**: si copiaste una foto (Ctrl+C en el explorador) o
  tomaste una captura de pantalla, puedes pegarla directo en la ventana de
  Compacta con Ctrl+V, sin tener que guardarla primero.

En cuanto se agregan, empiezan a procesarse solas — no hay que apretar nada más.
Con carpetas o comprimidos grandes, la primera carpeta ya se está comprimiendo mientras
se copia o descomprime la siguiente.

Las fotos `.HEIC`/`.HEIF` (el formato por defecto de los iPhone) se aceptan.
Ojo con lo que verás: HEIC ya es un formato muy eficiente, y convertirlo a JPG
suele hacer la foto MÁS pesada. Por eso Compacta solo la convierte a JPG (o
WebP) cuando sale más ligera; si no, la deja tal cual y en la lista pone «sin
cambios: ya es un HEIC eficiente». Los colores de las fotos de iPhone se
conservan. Cada foto HEIC tarda unos 2-3 segundos en leerse (si es de 12
megapíxeles); es normal.

Si algún otro archivo no se pudo importar (formato no compatible), aparece un
aviso abajo diciendo cuántos y por qué.

**Carpetas con el mismo nombre:** si sueltas otra vez una carpeta que ya
habías importado (o una con el mismo nombre), Compacta la une a la de antes en
vez de crear «Nombre (2)», «Nombre (3)»… Lo que ya estaba igual se omite; lo que
se llama igual pero es distinto se guarda como «foto (2).jpg».

**Comprimidos ZIP con contraseña:** Compacta te pide la contraseña en un cuadro.
Si no es correcta, vuelve a preguntar; si cancelas, queda avisado. La contraseña
no se guarda. (RAR y 7z con contraseña todavía no se pueden abrir.)

### Audios

Se aceptan los formatos de audio de siempre y los de Mac: MP3, M4A, M4B, M4R,
AAC, WAV, FLAC, OGG, OPUS, WMA, AMR, AC3, MKA, **AIFF, AIF, AIFC, CAF**, APE,
WavPack y otros (más de 40 extensiones). También se tratan como audio las notas
de voz guardadas como `.mp4`, `.3gp`, `.webm` o `.mkv` que no llevan imagen.
Suéltalos solos, en carpetas o dentro de un comprimido, igual que las fotos.

- **WAV, AIFF, FLAC, CAF, ALAC…** (sin pérdida o sin comprimir) salen como **MP3**,
  que reproduce cualquier móvil, coche o equipo de sonido, con una calidad que
  no se distingue del original de oído. Un WAV suele quedar en menos del 10 % de
  su peso. Si el audio es 5.1 (más de 2 canales) sale como M4A conservando los canales.
- **MP3, M4A, OGG, OPUS…** (que ya tienen pérdida) **solo se recodifican si una prueba
  real demuestra que pesarán un 20 % menos o más**. Uno ya ligero (un MP3 de 128 kbps de
  música, una nota de voz de WhatsApp) **se deja idéntico**, porque recodificar solo lo
  degradaría. Se mantiene el formato: MP3 sigue siendo MP3, M4A sigue siendo M4A, etc.
- **Estéreo que en realidad es mono** (una predicación, una grabación de Zoom o de un micro
  USB: el mismo sonido en los dos canales, o un canal vacío): se guarda en **mono**, la mitad
  de peso sin cambiar nada de lo que se oye. En música, solo si los dos canales son prácticamente
  idénticos; el estéreo de verdad nunca se toca. En la cola verás «mono».
- **Portadas**: una portada de 2000-3000 px puede pesar más que la canción. Se reduce a 600 px.
  Si el audio ya era óptimo, se **copia sin recodificar** y solo cambia la portada.
- **Se conservan** el título, el artista, la portada (en MP3 y M4A) y los capítulos
  de los audiolibros `.m4b`. Con varias pistas de audio (MKA) se guardan todas.
- En **Ajustes** hay dos opciones de audio:
  - **Tipo de audio**: «Música» (por defecto, no baja la calidad de nada) o **«Solo voz»**
    (charlas, predicaciones, notas de voz): guarda en mono y a menos tasa, y pesa 2 a 3 veces
    menos con una voz que suena igual. No se adivina solo; es mejor guardarlo en un **perfil**
    (por ejemplo «Predicaciones») y cambiar de perfil según la carpeta.
  - **Formato de audio**: «Compatible» (por defecto: MP3/M4A, suena en todo), «Opus» (pesa
    un 35 % menos con la misma calidad, pero necesita un reproductor moderno y no guarda la
    portada) o «FLAC» (WAV, AIFF y similares a la mitad de peso, idénticos bit a bit; lo que
    ya tiene pérdida no se pasa a FLAC porque pesaría más).
- La **Calidad** y el **Modo agresivo** de Ajustes valen también para el audio; con
  la calidad por defecto (90) no se nota diferencia de oído. Si no ahorra al
  menos un 5 %, se deja el original. Un MP3 de música que ya viene a 128-192 kbps no se
  puede reducir más sin perder calidad: la única vía es Opus.
- Los audios se comprimen **hasta 4 a la vez** y no esperan a los vídeos largos.
  No tienen vista previa (no hay nada que ver).

### Vídeos

Se aceptan MP4, MOV, MKV, AVI, WebM, WMV, FLV, MPG, VOB, 3GP, MTS/M2TS y
otros. **Todos salen como MP4.** Los vídeos se comprimen **de uno en uno**
(cada uno usa todo el procesador) y, mientras tanto, la fila muestra el
porcentaje real. La barra de **Calidad** y el **Modo agresivo** de Ajustes
valen también para vídeo; con la calidad por defecto (90) no se nota
diferencia a simple vista. Compacta no reescala el vídeo ni cambia sus
fotogramas por segundo, conserva el audio (el AAC/MP3 sin tocarlo) y, si un
vídeo ya está tan comprimido que no ahorraría al menos un 5 %, **lo deja
idéntico** en vez de degradarlo para nada. Un vídeo largo puede tardar
varios minutos: el botón **Detener** deja terminar el que está en curso.

**Subtítulos:** no se pierden. Si el vídeo lleva subtítulos de texto simple
(SRT), van dentro del MP4. Si lleva subtítulos con estilo (ASS) o de imagen
(los de Blu-ray y DVD), un MP4 no puede guardarlos, así que **ese vídeo sale
como MKV** con todos los subtítulos, sus idiomas y las marcas de "por defecto"
y "forzado" intactos. Un archivo de subtítulos aparte (`.srt` junto al vídeo)
no se copia.

**En Mac:** hay dos instaladores, y los dos sirven para Mac Intel y para Mac con chip Apple. Si tu Mac tiene macOS 13 (Ventura) o más nuevo, usa
`Compacta-…-Mac.dmg`; si tiene macOS 10.13 a 12, usa `Compacta-…-Mac-antiguo.dmg` (funciona, pero lleva un motor más antiguo y puede dar
algún problema que la normal no da). La interfaz es la misma que en Windows. Para ver tu macOS: menú  → «Acerca de este Mac». En un Mac con Apple Silicon y
macOS 11, los vídeos y los audios necesitan además Rosetta (si no la tienes, Compacta te lo dice y te da el comando de una línea para
instalarla; las fotos funcionan igual). Si tu Mac todavía tiene macOS 10.12 (Sierra) o más viejo: Apple publica la misma lista de equipos
compatibles para 10.12 y para 10.13 (High Sierra), así que ese Mac puede actualizarse gratis a macOS 10.13 desde la App Store y entonces Compacta funciona. Si un archivo RAR no se abre en un Mac o Windows
antiguo, vuelve a comprimirlo como ZIP o 7z, o instala 7-Zip y Compacta lo
usará.

## 3. Ver el progreso

Cada foto aparece en la lista con:
- Un anillo alrededor de su miniatura: gris mientras espera, ámbar girando
  mientras se procesa, verde cuando termina.
- El tamaño de antes y de después (por ejemplo "3.2 MB → 1.8 MB").
- El porcentaje que se ahorró (por ejemplo "-44%").

Arriba a la derecha de la lista se ve cuánto se ha ahorrado en total.

**Barra de progreso del lote.** Cuando hay más de un archivo, debajo del título
de la lista aparece una barra con cuántos van hechos ("12 de 40") y cuánto
tiempo falta aproximadamente ("quedan 3 min"). Al principio dice "calculando…"
hasta que hay datos para estimarlo; con vídeos puede tardar un poco más en
afinarse. La barra nunca retrocede. Mientras todavía se están importando
carpetas dice "importando…" (y "quedan al menos…"), porque puede llegar más
trabajo. Si detienes la cola, el tiempo en pausa no cuenta.

**Ver el antes y el después.** En cada foto o vídeo ya terminado hay un botón con
un ojo. Al pulsarlo se abre una ventana con la original y la comprimida,
superpuestas: arrastra sobre la imagen para mover la línea (a la izquierda ves
la original, a la derecha la comprimida). Con una buena compresión las dos se
ven casi igual a ese tamaño, y es lo normal: para notar la diferencia pon el
ratón sobre una zona y pulsa **«Ver al 100 %»** (o haz doble clic, o la tecla Z):
verás esa zona sin reducir, y el mapa pequeño te deja cambiar de zona. En vídeos
se compara un fotograma (no hay "100 %"). El archivo guardado siempre conserva
su tamaño completo.

**Cambiar el orden de lo que está en espera.** Cada fila que aún no ha empezado
tiene un asa (seis puntitos) a la izquierda: arrástrala (o agarra la fila por cualquier parte) sobre otra fila para
cambiar cuál se procesa antes. Con teclado: ponte sobre el asa y pulsa
**Alt + flecha arriba/abajo** (en Mac, **Option**). Lo que ya está procesándose
o terminó no se mueve.

Si dejas la app procesando un lote de 5 fotos o más mientras haces otra
cosa en la computadora, al terminar aparece una notificación del sistema
(la de Windows/Mac, no dentro de la app) — no hace falta quedarse mirando
la ventana. La barra espaciadora también sirve como atajo para
Detener/Reanudar sin tener que hacer clic.

## 4. Perfiles

Si sueles comprimir para distintos usos (por ejemplo, fotos para imprimir y
fotos para proyectar en pantalla), puedes guardar cada combinación de
ajustes como un **perfil** con su propio nombre, y cambiar entre ellos con
el desplegable que está arriba de "Calidad" en Ajustes:

- **Crear uno nuevo** (botón +): guarda los ajustes que tengas puestos en
  ese momento bajo el nombre que le pongas.
- **Renombrar** (lápiz): cambia el nombre del perfil seleccionado.
- **Eliminar** (papelera): lo borra. Pide confirmación porque no se puede
  deshacer. No se puede borrar si es el único perfil que queda.

Si mueves un slider o interruptor mientras un perfil está seleccionado, el
cambio se guarda en ese perfil automáticamente — no hace falta un botón
"Guardar" aparte.

## 5. Detener, reanudar o eliminar

Si necesitas parar (por ejemplo, la computadora se está usando para otra cosa
en ese momento), hay un botón **Detener** que aparece mientras hay fotos
procesándose. La foto que está a la mitad termina normalmente (no se
interrumpe), pero no empieza ninguna nueva. El botón cambia a **Reanudar**
para continuar cuando quieras — nada se pierde ni se repite.

Si en vez de continuar prefieres descartar lo que quedó en espera, junto a
"Reanudar" aparece un botón **Eliminar pendientes**. Te pide confirmación
porque no se puede deshacer: las fotos que aún no se habían procesado se
quitan de la lista y no se comprimen. Las que ya habían terminado no se
tocan.

## 6. Ajustes (ícono de engranaje, arriba a la derecha)

- **HEIC (iPhone): pasar siempre a JPG**: apagado, las fotos HEIC solo se convierten si salen más ligeras. Actívalo si prefieres que se abran en cualquier equipo aunque pesen más.
- **Idioma**: español, inglés, alemán, italiano, vietnamita o árabe (el árabe
  se lee de derecha a izquierda y la ventana entera se refleja). Por defecto
  usa el idioma de tu equipo (si no es uno de esos seis, inglés). Cambia al
  instante, sin reiniciar, y no depende del perfil.
- **Calidad** (60 a 100, por defecto 90): más alta significa más fiel a la
  foto original pero con menos ahorro de espacio. 90 ya es prácticamente
  indistinguible a simple vista.
- **Modo agresivo**: comprime más agresivamente a cambio de un poco más de
  ahorro. Puede notarse levemente en fotos con degradados muy suaves (como
  cielos despejados). Apagado por defecto.
- **Convertir todo a WebP**: cambia el formato de las fotos a WebP, un
  formato más moderno y eficiente. Las fotos convertidas se siguen viendo
  igual, solo cambia la extensión del archivo (de `.jpg` a `.webp`).

- **Carpeta de salida**: dónde se guarda lo procesado. Con **Cambiar…** eliges
  otra (por ejemplo un disco externo o una carpeta compartida); con
  **Restablecer** vuelves a la de siempre. Compacta comprueba que se pueda
  escribir ahí, y no deja elegir una carpeta que esté dentro de la de entrada.
  Si más adelante esa carpeta no está disponible (el disco está desenchufado),
  Compacta guarda en la de siempre y te lo avisa; al volver a conectarlo, usa la
  que elegiste. Lo que ya estaba en la carpeta anterior no se mueve.
- **Omitir duplicados** (activado por defecto): si sueltas una foto, vídeo o audio
  exactamente igual (byte a byte) a otro que soltaste a la vez, o a otro que ya
  está en la cola o ya comprimido en la carpeta de salida, se omite y te lo dice con un **aviso que se queda en pantalla** (no desaparece
  solo) y un botón **Procesar de todos modos**, que vuelve a comprimir justo lo
  omitido sin cambiar este ajuste.
  Las fotos *parecidas* pero distintas (la misma escena con la boca abierta y con
  la cerrada, una ráfaga, la misma foto guardada con otra calidad) NO se omiten
  nunca. Si borraste lo comprimido, soltarlo otra vez se procesa de nuevo. Apágalo
  si quieres volver a comprimir lo mismo con otros ajustes.
- **Compresión máxima (más lenta)**: ver arriba, en Vídeos y en la descripción
  del propio ajuste.

Los cambios en Ajustes aplican a las fotos que se procesen de ahí en
adelante, no reprocesan las que ya estaban listas.

## 7. Dónde quedan las fotos

Compacta usa dos carpetas dentro de tus Documentos:

```
Documentos\Compacta\input\    fotos originales, organizadas como las soltaste
Documentos\Compacta\output\   el resultado, con la misma organización de carpetas
```

El botón **Abrir carpeta de salida** te lleva directo a la carpeta de salida
vigente (la de siempre, o la que elegiste en Ajustes). Los subtítulos en archivo
aparte (por ejemplo `Pelicula.srt` junto a `Pelicula.mkv`) viajan con su vídeo y
se copian a la salida con el mismo nombre que el vídeo resultante.

## 8. Cerrar la app a la mitad de un lote grande

No hay problema. Si cierras Compacta mientras procesa muchas fotos, al
volver a abrirla retoma sola lo que faltaba, sin repetir lo que ya había
terminado y sin dejar ningún archivo a medias o dañado.

## 9. Desinstalar

Windows → Configuración → Aplicaciones → busca "Compacta" → Desinstalar.

Esto **no borra tus fotos**. Tus fotos (originales y comprimidas) viven en la
carpeta `Documentos\Compacta`, completamente separada del programa en sí.
Desinstalar Compacta no toca esa carpeta.

## Preguntas frecuentes

**¿Necesito internet?** No, todo el procesamiento es local.

**¿Se puede perder calidad?** Con los ajustes por defecto (calidad 90, modo
agresivo apagado), la diferencia es imperceptible a simple vista. Para una
garantía matemática de cero pérdida en fotos JPEG, sube la calidad a 100. Los
PNG (capturas de pantalla, por ejemplo) sí son 100% sin pérdida por defecto,
con cualquier calidad.

**Convertí a WebP y una foto no cambió de tamaño.** Es la salvaguarda de la
app funcionando correctamente: si por algún motivo la versión comprimida
saliera más pesada que la original (raro, pero posible en fotos ya muy
comprimidas), Compacta prefiere dejar el archivo original intacto antes que
"mejorarlo" empeorándolo.

**Tengo un problema o error.** Manda una captura de pantalla del mensaje de
error a quien te compartió este instalador.

**Me aparece un aviso sobre OneDrive/iCloud.** Significa que tu carpeta
"Documentos" está sincronizada con la nube. No es un error ni impide usar
la app, pero si notas que Compacta vuelve a comprimir fotos que ya había
terminado, puede deberse a que la nube tarda en mostrar localmente lo que
ya está guardado. Si te pasa seguido, prueba excluir la carpeta "Compacta"
de la sincronización (OneDrive: clic derecho sobre la carpeta → "Liberar
espacio" desactivado / "Mantener siempre en este dispositivo"; iCloud:
Preferencias del Sistema → Apple ID → iCloud → Desactivar "Escritorio y
Documentos" o excluir la subcarpeta).
