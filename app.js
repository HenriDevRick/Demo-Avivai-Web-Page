/**
 * app.js — Aviva Resorts | Portal do Hóspede
 *
 * Autenticação: Custom Bearer Grant Flow (grantType = customBearer)
 * Padrão oficial Pega para portais de intranet sem tela de login.
 * Referência: https://support.pega.com/discussion/configuration-web-embed
 *
 * Módulos:
 *   1.  Config       — case types, metadados de tab, emojis, constantes
 *   2.  State        — estado global centralizado
 *   3.  DOM          — referências cacheadas ao DOM
 *   4.  Auth         — obtenção silenciosa do access token via customBearer
 *   5.  PegaSDK      — detecção do custom element pega-embed
 *   6.  PegaEmbed    — criação e ciclo de vida do embed
 *   7.  Tabs         — troca de abas
 *   8.  Loader       — overlay de carregamento
 *   9.  ErrorPanel   — tela de erro e retry
 *   10. Success      — telas de conclusão + partículas
 *   11. Toast        — notificações temporárias
 *   12. Init         — bootstrap no DOMContentLoaded
 */

'use strict';

/* ============================================================
   1. CONFIG
   ============================================================ */

const PEGA_SERVER = 'https://adqura02.pegalabs.io/prweb/';

/**
 * Credenciais para o Custom Bearer Grant Flow.
 *
 * ⚠️  Visíveis no DevTools — adequado para intranet controlada.
 *     Em produção pública, use Authorization Code + OIDC/SSO.
 *
 * Como funciona:
 *   1. O JS faz um POST no endpoint /token com user + password.
 *   2. O Pega valida e devolve um access_token OAuth 2.0.
 *   3. O token é passado ao pega-embed via atributo `authToken`.
 *   4. O embed já nasce autenticado — sem tela de login.
 */
const PEGA_AUTH = Object.freeze({
  user:     'rafael.aviva.demo@gmail.com',
  password: 'rules12345!@',
  // clientId do OAuth 2.0 Client Registration gerado pelo App Studio
  // (o mesmo clientId já usado nos embeds abaixo)
  // Cada case type tem seu próprio clientId — usamos o do BookingConfirmation
  // para o login inicial; o token é válido para toda a sessão.
  clientId: '12444249209306947994',
});

/** Case types e clientIds por aba */
const CASE_MAP = Object.freeze({
  BookingConfirmation: {
    caseTypeID: 'Aviva-Experience-Work-BookingConfirmation',
    clientId:   '12444249209306947994',
  },
  CheckIn: {
    caseTypeID: 'Aviva-Experience-Work-CheckinDigital',
    clientId:   '55966357118681751596',
  },
  CheckOut: {
    caseTypeID: 'Aviva-Experience-Work-CheckoutDigital',
    clientId:   '13673903982745833564',
  },
});

/** Metadados visuais do loader por aba */
const TAB_META = Object.freeze({
  BookingConfirmation: {
    loaderIcon: 'fa-file-lines',
    loaderText: 'Abrindo sua reserva...',
    loaderGrad: 'linear-gradient(135deg, #0084ff, #00aeef)',
  },
  CheckIn: {
    loaderIcon: 'fa-right-to-bracket',
    loaderText: 'Preparando o check-in...',
    loaderGrad: 'linear-gradient(135deg, #00a859, #8dc63f)',
  },
  CheckOut: {
    loaderIcon: 'fa-right-from-bracket',
    loaderText: 'Iniciando o check-out...',
    loaderGrad: 'linear-gradient(135deg, #f39200, #ffd200)',
  },
});

const SUCCESS_SCREEN_ID = Object.freeze({
  BookingConfirmation: 'success-reserva',
  CheckIn:             'success-checkin',
  CheckOut:            'success-checkout',
});

const SUCCESS_TOAST_MSG = Object.freeze({
  BookingConfirmation: '🎉 Reserva confirmada!',
  CheckIn:             '🏖️ Check-in realizado com sucesso!',
  CheckOut:            '🌅 Check-out concluído. Até breve!',
});

const FLOATIE_EMOJIS = Object.freeze({
  BookingConfirmation: ['🎉','✨','🌴','🏝️','⭐','🌟','🥂','🎊'],
  CheckIn:             ['🏖️','🌊','🍹','🌺','☀️','🦜','🌸','🐚'],
  CheckOut:            ['🌅','💙','🌸','✈️','🙏','⭐','🎶','🌙'],
});

const PEGA_POLL_INTERVAL_MS  = 150;   // intervalo do polling do SDK
const PEGA_SDK_TIMEOUT_MS    = 8000;  // timeout máximo aguardando o SDK
const PEGA_READY_TIMEOUT_MS  = 12000; // timeout fallback do pega-embed-ready
const TOAST_DURATION_MS      = 4500;
const FLOATIE_COUNT          = 22;


/* ============================================================
   2. STATE
   ============================================================ */

const state = {
  activeCaseType:     null,  // chave do case type ativo
  accessToken:        null,  // token OAuth reutilizado na sessão
  tokenExpiresAt:     0,     // timestamp (ms) de expiração do token
  sdkPollTimer:       null,  // handle do setInterval do SDK
  readyFallbackTimer: null,  // handle do setTimeout de fallback
};


/* ============================================================
   3. DOM — cache único no init()
   ============================================================ */

const dom = {};

function cacheDom() {
  dom.tabButtons      = document.querySelectorAll('.tab-btn');
  dom.pegaPanel       = document.getElementById('pega-panel');
  dom.loader          = document.getElementById('js-loader');
  dom.loaderIcon      = document.getElementById('js-loader-icon');
  dom.loaderIconEl    = dom.loaderIcon.querySelector('i');
  dom.loaderText      = document.getElementById('js-loader-text');
  dom.errorPanel      = document.getElementById('js-error');
  dom.retryBtn        = document.getElementById('js-retry');
  dom.pegaPlaceholder = document.getElementById('js-pega-placeholder');
  dom.toastContainer  = document.getElementById('js-toast-container');
  dom.todayDateEls    = document.querySelectorAll('.js-today-date');
}


/* ============================================================
   4. AUTH — Custom Bearer Grant Flow
   ============================================================
   Fluxo oficial do Pega para portais sem tela de login:
   POST /PRRestService/oauth2/v1/token
     grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer  (customBearer)
     client_id=<id do OAuth Client Registration>
     username=<operador Pega>
     password=<senha do operador>

   O Pega valida e retorna { access_token, expires_in, ... }.
   Esse token é passado ao <pega-embed> via atributo `authToken`,
   eliminando completamente a tela de login.

   O token é cacheado no state e reutilizado até 60 s antes
   do vencimento, evitando requisições desnecessárias.
   ============================================================ */

const Auth = {

  /** Retorna true se o token cacheado ainda é válido */
  _isTokenValid() {
    return (
      state.accessToken !== null &&
      Date.now() < state.tokenExpiresAt - 60_000  // margem de 60 s
    );
  },

  /**
   * Obtém (ou reutiliza) o access token via Custom Bearer.
   * @returns {Promise<string|null>}  token ou null em caso de falha
   */
  async getToken() {
    if (this._isTokenValid()) {
      return state.accessToken;
    }

    const endpoint = `${PEGA_SERVER}PRRestService/oauth2/v1/token`;

    const body = new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      client_id:  PEGA_AUTH.clientId,
      username:   PEGA_AUTH.user,
      password:   PEGA_AUTH.password,
    });

    try {
      const res = await fetch(endpoint, {
        method:      'POST',
        credentials: 'include',
        headers:     { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
      });

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        console.error(`[Aviva Auth] Falha HTTP ${res.status}:`, text);
        return null;
      }

      const data = await res.json();

      if (!data.access_token) {
        console.error('[Aviva Auth] Resposta sem access_token:', data);
        return null;
      }

      // Cacheia o token e sua expiração
      state.accessToken    = data.access_token;
      state.tokenExpiresAt = Date.now() + (data.expires_in ?? 3600) * 1000;

      console.info('[Aviva Auth] Token obtido com sucesso.');
      return state.accessToken;

    } catch (err) {
      console.error('[Aviva Auth] Erro na requisição de token:', err);
      return null;
    }
  },
};


/* ============================================================
   5. PEGA SDK — aguarda o custom element ser registrado
   ============================================================ */

/**
 * Resolve true quando pega-embed estiver registrado, false se timeout.
 * @returns {Promise<boolean>}
 */
function waitForPegaSdk() {
  return new Promise((resolve) => {
    if (customElements.get('pega-embed')) {
      resolve(true);
      return;
    }

    const start = Date.now();

    state.sdkPollTimer = setInterval(() => {
      if (customElements.get('pega-embed')) {
        clearInterval(state.sdkPollTimer);
        resolve(true);
        return;
      }
      if (Date.now() - start >= PEGA_SDK_TIMEOUT_MS) {
        clearInterval(state.sdkPollTimer);
        resolve(false);
      }
    }, PEGA_POLL_INTERVAL_MS);
  });
}


/* ============================================================
   6. PEGA EMBED — criação e ciclo de vida
   ============================================================ */

/**
 * Obtém o token, cria o <pega-embed> com authToken já preenchido
 * e o injeta no placeholder. O embed nasce autenticado.
 *
 * @param {string} caseType — chave em CASE_MAP
 */
async function renderEmbed(caseType) {
  // 1. Obtém o access token silenciosamente
  const token = await Auth.getToken();

  if (!token) {
    Loader.hide();
    ErrorPanel.show(
      'Não foi possível autenticar automaticamente. ' +
      'Verifique as credenciais ou contate o suporte.'
    );
    return;
  }

  // 2. Limpa embed anterior
  dom.pegaPlaceholder.innerHTML = '';

  const cfg   = CASE_MAP[caseType];
  const embed = document.createElement('pega-embed');

  // ── Atributos padrão ──
  embed.setAttribute('id',               'theEmbed');
  embed.setAttribute('action',           'createCase');
  embed.setAttribute('caseTypeID',       cfg.caseTypeID);
  embed.setAttribute('clientId',         cfg.clientId);
  embed.setAttribute('appAlias',         'aviva--experincia-do-hspede-1');
  embed.setAttribute('pegaServerUrl',    PEGA_SERVER);
  embed.setAttribute('themeID',          'pzCosmosDefault');
  embed.setAttribute('casePage',         'assignment');
  embed.setAttribute('assignmentHeader', 'false');
  embed.setAttribute('autoReauth',       'true');

  // ── Chave do Custom Bearer: grantType + authToken ──
  // grantType=customBearer instrui o SDK a usar o token fornecido
  // em vez de redirecionar para a tela de login do Pega.
  embed.setAttribute('grantType',  'customBearer');
  embed.setAttribute('authToken',  token);

  embed.style.width   = '100%';
  embed.style.display = 'block';

  // ── Eventos do ciclo de vida ──
  embed.addEventListener('pega-embed-ready', () => {
    clearTimeout(state.readyFallbackTimer);
    Loader.hide();
  });

  embed.addEventListener('pega-case-submitted', () => {
    clearTimeout(state.readyFallbackTimer);
    Loader.hide();
    Success.show(caseType);
  });

  embed.addEventListener('error', (evt) => {
    console.error('[Aviva] pega-embed error:', evt);
    clearTimeout(state.readyFallbackTimer);
    Loader.hide();
    ErrorPanel.show();
  });

  dom.pegaPlaceholder.appendChild(embed);

  // Fallback: esconde o loader mesmo se o Pega não disparar o evento
  state.readyFallbackTimer = setTimeout(
    () => Loader.hide(),
    PEGA_READY_TIMEOUT_MS
  );
}


/* ============================================================
   7. TABS
   ============================================================ */

const Tabs = {
  async load(caseType, tabIndex) {
    if (caseType === state.activeCaseType) return;
    state.activeCaseType = caseType;

    Success.hideAll();
    ErrorPanel.hide();
    Loader.show(caseType);

    // Atualiza visual e ARIA
    dom.tabButtons.forEach((btn, i) => {
      const active = i === tabIndex;
      btn.classList.toggle('active', active);
      btn.setAttribute('aria-selected', String(active));
    });

    dom.pegaPanel?.setAttribute(
      'aria-labelledby',
      dom.tabButtons[tabIndex]?.id ?? ''
    );

    // Verifica SDK
    const sdkOk = await waitForPegaSdk();
    if (!sdkOk) {
      Loader.hide();
      ErrorPanel.show('O SDK do Pega não carregou. Verifique sua conexão.');
      return;
    }

    renderEmbed(caseType);
  },

  activeIndex() {
    return [...dom.tabButtons].findIndex(b => b.classList.contains('active'));
  },

  reload() {
    const prev  = state.activeCaseType;
    const index = this.activeIndex();
    // Invalida token para forçar novo auth no retry
    state.accessToken    = null;
    state.tokenExpiresAt = 0;
    state.activeCaseType = null;
    this.load(prev, index);
  },
};


/* ============================================================
   8. LOADER
   ============================================================ */

const Loader = {
  _fadeTimer: null,

  show(caseType) {
    const meta = TAB_META[caseType] || TAB_META.BookingConfirmation;
    dom.loaderIconEl.className      = `fa-solid ${meta.loaderIcon}`;
    dom.loaderIcon.style.background = meta.loaderGrad;
    dom.loaderText.textContent      = meta.loaderText;

    clearTimeout(this._fadeTimer);
    dom.loader.style.display    = 'flex';
    dom.loader.style.opacity    = '1';
    dom.loader.style.pointerEvents = 'all';
    dom.loader.classList.remove('is-hidden');
  },

  hide() {
    dom.loader.classList.add('is-hidden');
    dom.loader.style.pointerEvents = 'none';
    this._fadeTimer = setTimeout(() => {
      dom.loader.style.display = 'none';
    }, 420);
  },
};


/* ============================================================
   9. ERROR PANEL
   ============================================================ */

const ErrorPanel = {
  show(msg) {
    const p = dom.errorPanel.querySelector('p');
    if (p && msg) p.textContent = msg;
    dom.errorPanel.style.display = 'flex';
    Toast.show(msg || 'Erro ao carregar o serviço. Tente novamente.', 'error');
  },

  hide() {
    dom.errorPanel.style.display = 'none';
  },
};


/* ============================================================
   10. SUCCESS
   ============================================================ */

const Success = {
  show(caseType) {
    dom.pegaPlaceholder.innerHTML = '';

    const screenId = SUCCESS_SCREEN_ID[caseType];
    const screen   = screenId ? document.getElementById(screenId) : null;

    if (!screen) {
      console.warn(`[Aviva] Tela de sucesso não encontrada: ${caseType}`);
      return;
    }

    screen.style.display = 'flex';
    void screen.offsetHeight; // força reflow para disparar a animação
    screen.classList.add('is-visible');

    spawnFloaties(caseType, screen.querySelector('.floaties'));
    Toast.show(SUCCESS_TOAST_MSG[caseType] || 'Processo concluído!', 'success');
  },

  hideAll() {
    document.querySelectorAll('.success-screen').forEach(s => {
      s.classList.remove('is-visible');
      s.style.display = 'none';
      const f = s.querySelector('.floaties');
      if (f) f.innerHTML = '';
    });
    state.activeCaseType = null;
  },
};

function spawnFloaties(caseType, container) {
  if (!container) return;
  container.innerHTML = '';

  const emojis   = FLOATIE_EMOJIS[caseType] || FLOATIE_EMOJIS.BookingConfirmation;
  const fragment = document.createDocumentFragment();

  for (let i = 0; i < FLOATIE_COUNT; i++) {
    const el = document.createElement('span');
    el.className  = 'floatie';
    el.textContent = emojis[Math.floor(Math.random() * emojis.length)];
    el.style.left     = `${3  + Math.random() * 94}%`;
    el.style.bottom   = `${-5 + Math.random() * 15}%`;
    el.style.fontSize = `${0.9 + Math.random() * 1.4}rem`;
    el.style.setProperty('--dur',   `${2.2 + Math.random() * 2.4}s`);
    el.style.setProperty('--delay', `${Math.random() * 1.4}s`);
    fragment.appendChild(el);
  }

  container.appendChild(fragment);
}


/* ============================================================
   11. TOAST
   ============================================================ */

const TOAST_ICONS = Object.freeze({
  info:    'fa-circle-info',
  success: 'fa-circle-check',
  error:   'fa-circle-xmark',
});

const Toast = {
  show(message, type = 'info', duration = TOAST_DURATION_MS) {
    const icon  = TOAST_ICONS[type] ?? TOAST_ICONS.info;
    const toast = document.createElement('div');
    toast.className = `toast toast--${type}`;
    toast.innerHTML = `<i class="fa-solid ${icon}" aria-hidden="true"></i> ${message}`;
    toast.setAttribute('role', 'alert');
    dom.toastContainer.appendChild(toast);

    setTimeout(() => {
      toast.style.transition = 'opacity 0.3s ease, transform 0.3s ease';
      toast.style.opacity    = '0';
      toast.style.transform  = 'translateX(20px)';
      setTimeout(() => toast.remove(), 320);
    }, duration);
  },
};


/* ============================================================
   12. INIT
   ============================================================ */

function bindEvents() {
  // Tabs
  dom.tabButtons.forEach(btn => {
    btn.addEventListener('click', () => {
      Tabs.load(btn.dataset.case, Number(btn.dataset.index));
    });
  });

  // Retry
  dom.retryBtn?.addEventListener('click', () => Tabs.reload());

  // Botões nas telas de sucesso (delegação de eventos)
  document.addEventListener('click', evt => {
    const gotoBtn = evt.target.closest('button[data-goto-case]');
    if (gotoBtn) {
      Success.hideAll();
      Tabs.load(gotoBtn.dataset.gotoCase, Number(gotoBtn.dataset.gotoIndex));
      return;
    }
    if (evt.target.closest('button.js-back-btn')) {
      Success.hideAll();
    }
  });
}

function fillTodayDates() {
  const today = new Date().toLocaleDateString('pt-BR', {
    day: '2-digit', month: 'short', year: 'numeric',
  });
  dom.todayDateEls.forEach(el => { el.textContent = today; });
}

function init() {
  cacheDom();
  fillTodayDates();
  bindEvents();

  // Garante que loader, erro e telas de sucesso começam ocultos via JS
  dom.loader.style.display     = 'none';
  dom.errorPanel.style.display = 'none';
  document.querySelectorAll('.success-screen').forEach(s => {
    s.style.display = 'none';
  });

  // Carrega a primeira aba — o Auth.getToken() será chamado aqui
  Tabs.load('BookingConfirmation', 0);
}

document.addEventListener('DOMContentLoaded', init);
