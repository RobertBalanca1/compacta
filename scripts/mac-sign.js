'use strict';

/**
 * Firma de la app de Mac (la llama electron-builder: `build.mac.sign` en package.json).
 *
 * POR QUE EXISTE. Sin certificado de Apple (99 USD/año), electron-builder NO firma nada. En un Mac con Apple Silicon
 * eso es grave: el sistema exige que todo programa lleve una firma valida, y el .app sale de electron-builder con la
 * firma original de Electron ya ROTA (se cambia el nombre y el Info.plist), asi que macOS lo rechaza con «"Compacta" esta
 * danado y no se puede abrir». Una firma «ad-hoc» (sin identidad, gratuita, la hace `codesign -s -`) basta para que
 * el sistema lo trate como un programa normal sin verificar: sale el aviso de siempre («Apple no pudo verificar...»), que
 * se salta una vez en Ajustes del Sistema > Privacidad y seguridad > «Abrir igualmente».
 *
 * QUE HACE.
 *  - Con certificado (variables CSC_LINK / CSC_KEY_PASSWORD, `opts.identity` ya resuelto): lo de siempre, sin cambios.
 *  - Sin certificado: firma ad-hoc TODO el paquete, de dentro hacia fuera, con el mismo recorrido que usa electron-builder
 *    (incluye el ffmpeg de Resources/ffmpeg y las librerias nativas de sharp).
 *
 * Detalles que importan:
 *  - `timestamp: 'none'`: el sello de hora de Apple necesita red y no tiene sentido en una firma ad-hoc.
 *  - `hardenedRuntime: false`: con «runtime» activado, macOS solo deja cargar librerias firmadas por el MISMO equipo de
 *    desarrollo; una firma ad-hoc no tiene equipo, asi que ni Electron podria cargar sus propias librerias. El
 *    «runtime» solo hace falta para notarizar (requiere el certificado de pago): al tenerlo, poner
 *    `hardenedRuntime: true` en package.json y añadir `build/entitlements.mac.plist` (ver DOCUMENTACION 7.23).
 */

function loadOsxSign() {
  // @electron/osx-sign llega como dependencia de electron-builder: se busca desde ahi, sin añadir nada a package.json.
  const entry = require.resolve('@electron/osx-sign', { paths: [require.resolve('app-builder-lib')] });
  return require(entry);
}

module.exports = async function signMacApp(options) {
  const { signAsync } = loadOsxSign();
  if (options.identity) return signAsync(options);

  const optionsForFile = options.optionsForFile;
  return signAsync({
    ...options,
    identity: '-',
    identityValidation: false,
    optionsForFile: (file) => ({ ...(optionsForFile ? optionsForFile(file) : {}), timestamp: 'none', hardenedRuntime: false })
  });
};
