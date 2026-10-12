/* =========================================================================
   charts.js — grafici interattivi per "Le Tue Finanze" (basati su Chart.js).

   Funzioni principali:
     ChartKit.yearly(hostId, spec)   barre/linee con filtro periodo, legenda
                                     accendibile e dettaglio al tocco/clic
     ChartKit.donut(hostId, spec)    ciambella per categorie con dettaglio
     ChartKit.openDrill(hostId, key) apre da fuori il pannello di dettaglio

   Formato `panel` restituito da onPick:
     { title, note, charts: [ {kind:'bars'|'donut'|'hbars', title, height, ...} ] }
   ========================================================================= */
const ChartKit = (() => {
  const COL = {
    ent: '#0E6E5C', usc: '#D8B15A', uscDark: '#B4842A',
    red: '#C13A2E', green: '#1B8A57', blue: '#3D6BE0',
    ink: '#12162B', soft: '#667085', grid: '#EDEFF6', other: '#B8BFCE'
  };
  const PALETTE = ['#0E6E5C', '#3D6BE0', '#D8B15A', '#C97A3E', '#7C5CC4', '#2FA36C', '#D9564A', '#4FB3D9'];

  const hasChart = () => typeof Chart !== 'undefined';
  if (hasChart()) {
    Chart.defaults.font.family = "'Inter', sans-serif";
    Chart.defaults.font.size = 11;
    Chart.defaults.color = COL.soft;
    Chart.defaults.animation.duration = 350;
  }

  const live = {};     // chiave -> istanza Chart
  const STATE = {};    // hostId -> { from, to, type, hidden, drill, pick }
  const st = (id, init) => STATE[id] || (STATE[id] = Object.assign({ from: null, to: null, type: 'bar', hidden: {}, drill: null, pick: null }, init || {}));
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const fmtEur = v => (typeof eur === 'function' ? eur(v) : String(v));
  const fmtCompact = v => (typeof eurCompact === 'function' ? eurCompact(v) : String(v));

  function killKeys(match) {
    Object.keys(live).forEach(k => { if (match(k)) { try { live[k].destroy(); } catch (e) { /* ignora */ } delete live[k]; } });
  }
  const killHost = id => killKeys(k => k === id || k.startsWith(id + '#'));
  const killDrill = id => killKeys(k => k.startsWith(id + '#d'));
  function mk(key, canvas, cfg) {
    if (live[key]) { try { live[key].destroy(); } catch (e) { /* ignora */ } }
    live[key] = new Chart(canvas, cfg);
    return live[key];
  }
  const fallback = '<div class="ck-empty">Grafico non disponibile (libreria non caricata).</div>';

  /* ---------- configurazioni Chart.js ---------- */
  function barLineCfg(o) {
    const lineMode = o.type === 'line';
    const datasets = o.series.map(s => {
      const asLine = lineMode || s.kind === 'line';
      const stored = o.hiddenStore ? o.hiddenStore[s.label] : undefined;
      const base = { label: s.label, data: s.data, hidden: stored !== undefined ? stored : !!s.hidden, order: asLine ? 0 : 1 };
      if (asLine) {
        return Object.assign(base, {
          type: 'line', borderColor: s.color, backgroundColor: s.fillColor || (s.color + '26'),
          borderWidth: 2.2, tension: 0.3, fill: !!s.fill,
          pointRadius: o.labels.length > 40 ? 0 : 3, pointHoverRadius: 5, pointBackgroundColor: s.color
        });
      }
      return Object.assign(base, {
        type: 'bar', backgroundColor: s.colors || s.color, borderRadius: 4, borderSkipped: false, maxBarThickness: 30
      });
    });
    const horizontal = !!o.horizontal;
    const valueTicks = { callback: v => (o.tickFmt || fmtCompact)(v), maxTicksLimit: 6 };
    const scales = horizontal
      ? { x: { beginAtZero: true, grid: { color: COL.grid }, border: { display: false }, ticks: valueTicks },
          y: { grid: { display: false }, ticks: { autoSkip: false } } }
      : { x: { grid: { display: false }, ticks: { maxRotation: 0, autoSkip: true, maxTicksLimit: o.maxTicks || 12 } },
          y: { beginAtZero: true, grid: { color: COL.grid }, border: { display: false }, ticks: valueTicks } };
    return {
      type: lineMode ? 'line' : 'bar',
      data: { labels: o.labels, datasets },
      options: {
        indexAxis: horizontal ? 'y' : 'x',
        responsive: true, maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        layout: { padding: { top: 4 } },
        scales,
        plugins: {
          legend: {
            display: o.series.length > 1, position: 'top', align: 'start',
            labels: { usePointStyle: true, boxWidth: 8, boxHeight: 8, padding: 14, sort: (a, b) => a.datasetIndex - b.datasetIndex },
            onClick(e, item, legend) {
              Chart.defaults.plugins.legend.onClick.call(this, e, item, legend);
              if (o.hiddenStore) o.hiddenStore[item.text] = !legend.chart.isDatasetVisible(item.datasetIndex);
            }
          },
          tooltip: {
            backgroundColor: COL.ink, padding: 10, cornerRadius: 8, titleFont: { weight: '600' }, boxPadding: 4,
            itemSort: (a, b) => a.datasetIndex - b.datasetIndex,
            callbacks: { label: c => ` ${c.dataset.label}: ${(o.fmt || fmtEur)(horizontal ? c.parsed.x : c.parsed.y)}` }
          }
        },
        onClick: (evt, els, chart) => {
          if (!o.onPick) return;
          const hit = chart.getElementsAtEventForMode(evt.native || evt, 'index', { intersect: false }, true);
          if (hit.length) o.onPick(hit[0].index);
        },
        onHover: (evt, els, chart) => {
          if (!o.onPick || !evt.native) return;
          const hit = chart.getElementsAtEventForMode(evt.native, 'index', { intersect: false }, true);
          evt.native.target.style.cursor = hit.length ? 'pointer' : 'default';
        }
      }
    };
  }

  const centerPlugin = {
    id: 'centerText',
    afterDraw(chart, args, opts) {
      if (!opts || !opts.valueText) return;
      const meta = chart.getDatasetMeta(0);
      if (!meta || !meta.data.length) return;
      const { x, y } = meta.data[0];
      const ctx = chart.ctx;
      ctx.save();
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillStyle = COL.soft; ctx.font = "600 10px 'IBM Plex Mono', monospace";
      ctx.fillText((opts.title || 'Totale').toUpperCase(), x, y - 12);
      ctx.fillStyle = COL.ink; ctx.font = "700 17px 'Source Serif 4', serif";
      ctx.fillText(opts.valueText, x, y + 8);
      ctx.restore();
    }
  };

  // Raggruppa le voci minori in "Altre" (le prime max-1 restano, il resto si somma)
  function collapse(items, max) {
    const sorted = items.filter(i => i.value > 0).sort((a, b) => b.value - a.value);
    if (sorted.length <= max) return { main: sorted, rest: [] };
    return { main: sorted.slice(0, max - 1), rest: sorted.slice(max - 1) };
  }
  function donutData(items, max) {
    const { main, rest } = collapse(items, max);
    const labels = main.map(i => i.label), values = main.map(i => i.value);
    const colors = main.map((_, i) => PALETTE[i % PALETTE.length]);
    if (rest.length) { labels.push('Altre'); values.push(rest.reduce((a, b) => a + b.value, 0)); colors.push(COL.other); }
    return { labels, values, colors, rest, total: values.reduce((a, b) => a + b, 0) };
  }
  function donutCfg(d, o) {
    return {
      type: 'doughnut',
      data: { labels: d.labels, datasets: [{ data: d.values, backgroundColor: d.colors, borderColor: '#fff', borderWidth: 2, hoverOffset: 6 }] },
      plugins: [centerPlugin],
      options: {
        responsive: true, maintainAspectRatio: false, cutout: '60%', layout: { padding: 6 },
        plugins: {
          legend: { position: 'bottom', labels: { usePointStyle: true, boxWidth: 8, boxHeight: 8, padding: 10 } },
          tooltip: {
            backgroundColor: COL.ink, padding: 10, cornerRadius: 8,
            callbacks: {
              label: c => {
                const tot = c.dataset.data.reduce((a, b) => a + b, 0);
                return ` ${c.label}: ${fmtEur(c.parsed)} (${(c.parsed / tot * 100).toFixed(1)}%)`;
              }
            }
          },
          centerText: { title: o.centerLabel || 'Totale', valueText: fmtCompact(d.total) }
        },
        onClick: (evt, els) => { if (els.length && o.onPick) o.onPick(d.labels[els[0].index]); },
        onHover: (evt, els) => { if (o.onPick && evt.native) evt.native.target.style.cursor = els.length ? 'pointer' : 'default'; }
      }
    };
  }

  /* ---------- pannello di dettaglio ---------- */
  function panelHtml(p) {
    const charts = (p.charts || []).map(c => `
      <div class="ck-sub">
        ${c.title ? `<div class="ck-sub-title">${esc(c.title)}</div>` : ''}
        <div class="ck-box" style="height:${c.height || 220}px"><canvas></canvas></div>
      </div>`).join('');
    return `<div class="ck-drill-head">
        <div class="ck-drill-title">${esc(p.title || 'Dettaglio')}</div>
        <button type="button" class="ck-close">✕ chiudi</button>
      </div>${charts}${p.note ? `<div class="chart-note">${p.note}</div>` : ''}`;
  }
  function panelCfg(c) {
    if (c.kind === 'donut') return donutCfg(donutData(c.items, 7), { centerLabel: c.centerLabel });
    if (c.kind === 'hbars') {
      return barLineCfg({ labels: c.labels, series: [{ label: c.label || 'Valore', color: c.color || COL.usc, data: c.values }], type: 'bar', horizontal: true });
    }
    return barLineCfg({ labels: c.labels, series: c.series, type: 'bar', fmt: c.fmt, tickFmt: c.tickFmt });
  }

  function openDrill(hostId, key, silent) {
    const host = document.getElementById(hostId);
    const s = STATE[hostId];
    if (!host || !s || !s.pick) return;
    const box = host.querySelector('.ck-drill');
    if (!box) return;
    killDrill(hostId);
    const panel = s.pick(key);
    if (!panel) { box.innerHTML = ''; s.drill = null; return; }
    s.drill = key;
    box.innerHTML = panelHtml(panel);
    box.querySelector('.ck-close').addEventListener('click', () => { killDrill(hostId); box.innerHTML = ''; s.drill = null; });
    const canvases = box.querySelectorAll('canvas');
    (panel.charts || []).forEach((c, i) => { if (canvases[i]) mk(hostId + '#d' + i, canvases[i], panelCfg(c)); });
    if (!silent) box.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  /* ---------- controlli (periodo, tipo) ---------- */
  function ctrlHtml(spec, uniq, from, to, s) {
    const c = Object.assign({ range: true, type: true }, spec.controls || {});
    let h = '';
    const n = uniq.length;
    if (c.range && n > 3) {
      const chips = [['Tutto', n]];
      [10, 5, 3].forEach(k => { if (k < n) chips.push([k + ' anni', k]); });
      chips.sort((a, b) => b[1] - a[1]);
      h += '<div class="ck-chips">' + chips.map(([lab, k]) => {
        const f = k >= n ? uniq[0] : uniq[n - k];
        const on = from === f && to === uniq[n - 1];
        return `<button type="button" data-ck="chip" data-n="${k}" class="${on ? 'on' : ''}">${lab}</button>`;
      }).join('') + '</div>';
      const opts = sel => uniq.map(y => `<option value="${y}"${y === sel ? ' selected' : ''}>${y}</option>`).join('');
      h += `<div class="ck-range"><select data-ck="from" aria-label="Da">${opts(from)}</select><span>→</span><select data-ck="to" aria-label="A">${opts(to)}</select></div>`;
    }
    if (c.type) {
      h += `<div class="ck-type"><button type="button" data-ck="type" data-v="bar" class="${s.type === 'bar' ? 'on' : ''}">Barre</button>` +
           `<button type="button" data-ck="type" data-v="line" class="${s.type === 'line' ? 'on' : ''}">Linee</button></div>`;
    }
    return h ? `<div class="ck-ctrl">${h}</div>` : '';
  }
  function wireCtrl(host, again, uniq, s) {
    const ctrl = host.querySelector('.ck-ctrl');
    if (!ctrl) return;
    ctrl.addEventListener('click', e => {
      const b = e.target.closest('button[data-ck]');
      if (!b) return;
      if (b.dataset.ck === 'chip') {
        const k = +b.dataset.n;
        s.from = k >= uniq.length ? null : uniq[uniq.length - k];
        s.to = null;
      } else if (b.dataset.ck === 'type') {
        s.type = b.dataset.v;
      }
      again();
    });
    ctrl.addEventListener('change', e => {
      const sel = e.target.closest('select[data-ck]');
      if (!sel) return;
      const v = +sel.value;
      if (sel.dataset.ck === 'from') { s.from = v; if (s.to != null && s.to < v) s.to = v; }
      else { s.to = v; if (s.from != null && s.from > v) s.from = v; }
      again();
    });
  }

  /* ---------- API: barre/linee con periodo ---------- */
  function yearly(hostId, spec) {
    const host = document.getElementById(hostId);
    if (!host) return;
    killHost(hostId);
    if (!hasChart()) { host.innerHTML = fallback; return; }
    const s = st(hostId, { type: spec.defaultType || 'bar' });
    s.pick = spec.onPick || null;

    const itemYears = spec.itemYears || spec.keys;
    if (!itemYears.length) { s.pick = null; host.innerHTML = '<div class="ck-empty">Nessun dato da mostrare.</div>'; return; }
    const uniq = [...new Set(itemYears)].sort((a, b) => a - b);
    if (s.from != null && !uniq.includes(s.from)) s.from = null;
    if (s.to != null && !uniq.includes(s.to)) s.to = null;
    const from = s.from != null ? s.from : uniq[0];
    const to = s.to != null ? s.to : uniq[uniq.length - 1];
    const idx = [];
    itemYears.forEach((y, i) => { if (y >= from && y <= to) idx.push(i); });
    const pick = arr => idx.map(i => arr[i]);
    const keys = pick(spec.keys);

    host.innerHTML = ctrlHtml(spec, uniq, from, to, s) +
      `<div class="ck-box" style="height:${spec.height || 260}px"><canvas></canvas></div>` +
      (spec.onPick ? `<div class="ck-hint">${spec.hint || 'Tocca una barra per il dettaglio'}</div>` : '') +
      '<div class="ck-drill"></div>';
    wireCtrl(host, () => yearly(hostId, spec), uniq, s);

    const cfg = barLineCfg({
      labels: pick(spec.labels),
      series: spec.series.map(sr => Object.assign({}, sr, { data: pick(sr.data), colors: sr.colors ? pick(sr.colors) : undefined })),
      type: s.type, fmt: spec.fmt, tickFmt: spec.tickFmt, maxTicks: spec.maxTicks,
      hiddenStore: s.hidden,
      onPick: spec.onPick ? (i => openDrill(hostId, keys[i])) : null
    });
    mk(hostId, host.querySelector('canvas'), cfg);
    if (spec.onPick && s.drill != null && keys.includes(s.drill)) openDrill(hostId, s.drill, true);
  }

  /* ---------- API: ciambella ---------- */
  function donut(hostId, spec) {
    const host = document.getElementById(hostId);
    if (!host) return;
    killHost(hostId);
    if (!hasChart()) { host.innerHTML = fallback; return; }
    const s = st(hostId);
    const d = donutData(spec.items || [], spec.maxSlices || 8);
    if (!d.values.length) { s.pick = null; host.innerHTML = ''; return; }
    const restPanel = () => ({
      title: 'Altre categorie',
      charts: [{ kind: 'hbars', labels: d.rest.map(r => r.label), values: d.rest.map(r => r.value), color: COL.other,
                 height: Math.max(150, d.rest.length * 30 + 40) }]
    });
    s.pick = key => (key === 'Altre' ? restPanel() : (spec.onPick ? spec.onPick(key) : null));
    host.innerHTML = `<div class="ck-box" style="height:${spec.height || 320}px"><canvas></canvas></div>` +
      `<div class="ck-hint">${spec.hint || 'Tocca una fetta o una voce dell\u2019elenco per il dettaglio'}</div><div class="ck-drill"></div>`;
    mk(hostId, host.querySelector('canvas'), donutCfg(d, { centerLabel: spec.centerLabel, onPick: key => openDrill(hostId, key) }));
    if (s.drill != null) openDrill(hostId, s.drill, true);
  }

  function clear(hostId) { killHost(hostId); const h = document.getElementById(hostId); if (h) h.innerHTML = ''; if (STATE[hostId]) STATE[hostId].pick = null; }

  return { yearly, donut, openDrill, clear, COL };
})();
