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

  async function loadData() {
    const c = getConfig();
    if (!c || !c.token || !c.owner || !c.repo) return null;
    setStatus('busy', 'Lettura da GitHub…');
    try {
      const res = await fetch(apiUrl(c.path || DEFAULT_PATH, c.branch), {
        headers: {
          'Authorization': `token ${c.token}`,
          'Accept': 'application/vnd.github+json'
        }
      });
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
      setStatus('err', 'Errore di connessione a GitHub');
      console.error(err);
      return null;
    }
  }

  let lastKnownSha = null;
  let saveQueue = Promise.resolve();

  async function fetchSha(path, branch, token, owner, repo) {
    try {
      const res = await fetch(apiUrl(path, branch), {
        headers: { 'Authorization': `token ${token}`, 'Accept': 'application/vnd.github+json' }
      });
      if (res.ok) { const j = await res.json(); return j.sha; }
    } catch (e) { /* ignore */ }
    return undefined;
  }

  async function saveData(obj, message) {
    const c = getConfig();
    if (!c || !c.token || !c.owner || !c.repo) {
      setStatus('err', 'GitHub non configurato — modifiche solo locali');
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
      const res = await fetch(apiUrl(path), {
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

  function injectUI() {
    // Pulsante di stato nell'header
    const hdrRight = document.querySelector('.hdr-right');
    if (hdrRight && !document.getElementById('gh-status')) {
      const btn = document.createElement('button');
      btn.id = 'gh-status';
      btn.className = 'gh-status';
      btn.type = 'button';
      btn.innerHTML = `<span class="dot"></span><span class="gh-status-text">GitHub non configurato</span>`;
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
          <p class="hint">Ogni modifica (transazioni, importazioni, patrimonio, ecc.) viene salvata automaticamente nel file <code>data.json</code> del repository indicato, tramite le GitHub Contents API. Il token viene salvato solo nel tuo browser (localStorage), mai altrove.</p>
          <label>Proprietario / organizzazione (owner)</label>
          <input type="text" id="gh-owner" placeholder="es. mario-rossi">
          <label>Nome repository</label>
          <input type="text" id="gh-repo" placeholder="es. le-mie-finanze">
          <label>Branch</label>
          <input type="text" id="gh-branch" placeholder="main">
          <label>Percorso file dati</label>
          <input type="text" id="gh-path" placeholder="data.json">
          <label>Personal Access Token (repo scope)</label>
          <input type="password" id="gh-token" placeholder="ghp_...">
          <div class="modal-actions">
            <button class="ghost" id="gh-disconnect" type="button">Disconnetti</button>
            <button class="ghost" id="gh-cancel" type="button">Annulla</button>
            <button class="primary" id="gh-save" type="button">Salva e connetti</button>
          </div>
          <div class="modal-note">Il token deve avere permesso di scrittura sul repository (scope <b>repo</b> per repository privati, oppure <b>public_repo</b> per repository pubblici). Puoi generarne uno da GitHub → Settings → Developer settings → Personal access tokens.</div>
        </div>`;
      document.body.appendChild(backdrop);
      document.getElementById('gh-cancel').addEventListener('click', closeModal);
      backdrop.addEventListener('click', (e) => { if (e.target === backdrop) closeModal(); });
      document.getElementById('gh-disconnect').addEventListener('click', () => {
        clearConfig();
        setStatus('', 'GitHub non configurato');
        closeModal();
      });
      document.getElementById('gh-save').addEventListener('click', async () => {
        const cfg = {
          owner: document.getElementById('gh-owner').value.trim(),
          repo: document.getElementById('gh-repo').value.trim(),
          branch: document.getElementById('gh-branch').value.trim() || 'main',
          path: document.getElementById('gh-path').value.trim() || DEFAULT_PATH,
          token: document.getElementById('gh-token').value.trim()
        };
        if (!cfg.owner || !cfg.repo || !cfg.token) {
          alert('Compila almeno owner, repository e token.');
          return;
        }
        setConfig(cfg);
        lastKnownSha = null;
        closeModal();
        if (typeof window.onGitHubConfigured === 'function') {
          window.onGitHubConfigured();
        }
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
      setStatus('', 'GitHub configurato');
    } else {
      setStatus('', 'GitHub non configurato — clicca per collegare');
    }
  }

  return { init, isConfigured, loadData, saveData, getConfig, setConfig, clearConfig, openModal: () => openModal() };
})();
