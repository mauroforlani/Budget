/* =========================================================================
   github-sync.js
   Gestisce la persistenza dei dati su un repository GitHub tramite le
   GitHub Contents API (https://docs.github.com/en/rest/repos/contents).

   Configurazione (owner, repo, branch, percorso file dati, token) salvata
   in localStorage del browser: NON viene mai inviata altrove.

   Espone l'oggetto globale `GitHubSync` con:
     - GitHubSync.init()                 -> inizializza pannello + stato
     - GitHubSync.isConfigured()         -> bool
     - GitHubSync.loadData()             -> Promise<object|null> (dati da GitHub, o null se non configurato/non trovato)
     - GitHubSync.saveData(obj, message) -> Promise<boolean> (salva/aggiorna il file dati)
   ========================================================================= */

const GitHubSync = (() => {
  const CONFIG_KEY = 'finanze_gh_config_v1';
  const DEFAULT_PATH = 'data.json';

  function getConfig() {
    try {
      const raw = localStorage.getItem(CONFIG_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (e) { return null; }
  }

  function setConfig(cfg) {
    localStorage.setItem(CONFIG_KEY, JSON.stringify(cfg));
  }

  function clearConfig() {
    localStorage.removeItem(CONFIG_KEY);
  }

  function isConfigured() {
    const c = getConfig();
    return !!(c && c.token && c.owner && c.repo);
  }

  function apiUrl(path, branch) {
    const c = getConfig();
    return `https://api.github.com/repos/${c.owner}/${c.repo}/contents/${path}${branch ? `?ref=${encodeURIComponent(branch)}` : ''}`;
  }

  function b64EncodeUnicode(str) {
    return btoa(encodeURIComponent(str).replace(/%([0-9A-F]{2})/g,
      (m, p1) => String.fromCharCode('0x' + p1)));
  }
  function b64DecodeUnicode(str) {
    return decodeURIComponent(atob(str.replace(/\n/g, '')).split('').map(c =>
      '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2)).join(''));
  }

  function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

  // Su reti mobili una singola richiesta può fallire per un intoppo
  // momentaneo (cambio WiFi/dati, rete lenta, app in background un istante).
  // Qui riproviamo automaticamente SOLO sugli errori di rete veri e propri
  // (fetch() che lancia un'eccezione): un 404/401/403 è una risposta valida
  // di GitHub e non va ritentato, perché non cambierebbe riprovando.
  async function fetchWithRetry(url, options, attempts = 3) {
    let lastErr;
    for (let i = 0; i < attempts; i++) {
      try {
        return await fetch(url, options);
      } catch (err) {
        lastErr = err;
        if (i < attempts - 1) await sleep(500 * (i + 1));
      }
    }
    throw lastErr;
  }

  function repoApiUrl(c) {
    return `https://api.github.com/repos/${c.owner}/${c.repo}`;
  }

  // Verifica se il repository esiste ed è accessibile con questo token,
  // PRIMA di provare a leggere/scrivere il file dati: restituisce un esito
  // con una causa precisa, invece del generico 404 dell'endpoint "contents"
  // (che GitHub usa sia per "repository inesistente" sia per "file non ancora presente").
  async function checkRepoAccess(c) {
    try {
      const res = await fetchWithRetry(repoApiUrl(c), {
        headers: { 'Authorization': `token ${c.token}`, 'Accept': 'application/vnd.github+json' }
      });
      if (res.status === 404) return { ok: false, reason: 'repo_not_found' };
      if (res.status === 401) return { ok: false, reason: 'bad_token' };
      if (res.status === 403) return { ok: false, reason: 'no_access' };
      if (!res.ok) return { ok: false, reason: 'other', status: res.status };
      const json = await res.json();
      const defaultBranch = json.default_branch;
      if (c.branch && defaultBranch && c.branch !== defaultBranch) {
        // Non blocchiamo: il branch scelto potrebbe esistere comunque anche
        // se diverso da quello predefinito. Verifichiamo esplicitamente.
        const branchRes = await fetchWithRetry(
          `https://api.github.com/repos/${c.owner}/${c.repo}/branches/${encodeURIComponent(c.branch)}`,
          { headers: { 'Authorization': `token ${c.token}`, 'Accept': 'application/vnd.github+json' } }
        );
        if (branchRes.status === 404) return { ok: false, reason: 'branch_not_found' };
      }
      return { ok: true };
    } catch (e) {
      return { ok: false, reason: 'network' };
    }
  }

  function accessErrorMessage(c, result) {
    switch (result.reason) {
      case 'repo_not_found':
        return `Repository "${c.owner}/${c.repo}" non trovato con questo token.\n\nControlla che owner e nome repository siano scritti ESATTAMENTE come su GitHub (es. senza spazi in più, senza trattini lunghi "–" al posto del normale trattino "-": su alcuni telefoni la tastiera li sostituisce automaticamente).\n\nSe il repository è privato, controlla anche che il token abbia accesso a quel repository.`;
      case 'bad_token':
        return 'Token non valido, scaduto o scritto in modo errato. Generane uno nuovo da GitHub → Settings → Developer settings → Personal access tokens.';
      case 'no_access':
        return `Il token non ha i permessi per accedere a "${c.owner}/${c.repo}". Serve lo scope "repo" per i repository privati (o "public_repo" per quelli pubblici), e se il repository è di un'organizzazione potrebbe servire l'autorizzazione SSO del token.`;
      case 'branch_not_found':
        return `Il branch "${c.branch}" non esiste in questo repository. Controlla che sia scritto esattamente come su GitHub (attenzione alle maiuscole: "Main" e "main" sono branch diversi).`;
      case 'network':
        return 'Errore di connessione a GitHub. Controlla la connessione a internet e riprova.';
      default:
        return `Errore GitHub imprevisto (${result.status || '??'}). Riprova tra poco.`;
    }
  }

  let lastLoadDebug = null;

  async function loadData() {
    const c = getConfig();
    if (!c || !c.token || !c.owner || !c.repo) return null;
    setStatus('busy', 'Lettura da GitHub…');
    const url = apiUrl(c.path || DEFAULT_PATH, c.branch);
    try {
      const res = await fetchWithRetry(url, {
        headers: {
          'Authorization': `token ${c.token}`,
          'Accept': 'application/vnd.github+json'
        }
      });
      lastLoadDebug = { url, status: res.status, owner: c.owner, repo: c.repo, branch: c.branch, path: c.path };
      if (res.status === 404) {
        setStatus('ok', 'Nessun file dati su GitHub (verrà creato al primo salvataggio)');
        return null;
      }
      if (!res.ok) {
        setStatus('err', `Errore GitHub (${res.status})`);
        return null;
      }
      const json = await res.json();
      const parsed = JSON.parse(b64DecodeUnicode(json.content));
      lastKnownSha = json.sha;
      setStatus('ok', 'Dati caricati da GitHub');
      return parsed;
    } catch (err) {
      lastLoadDebug = { url, status: 'network-error', owner: c.owner, repo: c.repo, branch: c.branch, path: c.path };
      setStatus('err', 'Errore di connessione a GitHub');
      console.error(err);
      return null;
    }
  }

  let lastKnownSha = null;
  let saveQueue = Promise.resolve();

  async function fetchSha(path, branch, token, owner, repo) {
    try {
      const res = await fetchWithRetry(apiUrl(path, branch), {
        headers: { 'Authorization': `token ${token}`, 'Accept': 'application/vnd.github+json' }
      });
      if (res.ok) { const j = await res.json(); return j.sha; }
    } catch (e) { /* ignore */ }
    return undefined;
  }

  async function saveData(obj, message) {
    const c = getConfig();
    if (!c || !c.token || !c.owner || !c.repo) {
      setStatus('err', 'GitHub non collegato — modifiche solo locali');
      return false;
    }
    // Serializza le chiamate per evitare conflitti di sha in scritture ravvicinate
    saveQueue = saveQueue.then(() => doSave(c, obj, message));
    return saveQueue;
  }

  async function doSave(c, obj, message) {
    setStatus('busy', 'Salvataggio su GitHub…');
    const path = c.path || DEFAULT_PATH;
    try {
      const sha = lastKnownSha || await fetchSha(path, c.branch, c.token, c.owner, c.repo);
      const body = {
        message: message || 'Aggiornamento dati finanze',
        content: b64EncodeUnicode(JSON.stringify(obj, null, 2)),
        branch: c.branch || 'main'
      };
      if (sha) body.sha = sha;
      const res = await fetchWithRetry(apiUrl(path), {
        method: 'PUT',
        headers: {
          'Authorization': `token ${c.token}`,
          'Accept': 'application/vnd.github+json',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(body)
      });
      if (!res.ok) {
        const errBody = await res.json().catch(() => ({}));
        setStatus('err', `Salvataggio fallito (${res.status})`);
        console.error('GitHub save error', errBody);
        return false;
      }
      const j = await res.json();
      lastKnownSha = j.content ? j.content.sha : undefined;
      setStatus('ok', 'Salvato su GitHub');
      return true;
    } catch (err) {
      setStatus('err', 'Errore di connessione a GitHub');
      console.error(err);
      return false;
    }
  }

  /* ---------------- UI: stato + modale di configurazione ---------------- */
  function setStatus(kind, text) {
    const el = document.getElementById('gh-status');
    if (!el) return;
    el.classList.remove('ok', 'err', 'busy');
    if (kind) el.classList.add(kind);
    el.querySelector('.gh-status-text').textContent = text;
  }

  function injectSyncStyles() {
    if (document.getElementById('gh-sync-style')) return;
    const style = document.createElement('style');
    style.id = 'gh-sync-style';
    style.textContent = `
      .modal-actions-sync { display: flex; gap: 10px; margin-top: 4px; }
      .modal-actions-sync button { flex: 1; }
      #gh-upload { background: #2f7a4f; border-color: #235f3c; }
      #gh-upload:hover { background: #276841; }
      #gh-download { background: #2f5f9e; border-color: #244a7c; }
      #gh-download:hover { background: #274f85; }
    `;
    document.head.appendChild(style);
  }

  function injectUI() {
    injectSyncStyles();
    // Pulsante di stato nell'header
    const hdrRight = document.querySelector('.hdr-right');
    if (hdrRight && !document.getElementById('gh-status')) {
      const btn = document.createElement('button');
      btn.id = 'gh-status';
      btn.className = 'gh-status';
      btn.type = 'button';
      btn.innerHTML = `<span class="dot"></span><span class="gh-status-text">GitHub non collegato — clicca per collegare</span>`;
      btn.addEventListener('click', openModal);
      hdrRight.appendChild(btn);
    }
    // Modale
    if (!document.getElementById('gh-modal')) {
      const backdrop = document.createElement('div');
      backdrop.id = 'gh-modal';
      backdrop.className = 'modal-backdrop';
      backdrop.innerHTML = `
        <div class="modal">
          <h3>Sincronizzazione GitHub</h3>
          <p class="hint">Due pulsanti, due direzioni: <b>"Carica su GitHub"</b> invia i dati di questa pagina al repository (li sovrascrive online). <b>"Scarica da GitHub"</b> fa l'esatto contrario: sostituisce i dati di questa pagina con quelli già salvati sul repository. Nessuna delle due cose avviene mai da sola: parte solo quando premi uno dei due pulsanti. Il token viene salvato solo in questo browser (localStorage), mai altrove — su ogni dispositivo dovrai inserirlo una volta.</p>
          <label>Proprietario / organizzazione (owner)</label>
          <input type="text" id="gh-owner" placeholder="es. mario-rossi" autocapitalize="off" autocorrect="off" autocomplete="off" spellcheck="false">
          <label>Nome repository</label>
          <input type="text" id="gh-repo" placeholder="es. le-mie-finanze" autocapitalize="off" autocorrect="off" autocomplete="off" spellcheck="false">
          <label>Branch</label>
          <input type="text" id="gh-branch" placeholder="main" autocapitalize="off" autocorrect="off" autocomplete="off" spellcheck="false">
          <label>Percorso file dati</label>
          <input type="text" id="gh-path" placeholder="data.json" autocapitalize="off" autocorrect="off" autocomplete="off" spellcheck="false">
          <label>Personal Access Token (repo scope)</label>
          <input type="password" id="gh-token" placeholder="ghp_..." autocapitalize="off" autocorrect="off" autocomplete="off" spellcheck="false">
          <div class="modal-actions modal-actions-sync">
            <button class="primary" id="gh-upload" type="button">&#8593; Carica su GitHub</button>
            <button class="primary" id="gh-download" type="button">&#8595; Scarica da GitHub</button>
          </div>
          <div class="modal-actions">
            <button class="ghost" id="gh-disconnect" type="button">Disconnetti</button>
            <button class="ghost" id="gh-cancel" type="button">Chiudi</button>
          </div>
          <div class="modal-note">Il token deve avere permesso di scrittura sul repository (scope <b>repo</b> per repository privati, oppure <b>public_repo</b> per repository pubblici). Puoi generarne uno da GitHub → Settings → Developer settings → Personal access tokens.<br><br>Le modifiche fatte in questa pagina vengono comunque anche salvate automaticamente in background pochi istanti dopo ogni modifica (transazioni, importazioni, patrimonio, ecc.) — i due pulsanti servono per un salvataggio/caricamento immediato ed esplicito, utile prima di chiudere la pagina o quando passi a un altro dispositivo.</div>
        </div>`;
      document.body.appendChild(backdrop);
      document.getElementById('gh-cancel').addEventListener('click', closeModal);
      backdrop.addEventListener('click', (e) => { if (e.target === backdrop) closeModal(); });
      document.getElementById('gh-disconnect').addEventListener('click', () => {
        clearConfig();
        setStatus('', 'GitHub non collegato — clicca per collegare');
        closeModal();
      });
      function sanitizeField(v) {
        // Alcune tastiere mobili sostituiscono trattini/virgolette "dritte"
        // con le varianti tipografiche anche con autocorrect disattivato:
        // le riportiamo alla forma originale, dato che nei nomi di
        // repository/branch/percorsi GitHub contano caratteri esatti.
        return v
          .replace(/[\u2010-\u2015\u2212]/g, '-')   // trattini lunghi/brevi tipografici -> "-"
          .replace(/[\u2018\u2019\u201B]/g, "'")     // apici tipografici -> "'"
          .replace(/[\u201C\u201D\u201F]/g, '"');    // virgolette tipografiche -> '"'
      }
      function readCfgFromForm() {
        return {
          owner: sanitizeField(document.getElementById('gh-owner').value.trim()),
          repo: sanitizeField(document.getElementById('gh-repo').value.trim()),
          branch: sanitizeField(document.getElementById('gh-branch').value.trim()) || 'main',
          path: sanitizeField(document.getElementById('gh-path').value.trim()) || DEFAULT_PATH,
          token: document.getElementById('gh-token').value.trim()
        };
      }

      document.getElementById('gh-upload').addEventListener('click', async () => {
        const cfg = readCfgFromForm();
        if (!cfg.owner || !cfg.repo || !cfg.token) { alert('Compila almeno owner, repository e token.'); return; }

        const btn = document.getElementById('gh-upload');
        const originalLabel = btn.textContent;
        btn.disabled = true;
        btn.textContent = 'Verifica repository…';
        const access = await checkRepoAccess(cfg);
        btn.disabled = false;
        btn.textContent = originalLabel;
        if (!access.ok) { alert(accessErrorMessage(cfg, access)); return; }

        setConfig(cfg);
        lastKnownSha = null;
        closeModal();
        if (typeof window.pushLocalToGitHub === 'function') await window.pushLocalToGitHub();
      });

      document.getElementById('gh-download').addEventListener('click', async () => {
        const cfg = readCfgFromForm();
        if (!cfg.owner || !cfg.repo || !cfg.token) { alert('Compila almeno owner, repository e token.'); return; }

        const btn = document.getElementById('gh-download');
        const originalLabel = btn.textContent;
        btn.disabled = true;
        btn.textContent = 'Verifica repository…';
        const access = await checkRepoAccess(cfg);
        btn.disabled = false;
        btn.textContent = originalLabel;
        if (!access.ok) { alert(accessErrorMessage(cfg, access)); return; }

        if (typeof window.appHasUnsyncedChanges === 'function' && window.appHasUnsyncedChanges()) {
          const proceed = confirm(
            'Attenzione: in questa pagina ci sono modifiche che non risultano ancora caricate su GitHub.\n\n' +
            'Scaricando da GitHub, i dati di questa pagina verranno sostituiti e queste modifiche andranno perse.\n\n' +
            'Premi Annulla per tornare indietro (puoi premere prima "Carica su GitHub" per salvarle), oppure OK per scaricare comunque e perderle.'
          );
          if (!proceed) return;
        }

        setConfig(cfg);
        lastKnownSha = null;
        closeModal();
        if (typeof window.pullFromGitHub === 'function') await window.pullFromGitHub();
      });
    }
  }

  function openModal() {
    const c = getConfig() || {};
    document.getElementById('gh-owner').value = c.owner || '';
    document.getElementById('gh-repo').value = c.repo || '';
    document.getElementById('gh-branch').value = c.branch || 'main';
    document.getElementById('gh-path').value = c.path || DEFAULT_PATH;
    document.getElementById('gh-token').value = c.token || '';
    document.getElementById('gh-modal').classList.add('open');
  }
  function closeModal() {
    document.getElementById('gh-modal').classList.remove('open');
  }

  function init() {
    injectUI();
    if (isConfigured()) {
      setStatus('', 'GitHub collegato');
    } else {
      setStatus('', 'GitHub non collegato — clicca per collegare');
    }
  }

  return { init, isConfigured, loadData, saveData, getConfig, setConfig, clearConfig, openModal: () => openModal(), getLastLoadDebug: () => lastLoadDebug };
})();
