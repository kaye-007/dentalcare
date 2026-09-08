/**
 * API smoke test — log in, then call every read endpoint the controllers
 * declare and report what comes back.
 *
 *   node scripts/smoke-api.js
 *
 * It exists because a NestJS app can compile cleanly, pass every unit test,
 * and still fail the moment it serves a request: dependency-injection wiring,
 * SQL column names and guard composition are all invisible to `tsc` and to a
 * test suite of pure functions. This is the cheapest check that the process
 * actually answers.
 *
 * The route list is DISCOVERED from the controller sources rather than
 * maintained by hand, so a new endpoint is covered the day it is written and
 * this file cannot quietly fall behind the code.
 *
 * A non-2xx is not automatically a bug — 404 on a record that was never
 * seeded is correct behaviour. 5xx always is.
 */
const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

const BASE = process.env.SMOKE_BASE || `http://localhost:${process.env.PORT || 3000}`;
const TENANT = process.env.DEV_TENANT_SUBDOMAIN || 'demo';
const EMAIL = process.env.SMOKE_EMAIL || 'demo@dentx.app';
const PASSWORD = process.env.SMOKE_PASSWORD || 'Demo@2026!';

const g = (s) => `\x1b[32m${s}\x1b[0m`;
const r = (s) => `\x1b[31m${s}\x1b[0m`;
const y = (s) => `\x1b[33m${s}\x1b[0m`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;

/* ── discover routes from the controller sources ─────────────────────── */
function discoverRoutes() {
  const files = [];
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.ts$/.test(p) && !/\.spec\.ts$/.test(p)) files.push(p);
    }
  })(path.resolve(__dirname, '../apps/api/src'));

  const routes = [];
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8');
    const marks = [];
    const cre = /@Controller\(\s*'([^']*)'\s*\)[\s\S]*?export class (\w+)/g;
    let m;
    while ((m = cre.exec(src))) marks.push({ prefix: m[1], cls: m[2], at: m.index });

    for (let i = 0; i < marks.length; i++) {
      const body = src.slice(
        marks[i].at,
        i + 1 < marks.length ? marks[i + 1].at : src.length,
      );
      const mre = /@(Get)\(\s*(?:'([^']*)')?\s*\)/g;
      let mm;
      while ((mm = mre.exec(body))) {
        const p = ('/api/' + marks[i].prefix + (mm[2] ? '/' + mm[2] : '')).replace(
          /\/+/g,
          '/',
        );
        routes.push({ path: p, cls: marks[i].cls });
      }
    }
  }
  return routes;
}

/* ── http ────────────────────────────────────────────────────────────── */
async function call(pathname, token) {
  const headers = { 'X-Tenant-Subdomain': TENANT };
  if (token) headers.Authorization = `Bearer ${token}`;
  try {
    const res = await fetch(BASE + pathname, { headers });
    let body = null;
    try {
      body = await res.json();
    } catch {
      /* not json */
    }
    return { status: res.status, body };
  } catch (e) {
    return { status: 0, body: { message: e.message } };
  }
}

/** First plausible id in a list response, whatever the envelope is called. */
function firstId(body) {
  if (!body) return null;
  const arr = Array.isArray(body)
    ? body
    : Object.values(body).find((v) => Array.isArray(v));
  if (!arr || arr.length === 0) return null;
  return arr[0].id ?? null;
}

async function main() {
  console.log(`\n\x1b[1mDentalCare — API smoke test\x1b[0m`);
  console.log(dim(`  ${BASE}  ·  tenant "${TENANT}"  ·  ${EMAIL}\n`));

  /* 1. is anything listening at all */
  const health = await call('/api/health');
  if (health.status === 0) {
    console.error(r(`  Nothing answering on ${BASE}. Start it with: npm run api:dev\n`));
    process.exit(1);
  }
  console.log(`  health  ${health.status === 200 ? g(health.status) : r(health.status)}`);

  /* 2. log in */
  const login = await fetch(BASE + '/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Tenant-Subdomain': TENANT },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  const loginBody = await login.json().catch(() => null);
  if (!login.ok || !loginBody?.accessToken) {
    console.error(
      r(
        `\n  Login failed (${login.status}): ${loginBody?.message || 'no token returned'}`,
      ),
    );
    console.error(
      dim('  Check the seed ran and SMOKE_EMAIL / SMOKE_PASSWORD match it.\n'),
    );
    process.exit(1);
  }
  const token = loginBody.accessToken;
  console.log(`  login   ${g(login.status)}  ${dim(loginBody.user?.role || '')}\n`);

  /* 3. collect real ids so the :param routes are exercised with real data */
  const ids = {};
  for (const [key, listPath] of [
    ['patientId', '/api/patients'],
    ['invoiceId', '/api/invoices'],
    ['appointmentId', '/api/appointments'],
  ]) {
    const res = await call(listPath, token);
    ids[key] = firstId(res.body);
  }
  if (ids.patientId) {
    for (const [key, p] of [
      ['perioExamId', `/api/patients/${ids.patientId}/perio-exams`],
      ['documentId', `/api/patients/${ids.patientId}/documents`],
      ['planId', `/api/patients/${ids.patientId}/treatment-plans`],
    ]) {
      const res = await call(p, token);
      ids[key] = firstId(res.body);
    }
  }

  /* 4. call everything */
  const routes = discoverRoutes()
    .filter((x) => !x.path.startsWith('/api/platform')) // different auth plane
    .filter((x) => x.path !== '/api/health');

  const substitute = (p) => {
    let out = p;
    if (/\/patients\/:(id|patientId)/.test(out))
      out = out.replace(/:(id|patientId)/, ids.patientId || '');
    else if (/\/invoices\/:id/.test(out)) out = out.replace(':id', ids.invoiceId || '');
    else if (/\/appointments\/:id/.test(out))
      out = out.replace(':id', ids.appointmentId || '');
    else if (/\/treatment-plans\/:id/.test(out))
      out = out.replace(':id', ids.planId || '');
    else if (/\/perio-exams\/:id/.test(out))
      out = out.replace(':id', ids.perioExamId || '');
    else if (/\/documents\/:id/.test(out)) out = out.replace(':id', ids.documentId || '');
    return out;
  };

  const results = [];
  for (const route of routes.sort((a, b) => a.path.localeCompare(b.path))) {
    const target = substitute(route.path);
    if (target.includes(':')) {
      results.push({ ...route, status: null, note: 'no id available' });
      continue;
    }
    if (target.includes('//')) {
      results.push({ ...route, status: null, note: 'no seeded record' });
      continue;
    }
    const res = await call(target, token);
    results.push({ ...route, target, status: res.status, message: res.body?.message });
  }

  /* 5. report */
  const width = Math.max(...results.map((x) => x.path.length)) + 2;
  for (const x of results) {
    const label = x.path.padEnd(width);
    if (x.status === null) console.log(`  ${dim(label)}${y('skip')}  ${dim(x.note)}`);
    else if (x.status >= 500 || x.status === 0)
      console.log(
        `  ${label}${r(x.status || 'ERR')}  ${r(String(x.message || '').slice(0, 90))}`,
      );
    else if (x.status >= 400)
      console.log(
        `  ${label}${y(x.status)}  ${dim(String(x.message || '').slice(0, 90))}`,
      );
    else console.log(`  ${label}${g(x.status)}`);
  }

  const broken = results.filter((x) => x.status >= 500 || x.status === 0);
  const refused = results.filter((x) => x.status >= 400 && x.status < 500);
  const ok = results.filter((x) => x.status >= 200 && x.status < 300);
  const skipped = results.filter((x) => x.status === null);

  console.log(
    `\n  ${g(ok.length + ' ok')}   ${refused.length ? y(refused.length + ' 4xx') : '0 4xx'}   ${broken.length ? r(broken.length + ' server errors') : g('0 server errors')}   ${dim(skipped.length + ' skipped')}\n`,
  );

  if (broken.length) {
    console.log(r('  Server errors — these are real bugs:'));
    broken.forEach((x) =>
      console.log(`    ${x.path}  ${dim(x.cls)}\n      ${x.message || 'no message'}`),
    );
    console.log();
  }
  process.exit(broken.length ? 1 : 0);
}

main().catch((e) => {
  console.error(r(`\n  ${e.stack}\n`));
  process.exit(1);
});
