// Test end-to-end di Pesi (Playwright, Chromium, viewport 360×780 mobile).
// Non fa parte dell'app: serve solo in sviluppo. Playwright non è una dipendenza del sito.
// Esecuzione:
//   npm i --prefix /tmp/pw playwright && npx --prefix /tmp/pw playwright install chromium
//   NODE_PATH=/tmp/pw/node_modules node tests/e2e.cjs [cartella-screenshot]
"use strict";
const { chromium } = require("playwright");
const http = require("http"), fs = require("fs"), path = require("path"), os = require("os");
const assert = require("assert/strict");

const ROOT = path.resolve(__dirname, "..");
const SHOTS = path.resolve(process.argv[2] || path.join(os.tmpdir(), "pesi-shots"));
fs.mkdirSync(SHOTS, { recursive: true });
const KEY = "pesi.v1";
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".webmanifest": "application/manifest+json", ".png": "image/png", ".json": "application/json" };

const server = http.createServer((req, res) => {
  let p = decodeURIComponent(new URL(req.url, "http://x").pathname); if(p.endsWith("/")) p += "index.html";
  const f = path.join(ROOT, p);
  if(!f.startsWith(ROOT) || !fs.existsSync(f)) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { "content-type": TYPES[path.extname(f)] || "application/octet-stream" }); fs.createReadStream(f).pipe(res);
});

/* ---------- dati di test ---------- */
const noonDaysAgo = n => { const d = new Date(); d.setHours(12, 0, 0, 0); d.setDate(d.getDate() - n); return d.toISOString(); };
const keyDaysAgo = n => { const d = new Date(); d.setDate(d.getDate() - n); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`; };
// scheda v1 = scheda attuale senza i campi nuovi, più un esercizio personalizzato non riconosciuto
function v1Program(prog){
  const p = JSON.parse(JSON.stringify(prog));
  for(const s of p.sessions) for(const ex of s.exercises){ delete ex.muscles; delete ex.rir; }
  p.sessions[1].exercises.push({ name: "Hip thrust", sets: 3, reps: "8-12", rest: 90, step: 5 });
  return p;
}
function workout(prog, sid, daysAgo, opts = {}){
  const s = prog.sessions.find(x => x.id === sid);
  return { id: "w" + sid + daysAgo, date: noonDaysAgo(daysAgo), started: noonDaysAgo(daysAgo).replace("T12:", "T11:"), sessionId: sid, name: s.name,
    exercises: s.exercises.map(ex => ({ name: ex.name, sets: Array.from({ length: ex.sets }, (_, i) => ({ kg: (ex.start ?? 20) + 0, reps: 8, done: true, ...(opts.rir ? { rir: i % 4 } : {}) })) })) };
}

let errors = [];
const results = [];
async function test(name, fn){
  try{ await fn(); results.push(["OK  ", name]); }
  catch(e){ results.push(["FAIL", name + "\n      " + (e.stack || e).toString().split("\n").slice(0, 3).join("\n      ")]); }
}

(async () => {
  await new Promise(r => server.listen(0, r));
  const URL0 = `http://localhost:${server.address().port}/`;
  const browser = await chromium.launch();
  const newPage = async (sw = "block") => {
    const ctx = await browser.newContext({ viewport: { width: 360, height: 780 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true,
      serviceWorkers: sw, locale: "it-IT", timezoneId: "Europe/Rome" });
    const page = await ctx.newPage();
    page.on("console", m => { if(m.type() === "error") errors.push(`${m.text()} @ ${page.url()}`); });
    page.on("pageerror", e => errors.push("pageerror: " + e.message));
    page.on("dialog", d => d.accept());
    await page.goto(URL0);
    return page;
  };
  const withDb = async (page, d) => { await page.evaluate(([k, v]) => { localStorage.clear(); localStorage.setItem(k, v); }, [KEY, JSON.stringify(d)]); await page.reload(); };
  const stored = page => page.evaluate(k => JSON.parse(localStorage.getItem(k)), KEY);
  const tab = (page, t) => page.click(`nav [data-tab="${t}"]`);

  const boot = await newPage();
  const DEF = await boot.evaluate(() => DEFAULT_PROGRAM);
  await boot.context().close();
  const PROG1 = v1Program(DEF);

  /* 1. Migrazione v1 → v2 */
  let v1db;
  await test("1. migrazione v1 → v2 (log e draft intatti, muscles presenti)", async () => {
    const log = [workout(PROG1, "UA", 9), workout(PROG1, "LA", 7), workout(PROG1, "UB", 5)];
    log[1].exercises.push({ name: "Hip thrust", sets: [{ kg: 60, reps: 10, done: true }] });
    const draft = { sessionId: "LB", name: "Lower B", started: noonDaysAgo(0),
      exercises: PROG1.sessions[3].exercises.map((ex, i) => ({ name: ex.name, sets: Array.from({ length: ex.sets }, (_, j) => ({ kg: 40, reps: i === 0 && j < 2 ? 7 : null, done: i === 0 && j < 2 })) })) };
    v1db = { version: 1, program: PROG1, log, draft };
    const page = await newPage();
    await withDb(page, v1db);
    const d = await stored(page);
    assert.equal(d.version, 2);
    assert.deepEqual(d.log, v1db.log, "log modificato");
    assert.deepEqual(d.draft, v1db.draft, "draft modificato");
    assert.deepEqual(d.bodyweight, []);
    const exs = d.program.sessions.flatMap(s => s.exercises);
    for(const ex of exs.filter(e => e.name !== "Hip thrust")){ assert.ok(ex.muscles && ex.muscles.direct.length, "muscles mancante: " + ex.name); assert.ok(ex.rir, "rir mancante: " + ex.name); }
    assert.equal(exs.find(e => e.name === "Hip thrust").muscles, undefined, "esercizio non riconosciuto mappato");
    assert.equal(exs.find(e => e.name === "Panca piana con bilanciere").rir, "1-2");
    assert.equal(exs.find(e => e.name === "Lat machine presa larga").rir, "0-1");
    assert.deepEqual(JSON.parse(await page.evaluate(k => localStorage.getItem(k + ".pre-v2"), KEY)), v1db, "copia pre-v2 assente");
    // idempotenza: rimigrare non cambia nulla, e una seconda apertura nemmeno
    assert.equal(await page.evaluate(() => JSON.stringify(migrate(JSON.parse(JSON.stringify(db)))) === JSON.stringify(db)), true);
    await page.reload(); assert.deepEqual(await stored(page), d);
    // il draft è ancora aperto in UI
    assert.equal(await page.textContent("#title"), "Lower B");
    assert.match(await page.textContent("#subtitle"), /^2\/\d+ serie/);
    await page.context().close();
  });

  /* 2. RIR: UI, persistenza, suggest() */
  await test("2a. flusso RIR: ✓ → chip → persistito dopo reload", async () => {
    const page = await newPage();
    await page.click("#start");
    const card = page.locator(".ex").first();
    await card.locator('.set[data-si="0"] [data-f="reps"]').fill("8");
    await card.locator('.set[data-si="0"] [data-act="done"]').click();
    assert.equal(await page.isVisible("#timer.show"), true, "timer non partito");
    assert.equal(await card.locator(".rirrow").count(), 1, "chip RIR non comparse");
    await card.locator('.rirrow [data-v="2"]').click();
    assert.equal(await card.locator(".rirrow").count(), 0, "chip non chiuse dopo la scelta");
    assert.equal(await card.locator('.set[data-si="0"] .n').textContent(), "1@2");
    // serie 2 spuntata senza scegliere RIR: resta null, nessun blocco
    await card.locator('.set[data-si="1"] [data-act="done"]').click();
    await card.locator('.set[data-si="2"] [data-act="done"]').click();
    assert.equal(await page.locator(".rirrow").count(), 1, "più file di chip aperte");
    await page.reload();
    let d = await stored(page);
    assert.equal(d.draft.exercises[0].sets[0].rir, 2);
    assert.equal(d.draft.exercises[0].sets[1].rir, null);
    assert.equal(await page.locator('.ex').first().locator('.set[data-si="0"] .n').textContent(), "1@2");
    // il numero serie riapre le chip per correggere; secondo tap sullo stesso valore lo toglie
    await page.locator('.ex').first().locator('.set[data-si="0"] .n').click();
    assert.equal(await page.locator('.rirrow .chip.on').textContent(), "2");
    await page.locator('.rirrow [data-v="3"]').click();
    d = await stored(page); assert.equal(d.draft.exercises[0].sets[0].rir, 3);
    // salva e controlla lo storico
    await page.click("#finish");
    await tab(page, "storico");
    await page.click(".hist-item summary");
    assert.match(await page.textContent(".hist-item .tbl"), /47,5×8 @3\+/);
    assert.match(await page.textContent(".hist-item .tbl"), /47,5×8(?! @)/);
    await page.context().close();
  });

  await test("2b. suggest(): i 4 casi RIR + fallback senza RIR", async () => {
    const page = await newPage();
    const panca = DEF.sessions[0].exercises[0]; // 4 × 5-8, step 2.5
    const run = async (reps, rir, prevReps) => {
      const mk = (r, rr, days) => ({ id: "x" + days, date: noonDaysAgo(days), sessionId: "UA", name: "Upper A",
        exercises: [{ name: panca.name, sets: r.map((n, i) => ({ kg: 50, reps: n, done: true, ...(rr ? { rir: rr[i] } : {}) })) }] });
      const log = (prevReps ? [mk(prevReps, null, 4)] : []).concat(mk(reps, rir, 2));
      await withDb(page, { version: 2, program: DEF, log, draft: null, bodyweight: [], lastBackup: new Date().toISOString() });
      return page.evaluate(() => suggest(db.program.sessions[0].exercises[0]));
    };
    let s = await run([8, 8, 8, 8], [3, 3, 3, 3]);
    assert.equal(s.kg, 55); assert.match(s.text, /era facile, salto doppio/);
    s = await run([8, 8, 8, 8], [1, 1, 2, 3]); // media 1,75
    assert.equal(s.kg, 52.5); assert.match(s.text, /range chiuso/); assert.doesNotMatch(s.text, /salto doppio/);
    s = await run([8, 7, 6, 4], [2, 1, 0, 0]);
    assert.equal(s.kg, 50); assert.match(s.text, /cedimento \(RIR 0\)/);
    s = await run([8, 7, 6, 4], [2, 1, 0, 0], [8, 6, 5, 4]); // due volte sotto: la regola esistente resta
    assert.equal(s.kg, 47.5); assert.match(s.text, /Due volte sotto 5/);
    s = await run([7, 7, 6, 6], [3, 3, 3, 3]);
    assert.equal(s.kg, 50); assert.match(s.text, /spingi di più: eri lontano dal cedimento/);
    s = await run([8, 8, 8, 8], null); // nessun RIR: logica di prima
    assert.equal(s.kg, 52.5); assert.match(s.text, /range chiuso/);
    s = await run([7, 7, 6, 6], null);
    assert.equal(s.kg, 50); assert.match(s.text, /\+1 rip\./);
    // la stessa frase arriva in UI
    await run([8, 8, 8, 8], [3, 3, 3, 3]);
    await page.click('[data-pick="UA"]'); // in coda c'è Lower A
    assert.match(await page.textContent("#view"), /salto doppio\. Sali a 55 kg/);
    await page.context().close();
  });

  /* 3. Volume */
  let volDb;
  await test("3. volume settimanale su 4 settimane (3 sedute/sett. in rotazione)", async () => {
    const order = ["UA", "LA", "UB", "LB"], days = [27, 25, 23, 20, 18, 16, 13, 11, 9, 6, 4, 2];
    const log = days.map((n, i) => workout(DEF, order[i % 4], n, { rir: true }));
    log[5].exercises.push({ name: "Hip thrust", sets: [1, 2, 3].map(() => ({ kg: 60, reps: 10, done: true })) });
    volDb = { version: 2, program: DEF, log, draft: null, bodyweight: [], lastBackup: noonDaysAgo(20) };
    const page = await newPage();
    await withDb(page, volDb);
    const v = await page.evaluate(() => weeklyVolume());
    const w = Object.fromEntries(v.rows.map(r => [r.m, r]));
    assert.equal(v.spanDays, 28); assert.equal(v.estimate, false);
    assert.equal(w["petto"].week, 10.5);
    assert.equal(w["dorso"].week, 10.5);
    assert.equal(w["deltoide laterale"].week, 5.625); // 4,5 diretti (alzate) + 1,125 indiretti (lento avanti)
    assert.equal(w["quadricipiti"].week, 9.75);
    assert.equal(w["femorali"].week, 10.5);
    assert.equal(w["glutei"].week, 6.375);
    assert.equal(v.unmappedWeek, 0.75);
    // ultimi 7 giorni: sedute a -6 (LA), -4 (UB), -2 (LB)
    assert.equal(w["petto"].d7, 7); assert.equal(w["dorso"].d7, 7); assert.equal(w["deltoide laterale"].d7, 3);
    await tab(page, "esercizi");
    const vals = await page.$$eval(".vol[data-muscle]:not([data-muscle='non mappati']) .vw", els => els.map(e => parseFloat(e.textContent.replace(",", "."))));
    assert.deepEqual(vals, vals.slice().sort((a, b) => a - b), "non ordinato dal più basso");
    assert.match(await page.textContent('.vol[data-muscle="petto"]'), /10,5.*7 gg 7.*ok/s);
    assert.match(await page.textContent('.vol[data-muscle="deltoide laterale"]'), /5,6.*basso/s);
    assert.match(await page.textContent('.vol[data-muscle="non mappati"]'), /0,8.*Hip thrust/s);
    assert.doesNotMatch(await page.textContent("#view"), /Stima/);
    // meno di 14 giorni: stima normalizzata sui giorni effettivi (10 giorni → ×0,7)
    await withDb(page, { ...volDb, log: log.filter(x => new Date(x.date) > new Date(noonDaysAgo(10))) });
    const e = await page.evaluate(() => weeklyVolume());
    assert.equal(e.estimate, true); assert.equal(e.spanDays, 10);
    await tab(page, "esercizi");
    assert.match(await page.textContent("#view"), /Stima: serie a settimana su 10 giorni/);
    await page.context().close();
  });

  /* 4. Peso corporeo */
  await test("4. peso corporeo: sovrascrittura giornaliera, media e variazione", async () => {
    const bw = [];
    for(let n = 13; n >= 7; n--) bw.push({ date: keyDaysAgo(n), kg: 80 });
    for(let n = 6; n >= 1; n--) bw.push({ date: keyDaysAgo(n), kg: 79 });
    const page = await newPage();
    await withDb(page, { version: 2, program: DEF, log: [], draft: null, bodyweight: bw });
    await tab(page, "esercizi");
    await page.fill("#bwIn", "78,5"); await page.click("#bwSave");
    await page.fill("#bwIn", "78"); await page.press("#bwIn", "Enter");
    let d = await stored(page);
    assert.equal(d.bodyweight.length, 14);
    assert.deepEqual(d.bodyweight.filter(b => b.date === keyDaysAgo(0)), [{ date: keyDaysAgo(0), kg: 78 }]);
    // media 7 gg = (6×79 + 78)/7 = 78,857 ; precedente 80 → −1,14 kg, −1,43 %
    assert.equal(await page.textContent("#bwAvg"), "78,9 kg");
    assert.equal((await page.textContent("#bwDiff")).replace(/\s+/g, " "), "−1,1 kg (−1,4%)");
    const st = await page.evaluate(() => bwStats());
    assert.ok(Math.abs(st.cur - 552 / 7) < 1e-9 && Math.abs(st.diff - (552 / 7 - 80)) < 1e-9);
    assert.equal(await page.locator(".spark path").count(), 2);
    await page.click(".bwlist summary");
    await page.click(`[data-bwdel="${keyDaysAgo(0)}"]`);
    d = await stored(page);
    assert.equal(d.bodyweight.length, 13); assert.ok(!d.bodyweight.some(b => b.date === keyDaysAgo(0)));
    await page.fill("#bwIn", "abc"); await page.click("#bwSave");
    assert.equal((await stored(page)).bodyweight.length, 13);
    await page.context().close();
  });

  /* 5. Import backup v1 */
  await test("5. import di un backup v1 → migrato", async () => {
    const file = path.join(os.tmpdir(), "pesi-backup-v1-test.json");
    fs.writeFileSync(file, JSON.stringify(v1db, null, 2));
    const page = await newPage();
    await tab(page, "impostazioni");
    await page.setInputFiles("#impFile", file);
    await page.waitForFunction(k => JSON.parse(localStorage.getItem(k) || "{}").log?.length === 3, KEY);
    const d = await stored(page);
    assert.equal(d.version, 2);
    assert.deepEqual(d.log, v1db.log); assert.deepEqual(d.draft, v1db.draft); assert.deepEqual(d.bodyweight, []);
    assert.deepEqual(d.program.sessions[0].exercises[0].muscles, { direct: ["petto"], indirect: ["tricipiti", "deltoide anteriore"] });
    assert.equal(d.program.sessions[1].exercises.find(e => e.name === "Hip thrust").muscles, undefined);
    await page.context().close();
  });

  /* 6. Screenshot di ogni tab a 360 px, banner backup, target touch, niente scroll orizzontale */
  await test("6. screenshot 360px, banner backup, target ≥ 44px, nessun overflow", async () => {
    const page = await newPage("allow"); // con service worker attivo, come sul telefono
    const bw = []; for(let n = 20; n >= 0; n--) if(n % 3 !== 1) bw.push({ date: keyDaysAgo(n), kg: Math.round((80.4 - n * 0.06 + (n % 4) * 0.25) * 10) / 10 });
    await withDb(page, { ...volDb, bodyweight: bw });
    const noHScroll = async label => assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= 360), "scroll orizzontale: " + label);
    const shot = async name => { await page.screenshot({ path: path.join(SHOTS, name + ".png"), fullPage: true }); await noHScroll(name); };
    assert.match(await page.textContent(".bkban"), /Backup non fatto da 20 giorni/);
    await shot("1-allenamento");
    await page.click("#start");
    const card = page.locator(".ex").first();
    await card.locator('.set[data-si="0"] [data-f="reps"]').fill("8");
    await card.locator('.set[data-si="0"] [data-act="done"]').click();
    await card.locator('.rirrow [data-v="1"]').click();
    await card.locator('.set[data-si="1"] [data-f="reps"]').fill("7");
    await card.locator('.set[data-si="1"] [data-act="done"]').click();
    await page.click("#tStop");
    await page.screenshot({ path: path.join(SHOTS, "2-allenamento-in-corso.png") }); await noHScroll("in corso");
    for(const sel of [".rirrow .chip", ".set .n", ".set .check"]){
      const hs = await page.$$eval(sel, els => els.map(e => { const r = e.getBoundingClientRect(); return [r.width, r.height]; }));
      assert.ok(hs.length && hs.every(([w, h]) => w >= 44 && h >= 44), `${sel} sotto 44px: ${JSON.stringify(hs[0])}`);
    }
    await tab(page, "storico"); await page.click(".hist-item summary"); await shot("3-storico");
    await tab(page, "esercizi"); await shot("4-progressi");
    for(const sel of ["#bwSave", "#bwIn"]){ const b = await page.locator(sel).boundingBox(); assert.ok(b.height >= 44, sel); }
    await tab(page, "impostazioni"); await shot("5-scheda");
    // export dal banner: il banner sparisce e lastBackup è aggiornato
    await tab(page, "oggi"); await page.click("#cancel");
    const [dl] = await Promise.all([page.waitForEvent("download"), page.click("[data-backup]")]);
    assert.match(dl.suggestedFilename(), /^pesi-backup-\d{4}-\d\d-\d\d\.json$/);
    assert.equal(await page.locator(".bkban").count(), 0);
    assert.ok(Date.now() - new Date((await stored(page)).lastBackup) < 60000);
    // log vuoto → nessun banner
    await withDb(page, { version: 2, program: DEF, log: [], draft: null, bodyweight: [] });
    assert.equal(await page.locator(".bkban").count(), 0);
    await shot("6-allenamento-vuoto");
    await tab(page, "esercizi"); await shot("7-progressi-vuoto");
    await page.context().close();
  });

  await test("6b. nessun errore in console", async () => { assert.deepEqual(errors, []); });

  await browser.close(); server.close();
  for(const [s, n] of results) console.log(s, n);
  console.log("screenshot in", SHOTS);
  process.exit(results.some(r => r[0] === "FAIL") ? 1 : 0);
})();
