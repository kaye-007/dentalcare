#!/usr/bin/env node
/**
 * Class-vs-stylesheet audit.
 *
 * This repo's recurring failure mode is markup that compiles and ships while
 * being visually wrong. `className` is just a string: tsc will not tell you
 * that no rule matches it, so the element renders unstyled and the build stays
 * green. The reverse — a rule nothing references — is dead weight that later
 * reads as intent, which is how the `.auth__hint` block outlived the demo
 * credentials it styled.
 *
 * Per SPA it reports:
 *   MISSING  used in JSX, defined by no CSS rule   -> exit 1, this is a bug
 *   DEAD     defined in CSS, referenced by no JSX  -> reported, not fatal
 *
 * Dynamic names are resolved rather than ignored. `odo__outline--${outline}`
 * contributes the prefix `odo__outline--`, which suppresses DEAD for every
 * rule sharing it; an interpolation whose branches are string literals is
 * expanded to its real values, so `${next ? 'btn--primary' : 'btn--ghost'}`
 * counts as both.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const APPS = [
  {
    name: 'tenant-web',
    src: 'apps/tenant-web/src',
    css: 'apps/tenant-web/src/styles.css',
  },
  { name: 'admin-web', src: 'apps/admin-web/src', css: 'apps/admin-web/src/styles.css' },
];

/** Stands in for a class fragment whose value is only known at runtime. */
const DYN = '\u0000';

// ── generic scanning helpers ────────────────────────────────────────────────

/** Index of the closing brace matching the one at `open`, skipping literals. */
function matchBrace(s, open) {
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    const c = s[i];
    if (c === '\\') {
      i++;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      i = endOfString(s, i);
      continue;
    }
    if (c === '/' && s[i + 1] === '/') {
      const nl = s.indexOf('\n', i);
      if (nl < 0) return s.length - 1;
      i = nl;
      continue;
    }
    if (c === '/' && s[i + 1] === '*') {
      const e = s.indexOf('*/', i);
      if (e < 0) return s.length - 1;
      i = e + 1;
      continue;
    }
    if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return i;
  }
  return s.length - 1;
}

/** Index of the quote closing the string that opens at `start`. */
function endOfString(s, start) {
  const q = s[start];
  for (let i = start + 1; i < s.length; i++) {
    if (s[i] === '\\') {
      i++;
      continue;
    }
    if (q === '`' && s[i] === '$' && s[i + 1] === '{') {
      i = matchBrace(s, i + 1);
      continue;
    }
    if (s[i] === q) return i;
  }
  return s.length - 1;
}

/** Every string / template literal appearing anywhere in `src`. */
function literalsIn(src) {
  const out = [];
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === '"' || c === "'" || c === '`') {
      const end = endOfString(src, i);
      out.push({ quote: c, raw: src.slice(i + 1, end), start: i, end });
      i = end;
    }
  }
  return out;
}

/**
 * Literals in *value* position — the ones that can actually become classes.
 *
 * Naively taking every literal in an expression reads the condition too:
 * `tab === 'team' ? ' tab--active' : ''` would contribute `team`, which
 * concatenates onto the static prefix and invents a class nobody wrote. Three
 * things are excluded: everything left of a top-level `?`, operands of a
 * comparison, and call arguments such as `t('nav.patients')`.
 */
function valueLiterals(code) {
  const q = topLevelTernary(code);
  const scope = q >= 0 ? code.slice(q + 1) : code;
  return literalsIn(scope).filter(
    (l) => !isComparisonOperand(scope, l) && !isCallArgument(scope, l),
  );
}

/** Index of the `?` of a ternary at depth 0, skipping `?.` and `??`. */
function topLevelTernary(code) {
  let depth = 0;
  for (let i = 0; i < code.length; i++) {
    const c = code[i];
    if (c === '\\') {
      i++;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      i = endOfString(code, i);
      continue;
    }
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
    else if (
      c === '?' &&
      depth === 0 &&
      code[i + 1] !== '.' &&
      code[i + 1] !== '?' &&
      code[i - 1] !== '?'
    )
      return i;
  }
  return -1;
}

function isComparisonOperand(code, lit) {
  const before = code.slice(0, lit.start).trimEnd();
  if (/[=!]=$/.test(before)) return true;
  const after = code.slice(lit.end + 1).trimStart();
  return /^[=!]=/.test(after);
}

function isCallArgument(code, lit) {
  const before = code.slice(0, lit.start).trimEnd();
  return before.endsWith('(') && /[\w.$\]]$/.test(before.slice(0, -1).trimEnd());
}

// ── template-literal expansion ──────────────────────────────────────────────

/** Concrete strings a template literal can produce; DYN marks unknown parts. */
function expandTemplate(raw) {
  const statics = [];
  const interps = [];
  let cur = '';
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] === '\\') {
      cur += raw[i] + (raw[i + 1] || '');
      i++;
      continue;
    }
    if (raw[i] === '$' && raw[i + 1] === '{') {
      const end = matchBrace(raw, i + 1);
      statics.push(cur);
      cur = '';
      interps.push(raw.slice(i + 2, end));
      i = end;
      continue;
    }
    cur += raw[i];
  }
  statics.push(cur);

  const options = interps.map((code) => {
    const lits = valueLiterals(code).map((l) =>
      l.quote === '`' && l.raw.includes('${') ? DYN : l.raw,
    );
    return lits.length ? lits : [DYN];
  });

  let combos = [[]];
  for (const opts of options) {
    const next = [];
    for (const combo of combos)
      for (const o of opts) if (next.length < 128) next.push(combo.concat(o));
    combos = next;
  }

  return combos.map((combo) => {
    let s = statics[0];
    for (let i = 0; i < combo.length; i++) s += combo[i] + statics[i + 1];
    return s;
  });
}

// ── the two sides being compared ────────────────────────────────────────────

/** Classes referenced by JSX, as exact names plus dynamic prefixes. */
function classesUsed(files) {
  const exact = new Map(); // class -> "file:line"
  const prefixes = new Set();

  for (const file of files) {
    const src = fs.readFileSync(file, 'utf8');
    const lineAt = lineIndexer(src);
    const re = /\bclassName\s*=\s*/g;
    let m;
    while ((m = re.exec(src))) {
      const at = m.index + m[0].length;
      const c = src[at];
      let body;
      if (c === '"' || c === "'") {
        const end = endOfString(src, at);
        body = [{ quote: c, raw: src.slice(at + 1, end) }];
        re.lastIndex = end + 1;
      } else if (c === '{') {
        const end = matchBrace(src, at);
        body = valueLiterals(src.slice(at + 1, end));
        re.lastIndex = end + 1;
      } else continue;

      const where = path.relative(REPO, file).replace(/\\/g, '/') + ':' + lineAt(at);
      for (const lit of body) {
        const strings = lit.quote === '`' ? expandTemplate(lit.raw) : [lit.raw];
        for (const s of strings) {
          for (const token of s.split(/\s+/)) {
            if (!token) continue;
            const d = token.indexOf(DYN);
            if (d < 0) {
              if (!exact.has(token)) exact.set(token, where);
            } else if (d > 0) prefixes.add(token.slice(0, d));
          }
        }
      }
    }
  }
  return { exact, prefixes };
}

/** Classes defined by the stylesheet, mapped to the line that defines them. */
function classesDefined(cssPath) {
  const css = fs
    .readFileSync(cssPath, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ' ')); // blank comments, keep lines
  const lineAt = lineIndexer(css);
  const defined = new Map();
  let i = 0;

  (function block() {
    let buf = '';
    while (i < css.length) {
      const c = css[i];
      if (c === '"' || c === "'") {
        const e = endOfString(css, i);
        buf += css.slice(i, e + 1);
        i = e + 1;
        continue;
      }
      if (c === '{') {
        const prelude = buf.trim();
        const startsAt = i - buf.length;
        buf = '';
        i++;
        // @media / @supports preludes are not selectors, but their bodies hold
        // rules, so descend either way.
        if (prelude && !prelude.startsWith('@')) {
          for (const name of selectorClasses(prelude)) {
            if (!defined.has(name)) defined.set(name, lineAt(startsAt));
          }
        }
        block();
        continue;
      }
      if (c === '}') {
        i++;
        return;
      }
      if (c === ';') {
        buf = '';
        i++;
        continue;
      } // a declaration, not a prelude
      buf += c;
      i++;
    }
  })();

  return defined;
}

function selectorClasses(selector) {
  const cleaned = selector.replace(/\[[^\]]*\]/g, ''); // [href=".pdf"] is not a class
  return [...cleaned.matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)].map((m) => m[1]);
}

function lineIndexer(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') starts.push(i + 1);
  return (idx) => {
    let lo = 0,
      hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= idx) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
}

function sourceFiles(dir, acc = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name !== 'node_modules') sourceFiles(p, acc);
    } else if (/\.(tsx|jsx|ts|js)$/.test(e.name)) acc.push(p);
  }
  return acc;
}

// ── report ──────────────────────────────────────────────────────────────────

let failures = 0;
for (const app of APPS) {
  const cssPath = path.join(REPO, app.css);
  const srcDir = path.join(REPO, app.src);
  if (!fs.existsSync(cssPath) || !fs.existsSync(srcDir)) {
    console.error(
      '  ' + app.name + ': missing ' + (fs.existsSync(cssPath) ? app.src : app.css),
    );
    failures++;
    continue;
  }

  const { exact, prefixes } = classesUsed(sourceFiles(srcDir));
  // Every stylesheet at the top of src/, not only styles.css: main.tsx imports
  // operations.css, messaging.css, print.css and drawer.css too, and reading
  // one of them reported every class the others define as MISSING.
  const defined = new Map();
  const sheets = [
    cssPath,
    ...fs
      .readdirSync(srcDir)
      .filter((f) => f.endsWith('.css'))
      .map((f) => path.join(srcDir, f))
      .filter((f) => f !== cssPath),
  ];
  for (const sheet of sheets) {
    for (const [name, line] of classesDefined(sheet)) {
      if (!defined.has(name)) defined.set(name, `${path.basename(sheet)}:${line}`);
    }
  }
  const byPrefix = (name) => [...prefixes].some((p) => p && name.startsWith(p));

  const missing = [...exact.keys()].filter((c) => !defined.has(c)).sort();
  const dead = [...defined.keys()].filter((c) => !exact.has(c) && !byPrefix(c)).sort();

  console.log(
    '\n' +
      app.name +
      '  ' +
      exact.size +
      ' classes used, ' +
      defined.size +
      ' defined, ' +
      prefixes.size +
      ' dynamic prefixes',
  );

  if (missing.length) {
    failures += missing.length;
    console.log('  MISSING - used in JSX, no CSS rule (' + missing.length + '):');
    for (const c of missing) console.log('    .' + c + '  <- ' + exact.get(c));
  } else {
    console.log('  MISSING - none');
  }

  if (dead.length) {
    console.log('  DEAD - defined in CSS, never referenced (' + dead.length + '):');
    for (const c of dead)
      console.log('    .' + c + '  <- ' + app.src + '/' + defined.get(c));
  } else {
    console.log('  DEAD - none');
  }
}

if (failures) {
  console.error('\nFAIL: ' + failures + ' class(es) used without a matching rule.');
  process.exit(1);
}
console.log('\nOK: every class used in JSX has a rule.');
