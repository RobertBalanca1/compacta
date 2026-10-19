'use strict';

// ZIP CIFRADOS reales, fabricados por herramientas externas (no por el codigo de la app): el `zip` de Info-ZIP para el
// cifrado clasico (ZipCrypto) y `pyzipper` para AES de WinZip. Si faltan, `ENCRYPTED_ZIP_AVAILABLE` es false y esas
// pruebas se omiten. Instalar: `pip install pyzipper --break-system-packages`; `zip` viene en casi todos los Linux/Mac.

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const HAS_ZIP = spawnSync('zip', ['-v'], { stdio: 'ignore' }).status === 0;
const HAS_PYZIPPER = spawnSync('python3', ['-c', 'import pyzipper'], { stdio: 'ignore' }).status === 0;

/**
 * kind: 'zipcrypto' | 'aes128' | 'aes192' | 'aes256'. files: [{ name, data(Buffer) }]. store: sin comprimir (metodo 0).
 * Devuelve true si lo creo.
 */
function makeEncryptedZip(outPath, files, { kind = 'zipcrypto', password = 'secreto', store = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'compacta-enc-'));
  try {
    for (const file of files) {
      fs.mkdirSync(path.dirname(path.join(dir, file.name)), { recursive: true });
      fs.writeFileSync(path.join(dir, file.name), file.data);
    }
    fs.rmSync(outPath, { force: true });
    if (kind === 'zipcrypto') {
      if (!HAS_ZIP) return false;
      const args = ['-q', '-r', store ? '-0' : '-6', '-P', password, outPath, ...files.map((f) => f.name)];
      return spawnSync('zip', args, { cwd: dir }).status === 0;
    }
    if (!HAS_PYZIPPER) return false;
    const bits = { aes128: 128, aes192: 192, aes256: 256 }[kind];
    const script = `
import sys, json, pyzipper
out, password, bits, store, names = sys.argv[1], sys.argv[2].encode('utf-8'), int(sys.argv[3]), sys.argv[4] == '1', json.loads(sys.argv[5])
method = pyzipper.ZIP_STORED if store else pyzipper.ZIP_DEFLATED
with pyzipper.AESZipFile(out, 'w', compression=method, encryption=pyzipper.WZ_AES) as z:
    z.setpassword(password)
    z.setencryption(pyzipper.WZ_AES, nbits=bits)
    for name in names:
        z.write(name, name)
`;
    return spawnSync('python3', ['-c', script, outPath, password, String(bits), store ? '1' : '0', JSON.stringify(files.map((f) => f.name))], { cwd: dir }).status === 0;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

module.exports = { makeEncryptedZip, ENCRYPTED_ZIP_AVAILABLE: HAS_ZIP && HAS_PYZIPPER };
