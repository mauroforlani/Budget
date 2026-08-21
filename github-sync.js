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

  function injectDangerStyles() {
    if (document.getElementById('gh-danger-style')) return;
    const style = document.createElement('style');
    style.id = 'gh-danger-style';
    style.textContent = `
      .gh-danger-zone { margin-top: 18px; border-top: 1px solid rgba(150,60,60,0.25); padding-top: 12px; }
      .gh-danger-zone summary { cursor: pointer; font-size: 12.5px; font-weight: 600; color: #b23b3b; user-select: none; }
      .gh-danger-zone summary:hover { text-decoration: underline; }
      .gh-danger-hint.gh-danger-hint { color: #8a2f2f; }
      button.danger { background: #b23b3b; color: #fff; border: 1px solid #8a2f2f; }
      button.danger:hover { background: #9c3333; }
    `;
    document.head.appendChild(style);
  }

  function injectUI() {
    injectDangerStyles();
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
            <button class="primary" id="gh-save" type="button">Connetti e carica da GitHub</button>
          </div>
          <div class="modal-note">Il token deve avere permesso di scrittura sul repository (scope <b>repo</b> per repository privati, oppure <b>public_repo</b> per repository pubblici). Puoi generarne uno da GitHub → Settings → Developer settings → Personal access tokens.<br><br>Usa <b>"Connetti e carica da GitHub"</b> per riprendere i dati già salvati sul repository — è l'opzione che vuoi in praticamente tutti i casi.</div>

          <details class="gh-danger-zone">
            <summary>Zona pericolosa — sovrascrivi GitHub con i dati locali</summary>
            <p class="hint gh-danger-hint">Questa azione <b>sostituisce</b> con un nuovo commit i dati attualmente salvati sul repository, rimpiazzandoli con i dati "di partenza" contenuti nel file <code>data.js</code> di questa pagina. Usala solo se sai per certo di voler ripartire da questi dati e ignorare quelli già su GitHub — ad esempio alla primissima configurazione, quando su GitHub non c'è ancora nulla. In tutti gli altri casi rischi di cancellare dati più recenti.</p>
            <div class="modal-actions">
              <button class="danger" id="gh-save-push" type="button">Sovrascrivi GitHub con i dati di questa pagina</button>
            </div>
          </details>
        </div>`;
      document.body.appendChild(backdrop);
      document.getElementById('gh-cancel').addEventListener('click', closeModal);
      backdrop.addEventListener('click', (e) => { if (e.target === backdrop) closeModal(); });
      document.getElementById('gh-disconnect').addEventListener('click', () => {
        clearConfig();
        setStatus('', 'GitHub non configurato');
        closeModal();
      });
      function readCfgFromForm() {
        return {
          owner: document.getElementById('gh-owner').value.trim(),
          repo: document.getElementById('gh-repo').value.trim(),
          branch: document.getElementById('gh-branch').value.trim() || 'main',
          path: document.getElementById('gh-path').value.trim() || DEFAULT_PATH,
          token: document.getElementById('gh-token').value.trim()
        };
      }
      document.getElementById('gh-save').addEventListener('click', () => {
        const cfg = readCfgFromForm();
        if (!cfg.owner || !cfg.repo || !cfg.token) { alert('Compila almeno owner, repository e token.'); return; }

        if (typeof window.appHasUnsyncedChanges === 'function' && window.appHasUnsyncedChanges()) {
          const proceed = confirm(
            'Attenzione: in questa pagina ci sono modifiche (transazioni, importazioni, patrimonio, ecc.) che NON risultano ancora salvate su GitHub.\n\n' +
            'Questa azione scarica i dati dal repository e li userà al posto di quelli presenti ora in questa pagina: le modifiche non salvate andranno perse.\n\n' +
            'Premi Annulla per tornare indietro e riprovare a salvare, oppure OK se vuoi comunque scaricare i dati da GitHub e perdere le modifiche locali.'
          );
          if (!proceed) return;
        }

        setConfig(cfg);
        lastKnownSha = null;
        closeModal();
        if (typeof window.onGitHubConfigured === 'function') window.onGitHubConfigured(false);
      });
      document.getElementById('gh-save-push').addEventListener('click', async () => {
        const cfg = readCfgFromForm();
        if (!cfg.owner || !cfg.repo || !cfg.token) { alert('Compila almeno owner, repository e token.'); return; }

        const pushBtn = document.getElementById('gh-save-push');
        const originalLabel = pushBtn.textContent;
        pushBtn.disabled = true;
        pushBtn.textContent = 'Controllo dati esistenti su GitHub…';

        // Applichiamo temporaneamente la config per poter interrogare l'API
        // e sapere cosa c'è davvero sul repository PRIMA di chiedere conferma.
        const previousConfig = getConfig();
        setConfig(cfg);
        lastKnownSha = null;

        let remote = null;
        let remoteCheckFailed = false;
        try {
          remote = await loadData();
        } catch (e) {
          remoteCheckFailed = true;
        }

        pushBtn.disabled = false;
        pushBtn.textContent = originalLabel;

        const localCount = (typeof SEED_DATA !== 'undefined' && Array.isArray(SEED_DATA.transazioni)) ? SEED_DATA.transazioni.length : null;
        const remoteCount = (remote && Array.isArray(remote.transazioni)) ? remote.transazioni.length : null;

        let warning;
        if (remote === null && !remoteCheckFailed) {
          warning = `Su GitHub non risulta ancora nessun file dati: verrà creato con le ${localCount != null ? localCount : '??'} transazioni presenti in questa pagina (data.js). Questa è l'unica situazione in cui questa azione è generalmente sicura.`;
        } else if (remoteCheckFailed) {
          warning = `Non sono riuscito a verificare cosa c'è attualmente su GitHub (credenziali errate o problema di rete). Procedere alla cieca è rischioso: se sul repository ci sono già dati, verranno sostituiti con le ${localCount != null ? localCount : '??'} transazioni di questa pagina e andranno persi.`;
        } else {
          warning = `ATTENZIONE: sul repository sono già presenti ${remoteCount != null ? remoteCount : 'un numero sconosciuto di'} transazioni salvate. Questa azione le SOSTITUIRÀ con le ${localCount != null ? localCount : '??'} transazioni contenute in questa pagina (data.js), cancellando definitivamente ogni dato più recente inserito dopo l'ultimo aggiornamento di data.js.`;
        }

        const typed = prompt(
          warning + '\n\nPer confermare che vuoi procedere comunque, scrivi qui sotto la parola SOVRASCRIVI (tutto maiuscolo) e conferma:'
        );

        if (typed !== 'SOVRASCRIVI') {
          // Ripristina la configurazione precedente se l'utente annulla,
          // per non lasciare la app "agganciata" a un repo non confermato.
          if (previousConfig) setConfig(previousConfig); else clearConfig();
          lastKnownSha = null;
          setStatus('', isConfigured() ? 'GitHub configurato' : 'GitHub non configurato — clicca per collegare');
          return;
        }

        closeModal();
        if (typeof window.onGitHubConfigured === 'function') window.onGitHubConfigured(true);
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
