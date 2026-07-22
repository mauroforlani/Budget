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
let transazioni = (DATA.transazioni || []).map(t => ({ ...t }));
let ANNI = [];
let ANNI_CON_CATEGORIE = new Set();
let ANNO_CORRENTE = (DATA.meta.anniFlussi || [2026]).reduce((a, b) => Math.max(a, b), 0);

function refreshDerivedConstants() {
  ANNI = DATA.meta.anniFlussi.map(Number).sort((a, b) => a - b);
  ANNI_CON_CATEGORIE = new Set(Object.keys(DATA.entrateCategorie['TOTALE'] || {}).map(Number));
}

function patrimonioTotale() {
  return DATA.patrimonio.reduce((s, p) => s + (p.liquidita || 0) + (p.azioni || 0) + (p.obbligazioni || 0) + (p.deposito || 0), 0);
}

/* ---------------- RICALCOLO FLUSSI DA TRANSAZIONI ----------------
   Ogni modifica alle transazioni (nuova, cancellazione, importazione) deve
   propagarsi a flussi mensili e categorie di TUTTI gli anni per cui esiste
   dettaglio analitico (non solo l'anno corrente), così dashboard, budget e
   dettaglio per voce restano coerenti con i dati reali.
   L'aggregazione mensile usa `meseRif` (il mese/foglio di competenza
   originale, se noto) invece del solo campo `data`, perché alcune
   registrazioni di fine mese vengono contabilizzate nel mese successivo
   nei file sorgente; se `meseRif` non è presente (nuove registrazioni
   manuali o importate da estratto conto) si usa il mese di `data`. */
function meseRifOf(t) { return t.meseRif || t.data.slice(0, 7); }

function recomputeFlussi() {
  const byYear = {};
  transazioni.forEach(t => {
    const rif = meseRifOf(t);
    const y = parseInt(rif.slice(0, 4), 10);
    const mi = parseInt(rif.slice(5, 7), 10) - 1;
    if (!y || mi < 0 || mi > 11) return;
    if (!byYear[y]) {
      byYear[y] = {
        entMonth: Array(12).fill(0), usMonth: Array(12).fill(0),
        entCatMonth: Array.from({ length: 12 }, () => ({})), usCatMonth: Array.from({ length: 12 }, () => ({})),
        entCatYear: {}, usCatYear: {}
      };
    }
    const Y = byYear[y];
    if (t.importo >= 0) {
      Y.entMonth[mi] += t.importo;
      Y.entCatMonth[mi][t.cat] = (Y.entCatMonth[mi][t.cat] || 0) + t.importo;
      Y.entCatYear[t.cat] = (Y.entCatYear[t.cat] || 0) + t.importo;
    } else {
      const v = -t.importo;
      Y.usMonth[mi] += v;
      Y.usCatMonth[mi][t.cat] = (Y.usCatMonth[mi][t.cat] || 0) + v;
      Y.usCatYear[t.cat] = (Y.usCatYear[t.cat] || 0) + v;
    }
  });

  DATA._monthlyCat = {};
  Object.keys(byYear).forEach(yStr => {
    const y = Number(yStr);
    const Y = byYear[yStr];
    DATA.flussi[y] = { entrate: Y.entMonth, uscite: Y.usMonth };

    Object.keys(DATA.entrateCategorie).forEach(cat => { if (cat !== 'TOTALE') DATA.entrateCategorie[cat][y] = Y.entCatYear[cat] || 0; });
    Object.keys(DATA.usciteCategorie).forEach(cat => { if (cat !== 'TOTALE') DATA.usciteCategorie[cat][y] = Y.usCatYear[cat] || 0; });
    Object.keys(Y.entCatYear).forEach(cat => {
      if (!(cat in DATA.entrateCategorie)) DATA.entrateCategorie[cat] = {};
      DATA.entrateCategorie[cat][y] = Y.entCatYear[cat];
    });
    Object.keys(Y.usCatYear).forEach(cat => {
      if (!(cat in DATA.usciteCategorie)) DATA.usciteCategorie[cat] = {};
      DATA.usciteCategorie[cat][y] = Y.usCatYear[cat];
    });
    if (DATA.entrateCategorie['TOTALE']) DATA.entrateCategorie['TOTALE'][y] = sum(Y.entMonth);
    if (DATA.usciteCategorie['TOTALE']) DATA.usciteCategorie['TOTALE'][y] = sum(Y.usMonth);

    DATA._monthlyCat[y] = { entrate: Y.entCatMonth, uscite: Y.usCatMonth };
  });

  const anniConDettaglio = Object.keys(byYear).map(Number);
  if (anniConDettaglio.length) {
    ANNO_CORRENTE = Math.max(...anniConDettaglio, ...DATA.meta.anniFlussi.map(Number));
  }

  const cur = byYear[ANNO_CORRENTE];
  const mesiConDati = [];
  if (cur) { for (let m = 0; m < 12; m++) { if (cur.entMonth[m] !== 0 || cur.usMonth[m] !== 0) mesiConDati.push(MESI_IT[m]); } }
  DATA.meta.mesiTransazioniDettagliate = mesiConDati;
  DATA.meta.mesiSenzaDati2026 = MESI_IT.filter(m => !mesiConDati.includes(m));
  DATA.meta.primoAnnoDettaglio = anniConDettaglio.length ? Math.min(...anniConDettaglio) : null;

  refreshDerivedConstants();
}

/* ---------------- PERSISTENZA SU GITHUB ---------------- */
function buildExportData() {
  const clone = JSON.parse(JSON.stringify(DATA));
  delete clone._monthlyCat;
  clone.transazioni = transazioni.map(t => ({ ...t }));
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
  const primoDett = DATA.meta.primoAnnoDettaglio || Math.min(...ANNI_CON_CATEGORIE);
  const ultimoAnnoCompleto = ANNO_CORRENTE - 1;
  const mesiConDati = DATA.meta.mesiTransazioniDettagliate.join(", ") || "nessuno";

  const rangeFlussi = ANNI.length > 1 ? `${ANNI[0]}&ndash;${ANNI[ANNI.length - 1]}` : `${ANNI[0]}`;
  let rangeDettaglio;
  if (primoDett > ultimoAnnoCompleto) {
    rangeDettaglio = `${ANNO_CORRENTE} (parziale: ${mesiConDati})`;
  } else if (primoDett === ultimoAnnoCompleto) {
    rangeDettaglio = `${primoDett} (anno completo) e ${ANNO_CORRENTE} (parziale: ${mesiConDati})`;
  } else {
    rangeDettaglio = `${primoDett}&ndash;${ultimoAnnoCompleto} (anni completi) e ${ANNO_CORRENTE} (parziale: ${mesiConDati})`;
  }

  document.getElementById('data-banner').innerHTML =
    `<b>Copertura dati:</b> flussi annuali ${rangeFlussi}, transazioni analitiche di dettaglio ${rangeDettaglio}.`;
}

function renderDashCards() {
  const escludiTitoli = !document.getElementById('summary-flag-titoli').checked;
  const escludiProgetti = !document.getElementById('summary-flag-progetti').checked;

  const entrateYTD = annoAdjEntrate(ANNO_CORRENTE, escludiTitoli, escludiProgetti);
  const usciteYTD = annoAdjUscite(ANNO_CORRENTE, escludiTitoli, escludiProgetti);
  const saldoYTD = entrateYTD - usciteYTD;

  document.getElementById('dash-cards').innerHTML = `
    <div class="card"><div class="label">Entrate ${ANNO_CORRENTE} (YTD)</div><div class="value pos">${eur(entrateYTD)}</div></div>
    <div class="card"><div class="label">Uscite ${ANNO_CORRENTE} (YTD)</div><div class="value neg">${eur(usciteYTD)}</div></div>
    <div class="card"><div class="label">Saldo ${ANNO_CORRENTE} (YTD)</div><div class="value ${saldoYTD >= 0 ? 'pos' : 'neg'}">${eur(saldoYTD)}</div></div>
    <div class="card"><div class="label">Patrimonio totale</div><div class="value">${eur(patrimonioTotale())}</div><div class="sub">Vedi tab Patrimonio</div></div>
  `;
}

function renderDashboard() {
  renderDashCards();
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
  const anni = [...new Set(transazioni.map(t => t.data.slice(0, 4)))].sort().reverse();
  const fy = document.getElementById('filter-anno');
  const prevAnno = fy.value;
  fy.innerHTML = '<option value="">Tutti gli anni</option>' + anni.map(a => `<option value="${a}">${a}</option>`).join("");
  if (anni.includes(prevAnno)) fy.value = prevAnno;

  const fm = document.getElementById('filter-mese');
  const prevMese = fm.value;
  fm.innerHTML = '<option value="">Tutti i mesi</option>' + MESI_IT.map((nome, i) => {
    const mm = String(i + 1).padStart(2, '0');
    return `<option value="${mm}">${nome}</option>`;
  }).join("");
  fm.value = prevMese;

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

function filteredTransazioni() {
  const anno = document.getElementById('filter-anno').value;
  const mese = document.getElementById('filter-mese').value;
  const cat = document.getElementById('filter-cat').value;
  const da = document.getElementById('filter-da').value;
  const a = document.getElementById('filter-a').value;
  let rows = [...transazioni];
  if (da) rows = rows.filter(t => t.data >= da);
  if (a) rows = rows.filter(t => t.data <= a);
  if (!da && !a) {
    if (anno) rows = rows.filter(t => t.data.slice(0, 4) === anno);
    if (mese) rows = rows.filter(t => t.data.slice(5, 7) === mese);
  }
  if (cat) rows = rows.filter(t => t.cat === cat);
  return rows;
}

function renderTransazioni() {
  const rows = filteredTransazioni();
  rows.sort((a, b) => b.data.localeCompare(a.data));

  const entrate = sum(rows.filter(t => t.importo >= 0).map(t => t.importo));
  const uscite = sum(rows.filter(t => t.importo < 0).map(t => -t.importo));
  const saldo = entrate - uscite;
  document.getElementById('tx-summary').innerHTML = `
    <div class="card"><div class="label">Entrate (filtro attivo)</div><div class="value pos">${eur(entrate)}</div></div>
    <div class="card"><div class="label">Uscite (filtro attivo)</div><div class="value neg">${eur(uscite)}</div></div>
    <div class="card"><div class="label">Saldo netto</div><div class="value ${saldo >= 0 ? 'pos' : 'neg'}">${eur(saldo)}</div><div class="sub">${rows.length} registrazioni</div></div>
  `;

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
  recomputeFlussi();
  populateFilters();
  renderAll();
  renderVoceAll();
  persist('Eliminazione transazione');
}

/* ---------------- BUDGET ---------------- */
function haDettaglioMensile(anno) {
  return !!(DATA._monthlyCat && DATA._monthlyCat[anno]);
}
function haDettaglioCategorie(anno) {
  return haDettaglioMensile(anno) || ANNI_CON_CATEGORIE.has(anno);
}

function categoriaMeseValore(dict, cat, anno, mIdx) {
  if (haDettaglioMensile(anno)) {
    const lato = dict === DATA.entrateCategorie ? 'entrate' : 'uscite';
    const monthly = DATA._monthlyCat[anno][lato];
    return (monthly && monthly[mIdx] && monthly[mIdx][cat]) || 0;
  }
  const annualVal = dict[cat] ? dict[cat][anno] : undefined;
  if (annualVal === undefined) return 0;
  return annualVal / 12;
}

function stipendioMese(anno, mIdx) {
  if (!haDettaglioCategorie(anno)) return 0;
  return categoriaMeseValore(DATA.entrateCategorie, 'Stipendio', anno, mIdx);
}
function usciteBaseEffettivo(anno, mIdx) {
  let v = DATA.flussi[anno].uscite[mIdx];
  if (!haDettaglioCategorie(anno)) return v;
  v -= categoriaMeseValore(DATA.usciteCategorie, 'Acquisto Titoli', anno, mIdx);
  v -= categoriaMeseValore(DATA.usciteCategorie, 'Progetto', anno, mIdx);
  v -= categoriaMeseValore(DATA.usciteCategorie, 'Spese Lavorative', anno, mIdx);
  return v;
}
function annoAdjEntrateMese(anno, mIdx, escludiTitoli, escludiProgetti) {
  let v = DATA.flussi[anno].entrate[mIdx];
  if (!haDettaglioCategorie(anno)) return v;
  if (escludiTitoli) v -= categoriaMeseValore(DATA.entrateCategorie, 'Vendita Titoli', anno, mIdx);
  if (escludiProgetti) v -= categoriaMeseValore(DATA.entrateCategorie, 'Progetto', anno, mIdx);
  return v;
}
function annoAdjUsciteMese(anno, mIdx, escludiTitoli, escludiProgetti) {
  let v = DATA.flussi[anno].uscite[mIdx];
  if (!haDettaglioCategorie(anno)) return v;
  if (escludiTitoli) v -= categoriaMeseValore(DATA.usciteCategorie, 'Acquisto Titoli', anno, mIdx);
  if (escludiProgetti) v -= categoriaMeseValore(DATA.usciteCategorie, 'Progetto', anno, mIdx);
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
  if (!haDettaglioMensile(anno)) note.push(`Per l'anno ${anno} non sono disponibili transazioni mensili dettagliate: stipendio e categorie escluse dal calcolo (Progetto, Acquisto Titoli, Spese Lavorative) sono stimati distribuendo il totale annuale in parti uguali sui 12 mesi.`);
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
    <div class="card"><div class="label">Variazione</div><div class="value ${s.varEuro >= 0 ? 'pos' : 'neg'}">${eur(s.varEuro)} (${pct(s.varPct)})</div></div>
  `;
  document.getElementById('ptf-updated').textContent = DATA.portafoglio.aggiornatoIl
    ? `Ultimo aggiornamento: ${fmtData(DATA.portafoglio.aggiornatoIl)}` : '';
  document.getElementById('ptf-table').querySelector('tbody').innerHTML = DATA.portafoglio.titoli.map(t => `
    <tr>
      <td>${t.nome}</td>
      <td>${t.isin || ''}</td>
      <td><span class="tag">${t.mercato || ''}</span></td>
      <td><span class="tag">${t.strumento || ''}</span></td>
      <td class="num">${(t.qta || 0).toLocaleString('it-IT')}</td>
      <td class="num">${(t.pzo || 0).toLocaleString('it-IT', { minimumFractionDigits: 2, maximumFractionDigits: 5 })}</td>
      <td class="num">${eur(t.valoreCarico || 0)}</td>
      <td class="num">${t.pzoMercato != null ? t.pzoMercato.toLocaleString('it-IT', { minimumFractionDigits: 2, maximumFractionDigits: 5 }) : ''}</td>
      <td class="num">${eur(t.valoreMercato || 0)}</td>
      <td class="num ${(t.varPct || 0) >= 0 ? 'pos' : 'neg'}">${t.varPct != null ? pct(t.varPct / 100) : ''}</td>
      <td class="num ${(t.varEuro || 0) >= 0 ? 'pos' : 'neg'}">${t.varEuro != null ? eur(t.varEuro) : ''}</td>
    </tr>
  `).join("") || `<tr><td colspan="11" style="color:var(--ink-soft); padding:18px;">Nessun titolo in portafoglio: importa un file per popolarlo.</td></tr>`;
}

/* ---------------- IMPORTAZIONE PORTAFOGLIO (sostituisce il tab) ----------------
   Riconosce l'export "Portafoglio di sintesi" (xls/xlsx) con colonne:
   Titolo, ISIN, Simbolo, Mercato, Strumento, Valuta, Quantità, P.zo medio di
   carico, Cambio di carico, Valore di carico, P.zo di mercato, Cambio di
   mercato, Valore di mercato €, Var%, Var €, Var in valuta, Rateo. */
function trovaColonna(headerRow, nomi) {
  for (let c = 0; c < headerRow.length; c++) {
    const v = (headerRow[c] == null ? '' : String(headerRow[c])).trim();
    if (nomi.includes(v)) return c;
  }
  return -1;
}

function parsePortafoglioSintesi(rows) {
  let hIdx = -1, cols = null;
  for (let i = 0; i < rows.length; i++) {
    const row = (rows[i] || []).map(v => (v == null ? '' : String(v)).trim());
    if (row.includes('Titolo') && row.includes('ISIN') && row.includes('Quantità')) { hIdx = i; break; }
  }
  if (hIdx < 0) return null;
  const header = rows[hIdx];
  cols = {
    nome: trovaColonna(header, ['Titolo']),
    isin: trovaColonna(header, ['ISIN']),
    simbolo: trovaColonna(header, ['Simbolo']),
    mercato: trovaColonna(header, ['Mercato']),
    strumento: trovaColonna(header, ['Strumento']),
    valuta: trovaColonna(header, ['Valuta']),
    qta: trovaColonna(header, ['Quantità']),
    pzo: trovaColonna(header, ['P.zo medio di carico']),
    valoreCarico: trovaColonna(header, ['Valore di carico']),
    pzoMercato: trovaColonna(header, ['P.zo di mercato']),
    valoreMercato: trovaColonna(header, ['Valore di mercato €', 'Valore di mercato']),
    varPct: trovaColonna(header, ['Var%']),
    varEuro: trovaColonna(header, ['Var €', 'Var €']),
  };

  const titoli = [];
  let r = hIdx + 1;
  let totaleRowIdx = -1;
  for (; r < rows.length; r++) {
    const row = rows[r];
    if (!row || row.every(v => v === '' || v == null)) continue;
    const nomeVal = row[cols.nome];
    if (nomeVal == null || String(nomeVal).trim() === '') continue;
    if (String(nomeVal).trim().toLowerCase() === 'totale') { totaleRowIdx = r; break; }
    titoli.push({
      nome: String(nomeVal).trim(),
      isin: cols.isin >= 0 ? String(row[cols.isin] || '').trim() : '',
      simbolo: cols.simbolo >= 0 ? String(row[cols.simbolo] || '').trim() : '',
      mercato: cols.mercato >= 0 ? String(row[cols.mercato] || '').trim() : '',
      strumento: cols.strumento >= 0 ? String(row[cols.strumento] || '').trim() : '',
      valuta: cols.valuta >= 0 ? String(row[cols.valuta] || '').trim() : '',
      qta: numOrNull(row[cols.qta]) || 0,
      pzo: numOrNull(row[cols.pzo]) || 0,
      valoreCarico: numOrNull(row[cols.valoreCarico]) || 0,
      pzoMercato: numOrNull(row[cols.pzoMercato]),
      valoreMercato: numOrNull(row[cols.valoreMercato]) || 0,
      varPct: numOrNull(row[cols.varPct]),
      varEuro: numOrNull(row[cols.varEuro]),
    });
  }
  if (!titoli.length) return null;

  let summary = {
    valoreCarico: sum(titoli.map(t => t.valoreCarico)),
    valoreMercato: sum(titoli.map(t => t.valoreMercato)),
    varEuro: sum(titoli.map(t => t.valoreMercato)) - sum(titoli.map(t => t.valoreCarico)),
    varPct: 0,
  };
  // riga di riepilogo ufficiale del file (se presente, più precisa della somma manuale)
  if (totaleRowIdx >= 0 && rows[totaleRowIdx + 1]) {
    const totRow = rows[totaleRowIdx + 1];
    const vc = numOrNull(totRow[cols.valoreCarico]);
    const vm = numOrNull(totRow[cols.valoreMercato]);
    const vp = numOrNull(totRow[cols.varPct]);
    const ve = numOrNull(totRow[cols.varEuro]);
    if (vc != null) summary.valoreCarico = vc;
    if (vm != null) summary.valoreMercato = vm;
    if (ve != null) summary.varEuro = ve;
    if (vp != null) summary.varPct = vp;
  }
  if (!summary.varPct && summary.valoreCarico) {
    summary.varPct = (summary.varEuro / summary.valoreCarico) * 100;
  }
  summary.varPct = summary.varPct / 100; // uniforma alla convenzione "frazione" usata da pct()

  return { titoli, summary };
}

async function handlePortafoglioFile(file) {
  const statusEl = document.getElementById('ptf-import-status');
  statusEl.innerHTML = '';
  try {
    const buf = await file.arrayBuffer();
    const wb = XLSX.read(buf, { type: 'array', cellDates: true });
    let parsed = null;
    for (const sheetName of wb.SheetNames) {
      const rows = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { header: 1, raw: true });
      parsed = parsePortafoglioSintesi(rows);
      if (parsed) break;
    }
    if (!parsed) {
      statusEl.innerHTML = `<div class="file-err">✕ ${file.name}: formato non riconosciuto (attese le colonne del "Portafoglio di sintesi").</div>`;
      return;
    }
    DATA.portafoglio = {
      titoli: parsed.titoli,
      summary: parsed.summary,
      aggiornatoIl: new Date().toISOString().slice(0, 10),
    };
    renderPortafoglio();
    statusEl.innerHTML = `<div class="file-ok">&#10003; Portafoglio sostituito con ${parsed.titoli.length} titoli da ${file.name}.</div>`;
    persist('Aggiornamento portafoglio da file');
  } catch (err) {
    statusEl.innerHTML = `<div class="file-err">✕ ${file.name}: errore di lettura (${err.message}).</div>`;
  }
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
document.getElementById('summary-flag-titoli').addEventListener('change', renderDashCards);
document.getElementById('summary-flag-progetti').addEventListener('change', renderDashCards);
document.getElementById('budget-flag-titoli').addEventListener('change', renderBudget);
document.getElementById('budget-flag-progetti').addEventListener('change', renderBudget);
document.getElementById('budget-anno').addEventListener('change', renderBudget);

document.getElementById('voce-cat-entrate').addEventListener('change', () => renderVoceBlock('entrate'));
document.getElementById('voce-cat-uscite').addEventListener('change', () => renderVoceBlock('uscite'));

document.getElementById('filter-anno').addEventListener('change', renderTransazioni);
document.getElementById('filter-mese').addEventListener('change', renderTransazioni);
document.getElementById('filter-cat').addEventListener('change', renderTransazioni);
document.getElementById('filter-da').addEventListener('change', renderTransazioni);
document.getElementById('filter-a').addEventListener('change', renderTransazioni);
document.getElementById('btn-clear-filters').addEventListener('click', () => {
  document.getElementById('filter-anno').value = '';
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
  recomputeFlussi();
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
  recomputeFlussi();
  populateFilters();
  populateVoceCats();
  populateBudgetAnno();
  renderAll();
  renderVoceAll();
  persist(`Importazione ${n} movimenti da file`);
});

document.getElementById('btn-add-istituto').addEventListener('click', addPatrimonioRow);

document.getElementById('btn-import-ptf').addEventListener('click', () => document.getElementById('ptf-file-input').click());
document.getElementById('ptf-file-input').addEventListener('change', (e) => {
  if (e.target.files.length) handlePortafoglioFile(e.target.files[0]);
  e.target.value = '';
});

/* ---------------- INIZIALIZZAZIONE ---------------- */
async function initApp() {
  GitHubSync.init();
  refreshDerivedConstants();

  if (GitHubSync.isConfigured()) {
    const remote = await GitHubSync.loadData();
    if (remote) {
      DATA = remote;
      transazioni = (DATA.transazioni || []).map(t => ({ ...t }));
    }
  }

  recomputeFlussi();
  populateFilters();
  populateVoceCats();
  populateBudgetAnno();
  renderVoceAll();
  renderAll();
}

window.onGitHubConfigured = async function (forcePush) {
  if (forcePush) {
    recomputeFlussi();
    await GitHubSync.saveData(buildExportData(), 'Sovrascrittura dati su GitHub con dati locali');
  } else {
    const remote = await GitHubSync.loadData();
    if (remote) {
      DATA = remote;
      transazioni = (DATA.transazioni || []).map(t => ({ ...t }));
      recomputeFlussi();
    } else {
      recomputeFlussi();
      persist('Inizializzazione dati su GitHub');
    }
  }
  populateFilters();
  populateVoceCats();
  populateBudgetAnno();
  renderVoceAll();
  renderAll();
};

initApp();
