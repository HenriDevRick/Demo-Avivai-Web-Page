/**
 * app.js — Aviva Resorts | Portal do Hóspede
 *
 * Módulos:
 *   1. Config     — configurações de case types, metadados, emojis
 *   2. State      — estado global centralizado
 *   3. DOM        — referências cacheadas ao DOM
 *   4. PegaEmbed  — detecção do SDK e criação do embed
 *   5. Tabs       — lógica de troca de abas
 *   6. Loader     — overlay de carregamento
 *   7. ErrorPanel — tela de erro
 *   8. Success    — telas de conclusão + partículas
 *   9. Toast      — notificações temporárias
 *  10. Init       — bootstrap no DOMContentLoaded
 */

'use strict';

/* ============================================================
   1. CONFIG
   ============================================================ */

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

/** Intervalo de polling para aguardar o SDK do Pega (ms) */
const PEGA_POLL_INTERVAL_MS  = 150;
/** Tempo máximo aguardando o SDK antes de mostrar erro (ms) */
const PEGA_SDK_TIMEOUT_MS    = 8000;
/** Tempo máximo aguardando o evento pega-embed-ready (ms) */
const PEGA_READY_TIMEOUT_MS  = 10000;
/** Duração dos toasts na tela (ms) */
const TOAST_DURATION_MS      = 4500;
/** Quantidade de emojis flutuantes por tela de sucesso */
const FLOATIE_COUNT          = 22;


/* ============================================================
   2. STATE
   ============================================================ */

const state = {
  activeCaseType:    null,   // key do case type atual ou null
  sdkPollTimer:      null,   // setInterval aguardando o SDK
  readyFallbackTimer:null,   // setTimeout fallback do pega-embed-ready
};


/* ============================================================
   3. DOM — referências cacheadas (query única no init)
   ============================================================ */

const dom = {};

function cacheDom() {
  dom.tabButtons       = document.querySelectorAll('.tab-btn');
  dom.pegaPanel        = document.getElementById('pega-panel');
  dom.loader           = document.getElementById('js-loader');
  dom.loaderIcon       = document.getElementById('js-loader-icon');
  dom.loaderIconEl     = dom.loaderIcon.querySelector('i');
  dom.loaderText       = document.getElementById('js-loader-text');
  dom.errorPanel       = document.getElementById('js-error');
  dom.retryBtn         = document.getElementById('js-retry');
  dom.pegaPlaceholder  = document.getElementById('js-pega-placeholder');
  dom.toastContainer   = document.getElementById('js-toast-container');
  dom.todayDateEls     = document.querySelectorAll('.js-today-date');
}


/* ============================================================
   4. PEGA EMBED
   ============================================================ */

/**
 * Aguarda o custom element `pega-embed` ser registrado pelo SDK.
 * Usa setInterval em vez de recursão para não estourar a call stack.
 * Resolve com true se OK, false se timeout.
 *
 * @returns {Promise<boolean>}
 */
function waitForPegaSdk() {
  return new Promise((resolve) => {
    // Já disponível — resolve imediatamente
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

/**
 * Cria e injeta o elemento <pega-embed> no placeholder.
 * Conecta todos os eventos do ciclo de vida do Pega.
 *
 * @param {string} caseType — chave em CASE_MAP
 */
function renderEmbed(caseType) {
  // Limpa embed anterior
  dom.pegaPlaceholder.innerHTML = '';

  const cfg   = CASE_MAP[caseType];
  const embed = document.createElement('pega-embed');

  // Atributos exatamente como documentado pelo Pega
  embed.setAttribute('id',               'theEmbed');
  embed.setAttribute('action',           'createCase');
  embed.setAttribute('caseTypeID',       cfg.caseTypeID);
  embed.setAttribute('clientId',         cfg.clientId);
  embed.setAttribute('appAlias',         'aviva--experincia-do-hspede-1');
  embed.setAttribute('pegaServerUrl',    'https://adqura02.pegalabs.io/prweb/');
  embed.setAttribute('themeID',          'pzCosmosDefault');
  embed.setAttribute('casePage',         'assignment');
  embed.setAttribute('assignmentHeader', 'false');
  embed.setAttribute('autoReauth',       'true');
  embed.setAttribute('authService',      'pega');
  embed.style.width   = '100%';
  embed.style.display = 'block';

  // ── Eventos do ciclo de vida Pega ──
  embed.addEventListener('pega-embed-ready', () => {
    clearTimeout(state.readyFallbackTimer);
    Loader.hide();
  });

  embed.addEventListener('pega-case-submitted', () => {
    clearTimeout(state.readyFallbackTimer);
    Loader.hide();
    Success.show(caseType);
  });

  // Escuta erros genéricos do custom element
  embed.addEventListener('error', (evt) => {
    console.error('[Aviva] pega-embed error:', evt);
    clearTimeout(state.readyFallbackTimer);
    Loader.hide();
    ErrorPanel.show();
  });

  dom.pegaPlaceholder.appendChild(embed);

  // Fallback: se o Pega não disparar pega-embed-ready,
  // esconde o loader para o conteúdo aparecer de qualquer forma
  state.readyFallbackTimer = setTimeout(() => {
    Loader.hide();
  }, PEGA_READY_TIMEOUT_MS);
}


/* ============================================================
   5. TABS
   ============================================================ */

const Tabs = {
  /**
   * Carrega um case type e atualiza a UI das tabs.
   *
   * @param {string} caseType
   * @param {number} tabIndex  — índice 0-based entre .tab-btn
   */
  async load(caseType, tabIndex) {
    // Evita recarregar a aba já ativa
    if (caseType === state.activeCaseType) return;
    state.activeCaseType = caseType;

    // Limpa estados anteriores
    Success.hideAll();
    ErrorPanel.hide();
    Loader.show(caseType);

    // Atualiza visual e ARIA das tabs
    dom.tabButtons.forEach((btn, i) => {
      const isActive = i === tabIndex;
      btn.classList.toggle('active', isActive);
      btn.setAttribute('aria-selected', String(isActive));
    });

    dom.pegaPanel?.setAttribute(
      'aria-labelledby',
      dom.tabButtons[tabIndex]?.id ?? ''
    );

    // Aguarda o SDK e renderiza o embed
    const sdkReady = await waitForPegaSdk();

    if (!sdkReady) {
      Loader.hide();
      ErrorPanel.show('O SDK do Pega não pôde ser carregado. Verifique sua conexão.');
      return;
    }

    renderEmbed(caseType);
  },

  /** Índice da tab atualmente ativa */
  activeIndex() {
    return [...dom.tabButtons].findIndex(btn => btn.classList.contains('active'));
  },

  /** Recarrega a tab ativa (usado pelo botão de retry) */
  reload() {
    const prev  = state.activeCaseType;
    const index = this.activeIndex();
    state.activeCaseType = null; // reseta para forçar recarga
    this.load(prev, index);
  },
};


/* ============================================================
   6. LOADER
   ============================================================ */

const Loader = {
  _fadeTimer: null,

  show(caseType) {
    const meta = TAB_META[caseType] || TAB_META.BookingConfirmation;

    dom.loaderIconEl.className      = `fa-solid ${meta.loaderIcon}`;
    dom.loaderIcon.style.background = meta.loaderGrad;
    dom.loaderText.textContent      = meta.loaderText;

    // Cancela qualquer fade pendente
    clearTimeout(this._fadeTimer);

    dom.loader.style.display = 'flex';
    dom.loader.style.opacity = '1';
    dom.loader.classList.remove('is-hidden');
    dom.loader.style.pointerEvents = 'all';
  },

  hide() {
    dom.loader.classList.add('is-hidden');
    dom.loader.style.pointerEvents = 'none';

    // Remove do fluxo após a transição CSS de opacidade (400 ms)
    this._fadeTimer = setTimeout(() => {
      dom.loader.style.display = 'none';
    }, 420);
  },
};


/* ============================================================
   7. ERROR PANEL
   (Renomeado de Error para evitar conflito com a classe global Error)
   ============================================================ */

const ErrorPanel = {
  show(msg) {
    const p = dom.errorPanel.querySelector('p');
    if (p && msg) p.textContent = msg;

    dom.errorPanel.style.display = 'flex';

    Toast.show(
      msg || 'Erro ao carregar o serviço. Tente novamente.',
      'error'
    );
  },

  hide() {
    dom.errorPanel.style.display = 'none';
  },
};


/* ============================================================
   8. SUCCESS
   ============================================================ */

const Success = {
  show(caseType) {
    // Limpa o embed
    dom.pegaPlaceholder.innerHTML = '';

    const screenId = SUCCESS_SCREEN_ID[caseType];
    const screen   = screenId ? document.getElementById(screenId) : null;

    if (!screen) {
      console.warn(`[Aviva] Tela de sucesso não encontrada para: ${caseType}`);
      return;
    }

    // Torna visível — usa classe em vez de atributo hidden
    screen.style.display = 'flex';
    // Força reflow para a animação disparar corretamente
    void screen.offsetHeight;
    screen.classList.add('is-visible');

    spawnFloaties(caseType, screen.querySelector('.floaties'));

    Toast.show(
      SUCCESS_TOAST_MSG[caseType] || 'Processo concluído!',
      'success'
    );
  },

  hideAll() {
    document.querySelectorAll('.success-screen').forEach(screen => {
      screen.classList.remove('is-visible');
      screen.style.display = 'none';

      const floaties = screen.querySelector('.floaties');
      if (floaties) floaties.innerHTML = '';
    });

    // Reseta o state para permitir recarregar a mesma aba
    state.activeCaseType = null;
  },
};

/**
 * Gera FLOATIE_COUNT emojis flutuantes no container da tela de sucesso.
 *
 * @param {string}      caseType
 * @param {HTMLElement} container
 */
function spawnFloaties(caseType, container) {
  if (!container) return;

  container.innerHTML = '';

  const emojis   = FLOATIE_EMOJIS[caseType] || FLOATIE_EMOJIS.BookingConfirmation;
  const fragment = document.createDocumentFragment();

  for (let i = 0; i < FLOATIE_COUNT; i++) {
    const el = document.createElement('span');
    el.className   = 'floatie';
    el.textContent = emojis[Math.floor(Math.random() * emojis.length)];
    el.style.left      = `${3  + Math.random() * 94}%`;
    el.style.bottom    = `${-5 + Math.random() * 15}%`;
    el.style.fontSize  = `${0.9 + Math.random() * 1.4}rem`;
    el.style.setProperty('--dur',   `${2.2 + Math.random() * 2.4}s`);
    el.style.setProperty('--delay', `${Math.random() * 1.4}s`);
    fragment.appendChild(el);
  }

  container.appendChild(fragment);
}


/* ============================================================
   9. TOAST
   ============================================================ */

const TOAST_ICONS = Object.freeze({
  info:    'fa-circle-info',
  success: 'fa-circle-check',
  error:   'fa-circle-xmark',
});

const Toast = {
  /**
   * Exibe uma notificação temporária.
   *
   * @param {string}                    message
   * @param {'info'|'success'|'error'}  [type='info']
   * @param {number}                    [duration]
   */
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
   10. INIT
   ============================================================ */

function bindEvents() {
  // ── Tabs ──────────────────────────────────────────────────
  dom.tabButtons.forEach(btn => {
    btn.addEventListener('click', () => {
      Tabs.load(btn.dataset.case, Number(btn.dataset.index));
    });
  });

  // ── Retry ─────────────────────────────────────────────────
  dom.retryBtn?.addEventListener('click', () => Tabs.reload());

  // ── Botões das telas de sucesso (delegação) ───────────────
  document.addEventListener('click', evt => {
    const btn = evt.target.closest('button[data-goto-case]');
    if (btn) {
      Success.hideAll();
      Tabs.load(btn.dataset.gotoCase, Number(btn.dataset.gotoIndex));
      return;
    }

    if (evt.target.closest('button.js-back-btn')) {
      Success.hideAll();
    }
  });
}

/** Preenche as datas dinâmicas (.js-today-date) */
function fillTodayDates() {
  const today = new Date().toLocaleDateString('pt-BR', {
    day:   '2-digit',
    month: 'short',
    year:  'numeric',
  });
  dom.todayDateEls.forEach(el => { el.textContent = today; });
}

/** Entry point */
function init() {
  cacheDom();
  fillTodayDates();
  bindEvents();

  // Oculta loader e error via style (não usa atributo hidden)
  dom.loader.style.display     = 'none';
  dom.errorPanel.style.display = 'none';
  document.querySelectorAll('.success-screen').forEach(s => {
    s.style.display = 'none';
  });

  // Carrega a primeira aba automaticamente
  Tabs.load('BookingConfirmation', 0);
}

document.addEventListener('DOMContentLoaded', init);
