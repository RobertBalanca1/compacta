'use strict';

/**
 * Auditoria de codigo: `npm run audit`. Sirve para repetir antes de cada version la limpieza que se hizo
 * en 1.0.13 (ver DOCUMENTACION-PROYECTO.md, 7.20), sin instalar nada. Informa de:
 *   1. exports que nadie importa (ni en src, ni en tests, ni en scripts),
 *   2. funciones, constantes e imports declarados y sin ningun uso,
 *   3. funciones largas (mas de LONG_FUNCTION_LINES lineas): candidatas a dividir,
 *   4. dependencias de package.json que ningun archivo menciona.
 * Es una ayuda, no un juez: un nombre que se arma dinamicamente (clases CSS como `queue-item--${estado}`)
 * o un punto de entrada (main, preload) pueden salir como "sin uso" y no lo estan. Sale con codigo 1 si
 * encuentra algo en 1 o 2 (lo que SI es basura segura); las funciones largas solo se avisan.
 */

const fs = require('fs');
const path = require('path');

const LONG_FUNCTION_LINES = 90;
const root = path.resolve(__dirname, '..');
const walk = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }) : []).flatMap((entry) => {
  if (entry.name === 'node_modules') return [];
  const full = path.join(dir, entry.name);
  return entry.isDirectory() ? walk(full) : [full];
});
const read = (file) => fs.readFileSync(file, 'utf8');
const count = (text, name) => (text.match(new RegExp(`\\b${name}\\b`, 'g')) || []).length;

const srcJs = walk(path.join(root, 'src')).filter((f) => f.endsWith('.js'));
const everyFile = [...srcJs, ...walk(path.join(root, 'tests')), ...walk(path.join(root, 'scripts'))].filter((f) => f.endsWith('.js'));
const text = Object.fromEntries(everyFile.map((f) => [f, read(f)]));
const rel = (f) => path.relative(root, f);
const usedElsewhere = (name, file) => everyFile.some((other) => other !== file && new RegExp(`\\b${name}\\b`).test(text[other]));

const problems = [];

// 1) exports sin ningun uso externo (solo el proceso principal: la ventana no usa module.exports)
for (const file of srcJs.filter((f) => !f.includes(`${path.sep}renderer${path.sep}`))) {
  const match = /module\.exports\s*=\s*\{([\s\S]*?)\};?\s*$/m.exec(text[file]);
  if (!match) continue;
  for (const name of match[1].split(',').map((s) => s.trim().split(':')[0].trim()).filter((s) => /^\w+$/.test(s))) {
    if (!usedElsewhere(name, file)) problems.push(`export sin uso: ${rel(file)}  ${name}`);
  }
}

// 2) funciones, constantes e imports sin ningun uso
for (const file of srcJs) {
  const code = text[file];
  for (const m of code.matchAll(/^\s*(?:async\s+)?function\s+(\w+)/gm)) {
    if (count(code, m[1]) <= 1 && !usedElsewhere(m[1], file)) problems.push(`funcion sin uso: ${rel(file)}  ${m[1]}`);
  }
  for (const m of code.matchAll(/^\s*(?:const|let)\s+(\w+)\s*=/gm)) {
    if (count(code, m[1]) <= 1) problems.push(`variable sin uso: ${rel(file)}  ${m[1]}`);
  }
  for (const m of code.matchAll(/const\s+\{([^}]+)\}\s*=\s*require\(/g)) {
    for (const name of m[1].split(',').map((s) => s.trim().split(':').pop().trim()).filter(Boolean)) {
      if (count(code, name) <= 1) problems.push(`import sin uso: ${rel(file)}  ${name}`);
    }
  }
}

// 3) funciones largas (solo aviso)
const long = [];
for (const file of srcJs) {
  const lines = text[file].split('\n');
  lines.forEach((line, start) => {
    const m = /^(\s{0,4})(?:async\s+)?function\s+(\w+)|^(\s{2})(?:async\s+)?(\w+)\([^)]*\)\s*\{$/.exec(line);
    if (!m) return;
    const indent = (m[1] ?? m[3]).length;
    for (let end = start + 1; end < lines.length; end++) {
      if (lines[end].match(/^\s*/)[0].length === indent && /^\s*\}[;,)]*\s*$/.test(lines[end])) {
        if (end - start + 1 > LONG_FUNCTION_LINES) long.push({ lines: end - start + 1, where: `${rel(file)}  ${m[2] || m[4]}` });
        break;
      }
    }
  });
}

// 4) dependencias que nadie menciona
const pkg = JSON.parse(read(path.join(root, 'package.json')));
const everything = [...everyFile, path.join(root, 'package.json'), ...walk(path.join(root, '.github'))].map((f) => (text[f] || read(f))).join('\n');
for (const kind of ['dependencies', 'devDependencies']) {
  for (const dep of Object.keys(pkg[kind] || {})) {
    const mentions = everything.split(dep).length - 1;
    if (mentions <= 1) problems.push(`dependencia sin uso (${kind}): ${dep}`);
  }
}

console.log(`Auditoria de codigo (${srcJs.length} archivos en src)\n`);
if (problems.length === 0) console.log('Sin codigo sin uso: ni exports, ni funciones, ni variables, ni imports, ni dependencias.');
else problems.forEach((p) => console.log(`  ${p}`));
if (long.length > 0) {
  console.log(`\nFunciones de mas de ${LONG_FUNCTION_LINES} lineas (candidatas a dividir, solo aviso):`);
  long.sort((a, b) => b.lines - a.lines).forEach((l) => console.log(`  ${String(l.lines).padStart(4)}  ${l.where}`));
}
process.exit(problems.length > 0 ? 1 : 0);
