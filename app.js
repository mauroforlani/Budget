/* =========================================================================
   app.js — logica applicativa "Le Tue Finanze"
   I dati (SEED_DATA) vivono in data.js. La sincronizzazione con GitHub vive
   in github-sync.js. Questo file contiene solo rendering e regole di business.
   ========================================================================= */

/* ---------------- HELPERS ---------------- */
const eur = n => (n < 0 ? "-" : "") + "€ " + Math.abs(n).toLocaleString("it-IT", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
function eurCompact(n) {
  const sign = n < 0 ? "-" : "";
  const abs = Math.abs(n);
  let s;
  if (abs >= 1000000) s = (abs / 1000000).toLocaleString('it-IT', { maximumFractionDigits: 1, minimumFractionDigits: 0 }) + 'M';
  else if (abs >= 1000) s = (abs / 1000).toLocaleString('it-IT', { maximumFractionDigits: 1, minimumFractionDigits: 0 }) + 'k';
  else s = abs.toLocaleString('it-IT', { maximumFractionDigits: 0 });
  return sign + '€' + s;
}
const pct = n => (n * 100).toFixed(1) + "%";
const MESI_IT = ['Gennaio', 'Febbraio', 'Marzo', 'Aprile', 'Maggio', 'Giugno', 'Luglio', 'Agosto', 'Settembre', 'Ottobre', 'Novembre', 'Dicembre'];

function sum(arr) { return arr.reduce((a, b) => a + b, 0); }
function fmtData(iso) { const [y, m, d] = iso.split("-"); return `${d}/${m}/${y.slice(2)}`; }

/* ---------------- STATO ---------------- */
let DATA = JSON.parse(JSON.stringify(SEED_DATA));
let transazioni = (DATA.transazioni2026 || []).map(t => ({ ...t }));
let ANNI = [];
let ANNI_CON_CATEGORIE = new Set();
const ANNO_CORRENTE = 2026;

function refreshDerivedConstants() {
  ANNI = DATA.meta.anniFlussi.map(Number).sort((a, b) => a - b);
  ANNI_CON_CATEGORIE = new Set(Object.keys(DATA.entrateCategorie['TOTALE'] || {}).map(Number));
}

function patrimonioTotale() {
  return DATA.patrimonio.reduce((s, p) => s + (p.liquidita || 0) + (p.azioni || 0) + (p.obbligazioni || 0) + (p.deposito || 0), 0);
}

/* ---------------- RICALCOLO ANNO CORRENTE DA TRANSAZIONI ----------------
   Ogni modifica alle transazioni (nuova, cancellazione, importazione) deve
   propagarsi a flussi mensili e categorie del 2026, così tutte le altre
   sezioni (dashboard, budget, per voce) restano coerenti con i dati reali. */
function recomputeAnno2026() {
  const entMonth = Array(12).fill(0);
  const usMonth = Array(12).fill(0);
  const entCatMonth = Array.from({ length: 12 }, () => ({}));
  const usCatMonth = Array.from({ length: 12 }, () => ({}));
  const entCatYear = {};
  const usCatYear = {};

  transazioni.forEach(t => {
    const m = parseInt(t.data.slice(5, 7), 10) - 1;
    if (m < 0 || m > 11) return;
    if (t.importo >= 0) {
      entMonth[m] += t.importo;
      entCatMonth[m][t.cat] = (entCatMonth[m][t.cat] || 0) + t.importo;
      entCatYear[t.cat] = (entCatYear[t.cat] || 0) + t.importo;
    } else {
      const v = -t.importo;
      usMonth[m] += v;
      usCatMonth[m][t.cat] = (usCatMonth[m][t.cat] || 0) + v;
      usCatYear[t.cat] = (usCatYear[t.cat] || 0) + v;
    }
  });

  DATA.flussi[ANNO_CORRENTE] = { entrate: entMonth, uscite: usMonth };

  Object.keys(DATA.entrateCategorie).forEach(cat => {
    if (cat === 'TOTALE') return;
    DATA.entrateCategorie[cat][ANNO_CORRENTE] = entCatYear[cat] || 0;
  });
  Object.keys(DATA.usciteCategorie).forEach(cat => {
    if (cat === 'TOTALE') return;
    DATA.usciteCategorie[cat][ANNO_CORRENTE] = usCatYear[cat] || 0;
  });
  // categorie apparse solo nelle nuove transazioni (non presenti nei dizionari storici)
  Object.keys(entCatYear).forEach(cat => {
    if (!(cat in DATA.entrateCategorie)) DATA.entrateCategorie[cat] = {};
    DATA.entrateCategorie[cat][ANNO_CORRENTE] = entCatYear[cat];
  });
  Object.keys(usCatYear).forEach(cat => {
    if (!(cat in DATA.usciteCategorie)) DATA.usciteCategorie[cat] = {};
    DATA.usciteCategorie[cat][ANNO_CORRENTE] = usCatYear[cat];
  });

  if (DATA.entrateCategorie['TOTALE']) DATA.entrateCategorie['TOTALE'][ANNO_CORRENTE] = sum(entMonth);
  if (DATA.usciteCategorie['TOTALE']) DATA.usciteCategorie['TOTALE'][ANNO_CORRENTE] = sum(usMonth);

  DATA._monthlyCat2026 = { entrate: entCatMonth, uscite: usCatMonth };

  const mesiConDati = [];
  for (let m = 0; m < 12; m++) { if (entMonth[m] !== 0 || usMonth[m] !== 0) mesiConDati.push(MESI_IT[m]); }
  DATA.meta.mesiTransazioniDettagliate = mesiConDati;
  DATA.meta.mesiSenzaDati2026 = MESI_IT.filter(m => !mesiConDati.includes(m));

  refreshDerivedConstants();
}

/* ---------------- PERSISTENZA SU GITHUB ---------------- */
function buildExportData() {
  const clone = JSON.parse(JSON.stringify(DATA));
  delete clone._monthlyCat2026;
  clone.transazioni2026 = transazioni.map(t => ({ ...t }));
  return clone;
}
let persistTimer = null;
function persist(message) {
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    GitHubSync.saveData(buildExportData(), message || 'Aggiornamento dati finanze');
  }, 600);
}

/* ---------------- HEADER ---------------- */
function renderHeader() {
  document.getElementById('hdr-patrimonio').textContent = eur(patrimonioTotale());
  const spark = document.getElementById('hdr-spark');
  const totali = ANNI.map(y => sum(DATA.flussi[y].entrate) - sum(DATA.flussi[y].uscite));
  const max = Math.max(...totali.map(Math.abs), 1);
  spark.innerHTML = totali.map(v => {
    const h = Math.max(2, Math.abs(v) / max * 32);
    const color = v >= 0 ? 'var(--accent)' : 'var(--red)';
    return `<div class="bar" style="height:${h}px; background:${color};"></div>`;
  }).join("");
}

/* ---------------- DASHBOARD ---------------- */
function renderDataBanner() {
  const mesiConDati = DATA.meta.mesiTransazioniDettagliate.join(", ") || "nessuno";
  document.getElementById('data-banner').innerHTML =
    `<b>Copertura dati:</b> flussi annuali ${ANNI[0]}&ndash;${ANNI[ANNI.length - 1] - 1}, dettaglio per categoria dal ${Math.min(...ANNI_CON_CATEGORIE)}, transazioni analitiche ${ANNO_CORRENTE}: ${mesiConDati}.`;
}

function renderDashboard() {
  const f = DATA.flussi[ANNO_CORRENTE];
  const entrateYTD = sum(f.entrate);
  const usciteYTD = sum(f.uscite);
  const saldoYTD = entrateYTD - usciteYTD;

  document.getElementById('dash-cards').innerHTML = `
    <div class="card"><div class="label">Entrate ${ANNO_CORRENTE} (YTD)</div><div class="value pos">${eur(entrateYTD)}</div></div>
    <div class="card"><div class="label">Uscite ${ANNO_CORRENTE} (YTD)</div><div class="value neg">${eur(usciteYTD)}</div></div>
    <div class="card"><div class="label">Saldo ${ANNO_CORRENTE} (YTD)</div><div class="value ${saldoYTD >= 0 ? 'pos' : 'neg'}">${eur(saldoYTD)}</div></div>
    <div class="card"><div class="label">Patrimonio totale</div><div class="value">${eur(patrimonioTotale())}</div><div class="sub">Vedi tab Patrimonio</div></div>
  `;

  document.getElementById('chart-sub').textContent = `Totali annuali, ${ANNI[0]}\u2013${ANNI[ANNI.length - 1]}.`;

  renderDashChart();
  renderDashboardRecent();
}

function annoAdjEntrate(y, escludiTitoli, escludiProgetti) {
  let v = sum(DATA.flussi[y].entrate);
  if (!ANNI_CON_CATEGORIE.has(y)) return v;
  if (escludiTitoli) v -= (DATA.entrateCategorie['Vendita Titoli']?.[y] || 0);
  if (escludiProgetti) v -= (DATA.entrateCategorie['Progetto']?.[y] || 0);
  return v;
}
function annoAdjUscite(y, escludiTitoli, escludiProgetti) {
  let v = sum(DATA.flussi[y].uscite);
  if (!ANNI_CON_CATEGORIE.has(y)) return v;
  if (escludiTitoli) v -= (DATA.usciteCategorie['Acquisto Titoli']?.[y] || 0);
  if (escludiProgetti) v -= (DATA.usciteCategorie['Progetto']?.[y] || 0);
  return v;
}

function renderDashChart() {
  const escludiTitoli = !document.getElementById('flag-titoli').checked;
  const escludiProgetti = !document.getElementById('flag-progetti').checked;

  const yearTotals = ANNI.map(y => ({
    y,
    e: annoAdjEntrate(y, escludiTitoli, escludiProgetti),
    u: annoAdjUscite(y, escludiTitoli, escludiProgetti),
    stimato: !ANNI_CON_CATEGORIE.has(y) && (escludiTitoli || escludiProgetti)
  }));
  const maxVal = Math.max(...yearTotals.map(d => Math.max(d.e, d.u)), 1);
  const PXMAX = 190;
  document.getElementById('dash-chart').innerHTML = `<div class="colchart">` + yearTotals.map(d => {
    const he = Math.max(2, d.e / maxVal * PXMAX);
    const hu = Math.max(2, d.u / maxVal * PXMAX);
    return `<div class="colgroup">
      <div class="bars">
        <div class="col e" style="height:${he}px;" title="Entrate ${d.y}: ${eur(d.e)}"><span class="tip">${eurCompact(d.e)}</span></div>
        <div class="col u" style="height:${hu}px;" title="Uscite ${d.y}: ${eur(d.u)}"><span class="tip">${eurCompact(d.u)}</span></div>
      </div>
      <div class="yr">${d.y}${d.stimato ? '*' : ''}</div>
    </div>`;
  }).join("") + `</div>`;

  const noteBits = [];
  if (escludiTitoli) noteBits.push('gestione titoli esclusa (Acquisto/Vendita Titoli)');
  if (escludiProgetti) noteBits.push('gestione progetti esclusa (Progetto)');
  const primoAnnoCat = Math.min(...ANNI_CON_CATEGORIE);
  let note = noteBits.length ? noteBits.join(' &middot; ') : 'valori totali, nessuna esclusione applicata.';
  if (escludiTitoli || escludiProgetti) {
    note += ` Il dettaglio per categoria &egrave; disponibile dal ${primoAnnoCat}: gli anni precedenti (contrassegnati con *) mostrano comunque il totale completo.`;
  }
  document.getElementById('chart-note').innerHTML = note;
}

function renderDashboardRecent() {
  const recent = [...transazioni].sort((a, b) => b.data.localeCompare(a.data)).slice(0, 8);
  document.getElementById('dash-recent').querySelector('tbody').innerHTML = recent.map(t => `
    <tr>
      <td>${fmtData(t.data)}</td>
      <td>${t.desc}</td>
      <td><span class="tag">${t.cat}</span></td>
      <td class="num ${t.importo < 0 ? 'neg' : 'pos'}">${eur(t.importo)}</td>
    </tr>
  `).join("") || `<tr><td colspan="4" style="color:var(--ink-soft); padding:18px;">Nessuna registrazione presente.</td></tr>`;
}

/* ---------------- IMPORTA ---------------- */
const REGOLE_USCITE = [
  [/ALDI|ESSELUNGA|CARREFOUR|CONAD|COOP\b|\bPAM\b|LIDL|EUROSPIN|IPERAL|BENNET|IPERSTAR/i, 'Casa - Spesa'],
  [/FASTWEB/i, 'Casa - Internet'],
  [/\bA2A\b/i, 'Casa - A2A'],
  [/\bENI\d*|Q8|TAMOIL|\bAGIP\b|\bIP\b.*CARBURANT|SIA FUEL|STAZIONE DI SERVIZIO/i, 'Rifornimento'],
  [/PRELIEVO BANCOMAT|PRELEVAMENTO|ATM \d|PRELIEVO CONTANTI/i, 'Prelievi'],
  [/COMPRAVENDITA TITOLI|ACQUISTO TITOLI/i, 'Acquisto Titoli'],
  [/BOLLO DOSSIER TITOLI|TOBIN TAX|IMPOSTA DI BOLLO|CANONE DEL CONTO|C\/C T\d/i, 'Imposte/Tasse'],
  [/TELEPASS|UNIPOLTECH|UNIPOLMOVE/i, 'Telepass'],
  [/AUTOSTRADA|PEDAGGIO/i, 'Viaggi'],
  [/\bTAXI\b|UBER|FREE ?NOW/i, 'Taxi'],
  [/HOTEL|BOOKING\.COM|AIRBNB|RIFUGIO/i, 'Hotel'],
  [/RISTORANTE|TRATTORIA|OSTERIA|PIZZ|\bBAR\b|COFFEE|CAFF[EÈ]|GELATER|PANIFICIO|FORNO DELLA|MC ?DONALD|BURGER/i, 'Pranzi/Cene'],
  [/FARMACIA/i, 'Casa - Altro'],
  [/SIBRA|TRENITALIA|TRENORD|\bATM MILANO\b|BUS\b/i, 'Viaggi'],
  [/SPESE CARTA DI CREDITO ESTRATTO|UTILIZZO CARTA DI CREDITO/i, '__TRASFERIMENTO_CARTA__'],
  [/AMAZON/i, 'Hobby'],
];
const REGOLE_ENTRATE = [
  [/STIPENDIO|RETRIBUZIONE/i, 'Stipendio'],
  [/COMPRAVENDITA TITOLI|VENDITA TITOLI/i, 'Vendita Titoli'],
  [/INTERESS|CEDOLA/i, 'Interessi/Cedole'],
  [/DIVIDEND/i, 'Dividendi'],
  [/RIMBORSO/i, 'Rimborsi Lavorativi'],
];

function suggerisciCategoria(desc, importo) {
  const d = desc.toUpperCase();
  const regole = importo < 0 ? REGOLE_USCITE : REGOLE_ENTRATE;
  for (const [re, cat] of regole) { if (re.test(d)) return cat; }
  return 'Altro';
}

function trovaRigaIntestazione(rows, keywords) {
  for (let i = 0; i < rows.length; i++) {
    const row = (rows[i] || []).map(v => (v == null ? '' : String(v)).trim());
    if (keywords.every(k => row.includes(k))) return i;
  }
  return -1;
}

function parseFoglioMovimenti(rows) {
  let hIdx = trovaRigaIntestazione(rows, ['Data operazione', 'Tipologia', 'Causale', 'Entrate', 'Uscite']);
  if (hIdx >= 0) {
    const out = [];
    for (let r = hIdx + 1; r < rows.length; r++) {
      const row = rows[r];
      if (!row || row[0] == null) continue;
      const data = excelDateToISO(row[0]);
      if (!data) continue;
      const causale = row[2] != null ? String(row[2]).trim() : '';
      const entrate = numOrNull(row[4]);
      const uscite = numOrNull(row[5]);
      const importo = entrate != null ? entrate : -(uscite || 0);
      out.push({ data, desc: causale || String(row[1] || ''), importo, fonte: 'Illimity' });
    }
    return out;
  }
  hIdx = trovaRigaIntestazione(rows, ['Data_Operazione', 'Entrate', 'Uscite', 'Descrizione']);
  if (hIdx >= 0) {
    const out = [];
    for (let r = hIdx + 1; r < rows.length; r++) {
      const row = rows[r];
      if (!row || row[0] == null) continue;
      const data = excelDateToISO(row[0]);
      if (!data) continue;
      const entrate = numOrNull(row[2]);
      const uscite = numOrNull(row[3]);
      const importo = entrate != null ? entrate : (uscite || 0);
      const desc = row[4] != null ? String(row[4]).trim() : '';
      out.push({ data, desc, importo, fonte: 'Fineco' });
    }
    return out;
  }
  hIdx = trovaRigaIntestazione(rows, ['Intestatario carta', 'Numero carta', 'Descrizione', 'Importo']);
  if (hIdx >= 0) {
    const out = [];
    for (let r = hIdx + 1; r < rows.length; r++) {
      const row = rows[r];
      if (!row || row[2] == null) continue;
      const data = excelDateToISO(row[2]);
      if (!data) continue;
      const desc = row[4] != null ? String(row[4]).trim() : '';
      const importo = numOrNull(row[9]) || 0;
      out.push({ data, desc, importo, fonte: 'Fineco Carta' });
    }
    return out;
  }
  return null;
}

function numOrNull(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : parseFloat(String(v).replace(/\./g, '').replace(',', '.'));
  return isNaN(n) ? null : n;
}
function excelDateToISO(v) {
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'number') {
    const d = new Date(Math.round((v - 25569) * 86400 * 1000));
    return d.toISOString().slice(0, 10);
  }
  if (typeof v === 'string') {
    const m = v.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
    if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  }
  return null;
}

let stagingImport = [];

function esisteGiaTransazione(t) {
  return transazioni.some(x => x.data === t.data && x.importo === t.importo && x.desc.trim().toUpperCase() === t.desc.trim().toUpperCase());
}

async function handleImportFiles(fileList) {
  const statusEl = document.getElementById('import-status');
  statusEl.innerHTML = '';
  stagingImport = [];
  for (const file of fileList) {
    try {
      const buf = await file.arrayBuffer();
      const wb = XLSX.read(buf, { type: 'array', cellDates: true });
      let parsed = null;
      for (const sheetName of wb.SheetNames) {
        const rows = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { header: 1, raw: true });
        parsed = parseFoglioMovimenti(rows);
        if (parsed && parsed.length) break;
      }
      if (!parsed) {
        statusEl.innerHTML += `<div class="file-err">✕ ${file.name}: formato non riconosciuto, file ignorato.</div>`;
        continue;
      }
      parsed.forEach(t => t.fileName = file.name);
      stagingImport.push(...parsed);
      statusEl.innerHTML += `<div class="file-ok">✓ ${file.name}: ${parsed.length} movimenti trovati.</div>`;
    } catch (err) {
      statusEl.innerHTML += `<div class="file-err">✕ ${file.name}: errore di lettura (${err.message}).</div>`;
    }
  }
  renderImportReview();
}

function renderImportReview() {
  const panel = document.getElementById('import-review');
  if (!stagingImport.length) { panel.style.display = 'none'; return; }
  panel.style.display = 'block';

  stagingImport.sort((a, b) => b.data.localeCompare(a.data));
  const nuovi = stagingImport.filter(t => !esisteGiaTransazione(t)).length;
  document.getElementById('import-count').textContent = `${stagingImport.length} movimenti totali · ${nuovi} nuovi · ${stagingImport.length - nuovi} già presenti`;

  const catList = [...new Set([
    ...Object.keys(DATA.usciteCategorie).filter(c => c !== 'TOTALE'),
    ...Object.keys(DATA.entrateCategorie).filter(c => c !== 'TOTALE'),
  ])].sort();

  document.getElementById('import-table').querySelector('tbody').innerHTML = stagingImport.map((t, i) => {
    const dup = esisteGiaTransazione(t);
    let suggerita = suggerisciCategoria(t.desc, t.importo);
    const isTransfer = suggerita === '__TRASFERIMENTO_CARTA__';
    if (isTransfer) suggerita = 'Altro';
    const options = catList.map(c => `<option value="${c}" ${c === suggerita ? 'selected' : ''}>${c}</option>`).join("");
    return `<tr data-idx="${i}">
      <td><input type="checkbox" class="import-check" data-idx="${i}" ${dup ? '' : 'checked'}></td>
      <td>${fmtData(t.data)}</td>
      <td>${t.desc}${dup ? '<span class="dup-badge">già presente</span>' : ''}${isTransfer ? '<span class="dup-badge">trasferimento carta &ndash; verifica</span>' : ''}</td>
      <td class="num ${t.importo < 0 ? 'neg' : 'pos'}">${eur(t.importo)}</td>
      <td><span class="tag">${t.fonte}</span></td>
      <td><select class="cat-select" data-idx="${i}">${options}</select></td>
    </tr>`;
  }).join("");
}

/* ---------------- DETTAGLIO PER VOCE (2 grafici distinti) ---------------- */
function populateVoceCats() {
  const catsE = Object.keys(DATA.entrateCategorie).filter(c => c !== 'TOTALE').sort();
  const catsU = Object.keys(DATA.usciteCategorie).filter(c => c !== 'TOTALE').sort();
  const selE = document.getElementById('voce-cat-entrate');
  const selU = document.getElementById('voce-cat-uscite');
  const prevE = selE.value, prevU = selU.value;
  selE.innerHTML = catsE.map(c => `<option value="${c}">${c}</option>`).join("");
  selU.innerHTML = catsU.map(c => `<option value="${c}">${c}</option>`).join("");
  if (catsE.includes(prevE)) selE.value = prevE;
  if (catsU.includes(prevU)) selU.value = prevU;
}

function renderVoceBlock(tipo) {
  const suffix = tipo === 'entrate' ? 'entrate' : 'uscite';
  const dict = (tipo === 'entrate' ? DATA.entrateCategorie : DATA.usciteCategorie);
  const cat = document.getElementById('voce-cat-' + suffix).value;
  const catDict = dict[cat] || {};
  const anniCat = Object.keys(catDict).map(Number).sort((a, b) => a - b);
  const vals = anniCat.map(y => catDict[y]);
  const maxVal = Math.max(...vals.map(Math.abs), 1);

  const PXMAX_V = 190;
  document.getElementById('voce-chart-' + suffix).innerHTML = `<div class="colchart">` + anniCat.map((y, i) => {
    const v = vals[i];
    const h = Math.max(2, Math.abs(v) / maxVal * PXMAX_V);
    const negClass = v < 0 ? ' neg-cat' : '';
    return `<div class="colgroup">
      <div class="bars">
        <div class="col single${negClass}" style="height:${h}px;" title="${y}: ${eur(v)}"><span class="tip">${eurCompact(v)}</span></div>
      </div>
      <div class="yr">${y}${y === ANNO_CORRENTE ? '*' : ''}</div>
    </div>`;
  }).join("") + `</div>`;

  document.getElementById('voce-table-' + suffix).querySelector('tbody').innerHTML = anniCat.map((y, i) => {
    const v = vals[i];
    const isPartial = (y === ANNO_CORRENTE);
    const mesiDivisor = isPartial ? Math.max(DATA.meta.mesiTransazioniDettagliate.length, 1) : 12;
    const media = v / mesiDivisor;
    const prev = i > 0 ? vals[i - 1] : null;
    const delta = prev !== null ? v - prev : null;
    return `<tr>
      <td>${y}${isPartial ? ' <span class="tag">parziale</span>' : ''}</td>
      <td class="num">${eur(v)}</td>
      <td class="num">${eur(media)}</td>
      <td class="num ${delta === null ? '' : (delta <= 0 ? 'pos' : 'neg')}">${delta === null ? '—' : eur(delta)}</td>
    </tr>`;
  }).join("");
}

function renderVoceAll() {
  renderVoceBlock('entrate');
  renderVoceBlock('uscite');
}

/* ---------------- TRANSAZIONI ---------------- */
function populateFilters() {
  const mesi = [...new Set(transazioni.map(t => t.data.slice(0, 7)))].sort();
  const fm = document.getElementById('filter-mese');
  const prevMese = fm.value;
  fm.innerHTML = '<option value="">Tutti i mesi</option>' + mesi.map(m => {
    const idx = parseInt(m.slice(5, 7), 10) - 1;
    const anno = m.slice(0, 4);
    return `<option value="${m}">${MESI_IT[idx]} ${anno}</option>`;
  }).join("");
  if (mesi.includes(prevMese)) fm.value = prevMese;

  const catSet = [...new Set(transazioni.map(t => t.cat))].sort();
  const fc = document.getElementById('filter-cat');
  const prevCat = fc.value;
  fc.innerHTML = '<option value="">Tutte le categorie</option>' + catSet.map(c => `<option value="${c}">${c}</option>`).join("");
  if (catSet.includes(prevCat)) fc.value = prevCat;

  const sc = document.getElementById('f-cat');
  const allCats = [...new Set([
    ...Object.keys(DATA.usciteCategorie).filter(c => c !== 'TOTALE'),
    ...Object.keys(DATA.entrateCategorie).filter(c => c !== 'TOTALE'),
  ])].sort();
  sc.innerHTML = allCats.map(c => `<option value="${c}">${c}</option>`).join("");
}

function renderTransazioni() {
  const mese = document.getElementById('filter-mese').value;
  const cat = document.getElementById('filter-cat').value;
  const da = document.getElementById('filter-da').value;
  const a = document.getElementById('filter-a').value;
  let rows = [...transazioni];
  if (da) rows = rows.filter(t => t.data >= da);
  if (a) rows = rows.filter(t => t.data <= a);
  if (!da && !a && mese) rows = rows.filter(t => t.data.startsWith(mese));
  if (cat) rows = rows.filter(t => t.cat === cat);
  rows.sort((a, b) => b.data.localeCompare(a.data));

  document.getElementById('tx-table').querySelector('tbody').innerHTML = rows.map(t => `
    <tr>
      <td>${fmtData(t.data)}</td>
      <td>${t.desc}</td>
      <td><span class="tag">${t.cat}</span></td>
      <td class="num ${t.importo < 0 ? 'neg' : 'pos'}">${eur(t.importo)}</td>
      <td><button class="rowbtn" onclick="deleteTx('${t.data}','${t.desc.replace(/'/g, "\\'")}')">elimina</button></td>
    </tr>
  `).join("") || `<tr><td colspan="5" style="color:var(--ink-soft); padding:18px;">Nessuna registrazione trovata per questo filtro.</td></tr>`;
}

function deleteTx(data, desc) {
  transazioni = transazioni.filter(t => !(t.data === data && t.desc === desc));
  recomputeAnno2026();
  populateFilters();
  renderAll();
  renderVoceAll();
  persist('Eliminazione transazione');
}

/* ---------------- BUDGET ---------------- */
function categoriaMeseValore(dict, monthlyDict2026, cat, anno, mIdx) {
  if (anno === ANNO_CORRENTE) {
    return (monthlyDict2026 && monthlyDict2026[mIdx] && monthlyDict2026[mIdx][cat]) || 0;
  }
  const annualVal = dict[cat] ? dict[cat][anno] : undefined;
  if (annualVal === undefined) return 0;
  return annualVal / 12;
}

function haDettaglioCategorie(anno) {
  return ANNI_CON_CATEGORIE.has(anno) || anno === ANNO_CORRENTE;
}

function stipendioMese(anno, mIdx) {
  if (!haDettaglioCategorie(anno)) return 0;
  return categoriaMeseValore(DATA.entrateCategorie, DATA._monthlyCat2026?.entrate, 'Stipendio', anno, mIdx);
}
function usciteBaseEffettivo(anno, mIdx) {
  let v = DATA.flussi[anno].uscite[mIdx];
  if (!haDettaglioCategorie(anno)) return v;
  v -= categoriaMeseValore(DATA.usciteCategorie, DATA._monthlyCat2026?.uscite, 'Acquisto Titoli', anno, mIdx);
  v -= categoriaMeseValore(DATA.usciteCategorie, DATA._monthlyCat2026?.uscite, 'Progetto', anno, mIdx);
  v -= categoriaMeseValore(DATA.usciteCategorie, DATA._monthlyCat2026?.uscite, 'Spese Lavorative', anno, mIdx);
  return v;
}
function annoAdjEntrateMese(anno, mIdx, escludiTitoli, escludiProgetti) {
  let v = DATA.flussi[anno].entrate[mIdx];
  if (!haDettaglioCategorie(anno)) return v;
  if (escludiTitoli) v -= categoriaMeseValore(DATA.entrateCategorie, DATA._monthlyCat2026?.entrate, 'Vendita Titoli', anno, mIdx);
  if (escludiProgetti) v -= categoriaMeseValore(DATA.entrateCategorie, DATA._monthlyCat2026?.entrate, 'Progetto', anno, mIdx);
  return v;
}
function annoAdjUsciteMese(anno, mIdx, escludiTitoli, escludiProgetti) {
  let v = DATA.flussi[anno].uscite[mIdx];
  if (!haDettaglioCategorie(anno)) return v;
  if (escludiTitoli) v -= categoriaMeseValore(DATA.usciteCategorie, DATA._monthlyCat2026?.uscite, 'Acquisto Titoli', anno, mIdx);
  if (escludiProgetti) v -= categoriaMeseValore(DATA.usciteCategorie, DATA._monthlyCat2026?.uscite, 'Progetto', anno, mIdx);
  return v;
}

function populateBudgetAnno() {
  const sel = document.getElementById('budget-anno');
  const prev = sel.value;
  sel.innerHTML = [...ANNI].reverse().map(y => `<option value="${y}">${y}</option>`).join("");
  sel.value = ANNI.includes(Number(prev)) ? prev : ANNO_CORRENTE;
}

function renderBudget() {
  const anno = parseInt(document.getElementById('budget-anno').value || ANNO_CORRENTE, 10);
  const escludiTitoli = !document.getElementById('budget-flag-titoli').checked;
  const escludiProgetti = !document.getElementById('budget-flag-progetti').checked;
  document.getElementById('budget-title').textContent = `Budget mensile ${anno}`;

  let totE = 0, totU = 0, totTeor = 0, totEff = 0;
  document.getElementById('budget-table').querySelector('tbody').innerHTML = MESI_IT.map((m, i) => {
    const eRaw = DATA.flussi[anno].entrate[i], uRaw = DATA.flussi[anno].uscite[i];
    const noData = (eRaw === 0 && uRaw === 0);
    const e = annoAdjEntrateMese(anno, i, escludiTitoli, escludiProgetti);
    const u = annoAdjUsciteMese(anno, i, escludiTitoli, escludiProgetti);
    const saldo = e - u;
    const teorico = 0.5 * stipendioMese(anno, i);
    const effettivo = usciteBaseEffettivo(anno, i);
    const delta = effettivo - teorico;
    totE += e; totU += u; totTeor += teorico; totEff += effettivo;
    return `<tr>
      <td>${m}${noData ? ' <span class="tag">nessun dato</span>' : ''}</td>
      <td class="num pos">${eur(e)}</td>
      <td class="num neg">${eur(u)}</td>
      <td class="num ${saldo >= 0 ? 'pos' : 'neg'}">${eur(saldo)}</td>
      <td class="num">${eur(teorico)}</td>
      <td class="num neg">${eur(effettivo)}</td>
      <td class="num ${delta <= 0 ? 'delta-pos' : 'delta-neg'}">${eur(delta)}</td>
    </tr>`;
  }).join("");

  document.getElementById('budget-table').querySelector('tfoot').innerHTML = `
    <tr style="font-weight:700; border-top:2px solid var(--ink);">
      <td>TOTALE ${anno}</td>
      <td class="num pos">${eur(totE)}</td>
      <td class="num neg">${eur(totU)}</td>
      <td class="num ${(totE - totU) >= 0 ? 'pos' : 'neg'}">${eur(totE - totU)}</td>
      <td class="num">${eur(totTeor)}</td>
      <td class="num neg">${eur(totEff)}</td>
      <td class="num ${(totEff - totTeor) <= 0 ? 'delta-pos' : 'delta-neg'}">${eur(totEff - totTeor)}</td>
    </tr>`;

  const note = [];
  note.push('Flusso teorico = 50% dello stipendio del mese.');
  note.push('Flusso effettivo = uscite del mese al netto di Progetto, Acquisto Titoli e Spese Lavorative.');
  note.push('Delta = Flusso effettivo &minus; Flusso teorico (valori &le; 0 indicano uscite nette entro la soglia teorica).');
  if (anno !== ANNO_CORRENTE) note.push(`Per l'anno ${anno} non sono disponibili transazioni mensili dettagliate: stipendio e categorie escluse dal calcolo (Progetto, Acquisto Titoli, Spese Lavorative) sono stimati distribuendo il totale annuale in parti uguali sui 12 mesi.`);
  document.getElementById('budget-note').innerHTML = note.join(' ');
}

/* ---------------- PATRIMONIO (editabile) ---------------- */
function renderPatrimonio() {
  const tbody = document.getElementById('patrimonio-table').querySelector('tbody');
  tbody.innerHTML = DATA.patrimonio.map((p, i) => {
    const tot = (p.liquidita || 0) + (p.azioni || 0) + (p.obbligazioni || 0) + (p.deposito || 0);
    return `<tr data-idx="${i}">
      <td><input class="cell-edit patr-field" data-idx="${i}" data-field="istituto" type="text" value="${p.istituto == null ? '' : p.istituto}"></td>
      <td><input class="cell-edit patr-field" data-idx="${i}" data-field="liquidita" type="number" step="0.01" value="${p.liquidita || 0}"></td>
      <td><input class="cell-edit patr-field" data-idx="${i}" data-field="azioni" type="number" step="0.01" value="${p.azioni || 0}"></td>
      <td><input class="cell-edit patr-field" data-idx="${i}" data-field="obbligazioni" type="number" step="0.01" value="${p.obbligazioni || 0}"></td>
      <td><input class="cell-edit patr-field" data-idx="${i}" data-field="deposito" type="number" step="0.01" value="${p.deposito || 0}"></td>
      <td class="num" style="font-weight:600;">${eur(tot)}</td>
      <td><button class="rowbtn" data-idx="${i}" onclick="deletePatrimonioRow(${i})">elimina</button></td>
    </tr>`;
  }).join("");
  const totRow = ['liquidita', 'azioni', 'obbligazioni', 'deposito'].map(k => DATA.patrimonio.reduce((s, p) => s + (p[k] || 0), 0));
  document.getElementById('patrimonio-table').querySelector('tfoot').innerHTML = `
    <tr style="font-weight:700; border-top:2px solid var(--ink);">
      <td>TOTALE</td>
      <td class="num">${eur(totRow[0])}</td>
      <td class="num">${eur(totRow[1])}</td>
      <td class="num">${eur(totRow[2])}</td>
      <td class="num">${eur(totRow[3])}</td>
      <td class="num">${eur(patrimonioTotale())}</td>
      <td></td>
    </tr>`;

  tbody.querySelectorAll('.patr-field').forEach(inp => {
    inp.addEventListener('change', onPatrimonioFieldChange);
  });
}

function onPatrimonioFieldChange(e) {
  const idx = parseInt(e.target.dataset.idx, 10);
  const field = e.target.dataset.field;
  const row = DATA.patrimonio[idx];
  if (!row) return;
  if (field === 'istituto') {
    row.istituto = e.target.value.trim() || null;
  } else {
    const n = parseFloat(e.target.value);
    row[field] = isNaN(n) ? 0 : n;
  }
  renderPatrimonio();
  renderHeader();
  renderDashboard();
  persist('Aggiornamento patrimonio');
}

function addPatrimonioRow() {
  DATA.patrimonio.push({ istituto: 'Nuovo istituto', liquidita: 0, azioni: 0, obbligazioni: 0, deposito: 0 });
  renderPatrimonio();
  renderHeader();
  renderDashboard();
  persist('Aggiunta istituto patrimonio');
}
function deletePatrimonioRow(idx) {
  DATA.patrimonio.splice(idx, 1);
  renderPatrimonio();
  renderHeader();
  renderDashboard();
  persist('Rimozione istituto patrimonio');
}

/* ---------------- PORTAFOGLIO ---------------- */
function renderPortafoglio() {
  const s = DATA.portafoglio.summary;
  document.getElementById('ptf-cards').innerHTML = `
    <div class="card"><div class="label">Valore di carico</div><div class="value">${eur(s.valoreCarico)}</div></div>
    <div class="card"><div class="label">Valore di mercato</div><div class="value">${eur(s.valoreMercato)}</div></div>
    <div class="card"><div class="label">Variazione</div><div class="value pos">${eur(s.varEuro)} (${pct(s.varPct)})</div></div>
  `;
  document.getElementById('ptf-table').querySelector('tbody').innerHTML = DATA.portafoglio.titoli.map(t => `
    <tr>
      <td>${t.nome}</td>
      <td>${t.simbolo || ''}</td>
      <td><span class="tag">${t.strumento || ''}</span></td>
      <td class="num">${t.qta.toLocaleString('it-IT')}</td>
      <td class="num">${t.pzo.toLocaleString('it-IT', { minimumFractionDigits: 2, maximumFractionDigits: 5 })}</td>
    </tr>
  `).join("");
}

/* ---------------- RENDER GLOBALE ---------------- */
function renderAll() {
  renderHeader();
  renderDataBanner();
  renderDashboard();
  renderTransazioni();
  renderBudget();
  renderPatrimonio();
  renderPortafoglio();
}

/* ---------------- TABS ---------------- */
const TAB_ORDER = ['dashboard', 'pervoce', 'transazioni', 'budget', 'patrimonio', 'portafoglio', 'importa'];
document.getElementById('tabs').addEventListener('click', (e) => {
  if (e.target.tagName !== 'BUTTON') return;
  const tab = e.target.dataset.tab;
  document.querySelectorAll('#tabs button').forEach(b => b.classList.toggle('active', b === e.target));
  TAB_ORDER.forEach(t => {
    document.getElementById('tab-' + t).style.display = (t === tab) ? 'block' : 'none';
  });
});

/* ---------------- EVENTI ---------------- */
document.getElementById('flag-titoli').addEventListener('change', renderDashChart);
document.getElementById('flag-progetti').addEventListener('change', renderDashChart);
document.getElementById('budget-flag-titoli').addEventListener('change', renderBudget);
document.getElementById('budget-flag-progetti').addEventListener('change', renderBudget);
document.getElementById('budget-anno').addEventListener('change', renderBudget);

document.getElementById('voce-cat-entrate').addEventListener('change', () => renderVoceBlock('entrate'));
document.getElementById('voce-cat-uscite').addEventListener('change', () => renderVoceBlock('uscite'));

document.getElementById('filter-mese').addEventListener('change', renderTransazioni);
document.getElementById('filter-cat').addEventListener('change', renderTransazioni);
document.getElementById('filter-da').addEventListener('change', renderTransazioni);
document.getElementById('filter-a').addEventListener('change', renderTransazioni);
document.getElementById('btn-clear-filters').addEventListener('click', () => {
  document.getElementById('filter-mese').value = '';
  document.getElementById('filter-cat').value = '';
  document.getElementById('filter-da').value = '';
  document.getElementById('filter-a').value = '';
  renderTransazioni();
});

document.getElementById('btn-new-tx').addEventListener('click', () => {
  document.getElementById('tx-form').classList.add('open');
});
document.getElementById('btn-cancel-tx').addEventListener('click', () => {
  document.getElementById('tx-form').classList.remove('open');
});
document.getElementById('btn-save-tx').addEventListener('click', () => {
  const data = document.getElementById('f-data').value;
  const desc = document.getElementById('f-desc').value.trim();
  const importo = parseFloat(document.getElementById('f-importo').value);
  const cat = document.getElementById('f-cat').value;
  if (!data || !desc || isNaN(importo)) { alert('Compila data, descrizione e importo.'); return; }
  transazioni.push({ data, desc, importo, cat });
  document.getElementById('f-data').value = '';
  document.getElementById('f-desc').value = '';
  document.getElementById('f-importo').value = '';
  document.getElementById('tx-form').classList.remove('open');
  recomputeAnno2026();
  populateFilters();
  renderAll();
  renderVoceAll();
  persist('Nuova transazione');
});

document.getElementById('btn-choose-files').addEventListener('click', () => document.getElementById('import-file-input').click());
document.getElementById('import-file-input').addEventListener('change', (e) => handleImportFiles(e.target.files));

const dropZone = document.getElementById('import-drop');
['dragover'].forEach(ev => dropZone.addEventListener(ev, e => { e.preventDefault(); dropZone.classList.add('dragover'); }));
['dragleave', 'drop'].forEach(ev => dropZone.addEventListener(ev, e => { e.preventDefault(); dropZone.classList.remove('dragover'); }));
dropZone.addEventListener('drop', e => {
  if (e.dataTransfer.files.length) handleImportFiles(e.dataTransfer.files);
});

document.getElementById('btn-select-all-new').addEventListener('click', () => {
  document.querySelectorAll('.import-check').forEach(cb => {
    const t = stagingImport[cb.dataset.idx];
    cb.checked = !esisteGiaTransazione(t);
  });
});
document.getElementById('btn-select-none').addEventListener('click', () => {
  document.querySelectorAll('.import-check').forEach(cb => cb.checked = false);
});

document.getElementById('btn-confirm-import').addEventListener('click', () => {
  const checks = document.querySelectorAll('.import-check:checked');
  let n = 0;
  checks.forEach(cb => {
    const idx = cb.dataset.idx;
    const t = stagingImport[idx];
    const sel = document.querySelector(`.cat-select[data-idx="${idx}"]`);
    const cat = sel ? sel.value : suggerisciCategoria(t.desc, t.importo);
    transazioni.push({ data: t.data, desc: t.desc, importo: t.importo, cat });
    n++;
  });
  stagingImport = [];
  document.getElementById('import-review').style.display = 'none';
  document.getElementById('import-status').innerHTML += `<div class="file-ok">&#10003; Importati ${n} movimenti nelle Transazioni.</div>`;
  document.getElementById('import-file-input').value = '';
  recomputeAnno2026();
  populateFilters();
  populateVoceCats();
  populateBudgetAnno();
  renderAll();
  renderVoceAll();
  persist(`Importazione ${n} movimenti da file`);
});

document.getElementById('btn-add-istituto').addEventListener('click', addPatrimonioRow);

/* ---------------- INIZIALIZZAZIONE ---------------- */
async function initApp() {
  GitHubSync.init();
  refreshDerivedConstants();

  if (GitHubSync.isConfigured()) {
    const remote = await GitHubSync.loadData();
    if (remote) {
      DATA = remote;
      transazioni = (DATA.transazioni2026 || []).map(t => ({ ...t }));
    }
  }

  recomputeAnno2026();
  populateFilters();
  populateVoceCats();
  populateBudgetAnno();
  renderVoceAll();
  renderAll();
}

window.onGitHubConfigured = async function () {
  const remote = await GitHubSync.loadData();
  if (remote) {
    DATA = remote;
    transazioni = (DATA.transazioni2026 || []).map(t => ({ ...t }));
    recomputeAnno2026();
  } else {
    recomputeAnno2026();
    persist('Inizializzazione dati su GitHub');
  }
  populateFilters();
  populateVoceCats();
  populateBudgetAnno();
  renderVoceAll();
  renderAll();
};

initApp();
