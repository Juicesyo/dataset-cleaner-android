/**
 * Static check for the native Android sources.
 *
 * Why this exists: the Java plugin cannot be compiled locally (no Android SDK),
 * so a missing `import` stays invisible until a slow CI round trip. That is
 * exactly how `Logger` reached CI unresolved and failed the build. This check
 * catches that class of mistake in under a second.
 *
 * A plain regex over the source is not enough. The plugin passes the MIME
 * wildcard to `Intent.setType`, and a naive comment stripper mistakes the
 * block-comment opener inside that string literal for a comment, swallowing the
 * rest of the file. The source is therefore tokenised first, skipping comments
 * and string and character literals properly.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// Directory is overridable so the check itself can be exercised against a
// deliberately broken copy.
const DIR = process.argv[2] ?? 'android-plugin';

/**
 * Replaces comments and literals with blanks, preserving offsets.
 *
 * Text blocks (`"""`) are handled too, even though this project does not use
 * them, so the tokeniser cannot be fooled by a future edit.
 */
function stripCommentsAndLiterals(src) {
  let out = '';
  let i = 0;
  const n = src.length;

  while (i < n) {
    const c = src[i];
    const c2 = src[i + 1];

    // // line comment
    if (c === '/' && c2 === '/') {
      while (i < n && src[i] !== '\n') {
        out += ' ';
        i++;
      }
      continue;
    }

    // /* block comment
    if (c === '/' && c2 === '*') {
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) {
        out += src[i] === '\n' ? '\n' : ' ';
        i++;
      }
      out += '  ';
      i += 2;
      continue;
    }

    // """ text block
    if (c === '"' && src.startsWith('"""', i)) {
      out += '   ';
      i += 3;
      while (i < n && !src.startsWith('"""', i)) {
        out += src[i] === '\n' ? '\n' : ' ';
        i++;
      }
      out += '   ';
      i += 3;
      continue;
    }

    // "string" or 'char'
    if (c === '"' || c === "'") {
      const quote = c;
      let start = i;
      i++;
      while (i < n) {
        if (src[i] === '\\') {
          i += 2;
          continue;
        }
        if (src[i] === quote) {
          i++;
          break;
        }
        if (src[i] === '\n') break; // unterminated; do not run away
        i++;
      }
      out += ' '.repeat(i - start);
      continue;
    }

    out += c;
    i++;
  }

  return out;
}

/** Types provided by java.lang, which never need an import. */
const JAVA_LANG = new Set([
  'String', 'StringBuilder', 'StringBuffer', 'CharSequence', 'Character', 'Object',
  'Integer', 'Long', 'Short', 'Byte', 'Boolean', 'Double', 'Float', 'Number', 'Void',
  'Math', 'StrictMath', 'System', 'Runtime', 'Process', 'ProcessBuilder', 'Thread',
  'ThreadLocal', 'Class', 'ClassLoader', 'Package', 'Enum', 'Iterable', 'Comparable',
  'Throwable', 'Exception', 'RuntimeException', 'Error', 'IllegalArgumentException',
  'IllegalStateException', 'UnsupportedOperationException', 'NullPointerException',
  'IndexOutOfBoundsException', 'SecurityException', 'InterruptedException',
  'Override', 'Deprecated', 'SuppressWarnings', 'SafeVarargs', 'FunctionalInterface',
  'AutoCloseable', 'Cloneable', 'Readable', 'Appendable', 'Record',
]);

/** `Foo.Bar` where Foo is known means Bar is a nested type or constant. */
function collectNestedNames(code, known) {
  const nested = new Set();
  const re = /\b([A-Z][A-Za-z0-9_]*)\.([A-Z][A-Za-z0-9_]*)/g;
  let m;
  // One pass is enough in practice; two catches deeper chains.
  for (let pass = 0; pass < 2; pass++) {
    re.lastIndex = 0;
    while ((m = re.exec(code)) !== null) {
      if (known.has(m[1])) nested.add(m[2]);
    }
    for (const n of nested) known.add(n);
  }
  return nested;
}

function checkFile(path, samePackageTypes) {
  const raw = readFileSync(path, 'utf8');
  const code = stripCommentsAndLiterals(raw);

  const imported = new Set();
  for (const m of code.matchAll(/^\s*import\s+(?:static\s+)?([\w.]+)\s*;/gm)) {
    imported.add(m[1].split('.').pop());
  }

  // Types declared in this file, plus generic parameters.
  const declared = new Set();
  for (const m of code.matchAll(/\b(?:class|interface|enum|record)\s+([A-Z][A-Za-z0-9_]*)/g)) {
    declared.add(m[1]);
  }
  for (const m of code.matchAll(/<([A-Z][A-Za-z0-9_]*)\s*(?:,|>)/g)) declared.add(m[1]);

  const known = new Set([...imported, ...declared, ...samePackageTypes, ...JAVA_LANG]);
  collectNestedNames(code, known);

  // Capitalised identifiers that mix case: a constant like MAX_FILES is all
  // caps and is never a type, which keeps the heuristic quiet.
  //
  // Anything preceded by a dot is skipped: it is either the tail of a
  // fully-qualified name (`androidx.activity.result.ActivityResult`, which needs
  // no import) or a nested type reached through an imported class.
  const used = new Map();
  for (const m of code.matchAll(/(?<![.\w])([A-Z][A-Za-z0-9_]*)\b/g)) {
    const name = m[1];
    if (name === name.toUpperCase()) continue; // constant, not a type
    if (!used.has(name)) used.set(name, m.index);
  }

  const problems = [];
  for (const [name, index] of used) {
    if (known.has(name)) continue;
    const line = raw.slice(0, index).split('\n').length;
    const snippet = raw.split('\n')[line - 1]?.trim() ?? '';
    problems.push({ path, line, name, snippet });
  }
  return problems;
}

const files = readdirSync(DIR)
  .filter((f) => f.endsWith('.java'))
  .map((f) => join(DIR, f));

if (files.length === 0) {
  console.error(`没有在 ${DIR}/ 找到任何 .java 文件`);
  process.exit(1);
}

// Class names declared across the directory are treated as resolvable without an
// import, since these sources share one package.
const samePackageTypes = new Set();
for (const f of files) {
  const code = stripCommentsAndLiterals(readFileSync(f, 'utf8'));
  for (const m of code.matchAll(/\b(?:class|interface|enum|record)\s+([A-Z][A-Za-z0-9_]*)/g)) {
    samePackageTypes.add(m[1]);
  }
}

let problems = [];
for (const f of files) problems = problems.concat(checkFile(f, samePackageTypes));

if (problems.length > 0) {
  console.error('原生源码检查失败：以下类型被使用但没有 import\n');
  for (const p of problems) {
    console.error(`  ${p.path}:${p.line}  未导入: ${p.name}`);
    console.error(`      ${p.snippet}`);
  }
  console.error('\n请在文件顶部补上对应的 import。');
  process.exit(1);
}

console.log(`原生源码检查通过（${files.length} 个文件，无未导入的类型引用）`);
