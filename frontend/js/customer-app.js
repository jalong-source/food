/**
 * JaLong CyberFood • jalong.io.vn
 * Customer Ordering & Real-time Live Experience
 * Audio Synthesizer • Neon Confetti • Pure Customer-Facing Interface
 */

import {
  getCategories,
  getUsers,
  getFoods,
  getOrders,
  getOrderById,
  createOrder,
  checkCustomer,
  getDbStatus,
  getTableData,
  getRouletteFoods,
  formatVND,
  formatDateTime,
  escapeHtml,
  ApiError,
} from './api.js?v=20261109_csgo_v1';
import { createRealtimeClient } from './realtime-client.js?v=20261107_v7';

/* ==========================================================================
   CONSTANTS & STATUS METADATA (PURE CUSTOMER FRIENDLY)
   ========================================================================== */

const ORDER_STEPS = [
  {
    key: 'Pending',
    viTitle: 'Đã nhận đơn',
    viDesc: 'Nhà hàng đã xác nhận đơn của bạn',
    icon: 'clipboard-check',
  },
  {
    key: 'Preparing',
    viTitle: 'Bếp đang nấu',
    viDesc: 'Đầu bếp đang chế biến nóng hổi',
    icon: 'flame',
  },
  {
    key: 'Delivering',
    viTitle: 'Tài xế đang giao',
    viDesc: 'Đang trên đường di chuyển tới bạn',
    icon: 'bike',
  },
  {
    key: 'Completed',
    viTitle: 'Giao thành công',
    viDesc: 'Chúc bạn dùng bữa ngon miệng!',
    icon: 'check-circle-2',
  },
];

const STATUS_META = {
  Pending: {
    label: 'Chờ xác nhận',
    badgeClass: 'bg-amber-500/20 text-amber-300 border border-amber-500/40',
  },
  Preparing: {
    label: 'Bếp đang nấu',
    badgeClass: 'bg-sky-500/20 text-sky-300 border border-sky-500/40',
  },
  Delivering: {
    label: 'Tài xế đang giao',
    badgeClass: 'bg-indigo-500/20 text-indigo-300 border border-indigo-500/40',
  },
  Completed: {
    label: 'Đã giao thành công',
    badgeClass: 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40',
  },
  Cancelled: {
    label: 'Đã hủy đơn',
    badgeClass: 'bg-rose-500/20 text-rose-300 border border-rose-500/40',
  },
};

const FALLBACK_FOOD_IMG =
  'https://images.unsplash.com/photo-1546069901-ba9599a7e63c?auto=format&fit=crop&w=640&q=80';

/* ==========================================================================
   APPLICATION STATE
   ========================================================================== */

const state = {
  users: [],
  selectedUserId: null,
  addressTouched: false,

  categories: [],
  selectedCategoryId: 'all',
  searchQuery: '',
  onlyAvailable: false,

  foods: [],
  cart: [], // Array<{ foodId: number, quantity: number, note: string }>

  isReturningCustomer: false,
  discountPercent: 0,

  orders: [],
  activeOrderId: null,
  activeOrderDetail: null,
  trackerCollapsed: false,

  roulette: {
    budget: 'all',
    candidates: [],
    stripItems: [],
    isSpinning: false,
    winner: null,
    cardPitch: 168,
    totalStripCards: 70,
    winningIndex: 56,
  },

  dbOnline: true,
  dbLatencyMs: null,
  dbErrorText: null,
  transport: 'sse',
};

const CART_STORAGE_KEY = 'jalongfood_cart_v1';
const USER_STORAGE_KEY = 'jalongfood_selected_user_v1';

/* ==========================================================================
   WEB AUDIO SYNTHESIZER (MICRO-INTERACTIONS)
   ========================================================================== */

let audioCtx = null;
function getAudioContext() {
  if (!audioCtx) {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (AudioContextClass) {
      audioCtx = new AudioContextClass();
    }
  }
  if (audioCtx && audioCtx.state === 'suspended') {
    audioCtx.resume().catch(() => { });
  }
  return audioCtx;
}

function playChimeSound(freq1 = 520, freq2 = 820) {
  try {
    const ctx = getAudioContext();
    if (!ctx) return;
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(freq1, now);
    osc.frequency.exponentialRampToValueAtTime(freq2, now + 0.12);
    gain.gain.setValueAtTime(0.12, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.28);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(now);
    osc.stop(now + 0.28);
  } catch (_e) { }
}

function playSuccessChord() {
  try {
    const ctx = getAudioContext();
    if (!ctx) return;
    const now = ctx.currentTime;
    [523.25, 659.25, 783.99, 1046.5].forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'triangle';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0, now);
      gain.gain.linearRampToValueAtTime(0.09, now + 0.05 + i * 0.06);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.8 + i * 0.06);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now + i * 0.06);
      osc.stop(now + 0.85 + i * 0.06);
    });
  } catch (_e) { }
}

function playOrderStepSound() {
  try {
    const ctx = getAudioContext();
    if (!ctx) return;
    const now = ctx.currentTime;
    [440, 880].forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.08, now + i * 0.1);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.35 + i * 0.1);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now + i * 0.1);
      osc.stop(now + 0.4 + i * 0.1);
    });
  } catch (_e) { }
}

function playCaseTickSound() {
  try {
    const ctx = getAudioContext();
    if (!ctx) return;
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(820, now);
    osc.frequency.exponentialRampToValueAtTime(320, now + 0.02);
    gain.gain.setValueAtTime(0.18, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.02);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(now);
    osc.stop(now + 0.025);
  } catch (_e) { }
}

function playCaseRevealSound(rarity = 'milspec') {
  try {
    const ctx = getAudioContext();
    if (!ctx) return;
    const now = ctx.currentTime;

    const boomOsc = ctx.createOscillator();
    const boomGain = ctx.createGain();
    boomOsc.type = 'sine';
    boomOsc.frequency.setValueAtTime(140, now);
    boomOsc.frequency.exponentialRampToValueAtTime(45, now + 0.5);
    boomGain.gain.setValueAtTime(0.3, now);
    boomGain.gain.exponentialRampToValueAtTime(0.001, now + 0.55);
    boomOsc.connect(boomGain);
    boomGain.connect(ctx.destination);
    boomOsc.start(now);
    boomOsc.stop(now + 0.6);

    const freqs = rarity === 'special_rare' || rarity === 'covert'
      ? [523.25, 659.25, 783.99, 1046.5, 1318.5]
      : [440, 554.37, 659.25, 880];

    freqs.forEach((freq, idx) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'triangle';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.001, now + 0.04);
      gain.gain.linearRampToValueAtTime(0.12, now + 0.1 + idx * 0.04);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 1.2 + idx * 0.05);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now + idx * 0.04);
      osc.stop(now + 1.3 + idx * 0.05);
    });
  } catch (_e) { }
}

/* ==========================================================================
   NEON CONFETTI CELEBRATIONS
   ========================================================================== */

function triggerNeonConfetti() {
  const canvas = document.getElementById('confettiCanvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;

  const particles = [];
  const colors = ['#00f0ff', '#ff7b00', '#f72585', '#ffb703', '#00ff88', '#ffffff'];

  for (let i = 0; i < 90; i++) {
    particles.push({
      x: canvas.width / 2 + (Math.random() - 0.5) * 200,
      y: canvas.height * 0.45,
      vx: (Math.random() - 0.5) * 14,
      vy: Math.random() * -12 - 4,
      size: Math.random() * 5 + 3,
      color: colors[Math.floor(Math.random() * colors.length)],
      alpha: 1,
      decay: Math.random() * 0.015 + 0.01,
      rotation: Math.random() * 360,
      vRot: (Math.random() - 0.5) * 8,
    });
  }

  let animFrameId = null;
  function updateConfetti() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    let alive = false;
    for (const p of particles) {
      if (p.alpha > 0) {
        alive = true;
        p.x += p.vx;
        p.y += p.vy;
        p.vy += 0.35;
        p.vx *= 0.98;
        p.alpha -= p.decay;
        p.rotation += p.vRot;

        ctx.save();
        ctx.globalAlpha = Math.max(0, p.alpha);
        ctx.translate(p.x, p.y);
        ctx.rotate((p.rotation * Math.PI) / 180);
        ctx.fillStyle = p.color;
        ctx.shadowColor = p.color;
        ctx.shadowBlur = 10;
        ctx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size);
        ctx.restore();
      }
    }
    if (alive) {
      animFrameId = requestAnimationFrame(updateConfetti);
    } else {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      cancelAnimationFrame(animFrameId);
    }
  }
  updateConfetti();
}

/* ==========================================================================
   DOM REFERENCES
   ========================================================================== */

const dom = {
  dbEmergencyBanner: document.getElementById('dbEmergencyBanner'),
  dbEmergencyMessage: document.getElementById('dbEmergencyMessage'),
  dbEmergencyCode: document.getElementById('dbEmergencyCode'),
  btnRetryHealth: document.getElementById('btnRetryHealth'),

  dbStatusBadge: document.getElementById('dbStatusBadge'),
  dbStatusDot: document.getElementById('dbStatusDot'),
  dbStatusText: document.getElementById('dbStatusText'),
  dbLatencyBadge: document.getElementById('dbLatencyBadge'),
  realtimeTransportBadge: document.getElementById('realtimeTransportBadge'),

  customerSelect: document.getElementById('customerSelect'),
  headerCustomerNameDisplay: document.getElementById('headerCustomerNameDisplay'),
  navSplitMode: document.getElementById('navSplitMode'),

  orderTrackerSection: document.getElementById('orderTrackerSection'),
  orderTrackerBody: document.getElementById('orderTrackerBody'),
  activeOrderSelect: document.getElementById('activeOrderSelect'),
  btnRefreshTracker: document.getElementById('btnRefreshTracker'),
  btnToggleTrackerBody: document.getElementById('btnToggleTrackerBody'),
  trackerEmptyState: document.getElementById('trackerEmptyState'),
  trackerActiveContent: document.getElementById('trackerActiveContent'),
  trackedOrderCode: document.getElementById('trackedOrderCode'),
  trackedStatusBadge: document.getElementById('trackedStatusBadge'),
  trackedOrderTime: document.getElementById('trackedOrderTime'),
  trackedOrderAddress: document.getElementById('trackedOrderAddress'),
  trackedOrderTotal: document.getElementById('trackedOrderTotal'),
  trackerCancelledAlert: document.getElementById('trackerCancelledAlert'),
  trackerCancelledReason: document.getElementById('trackerCancelledReason'),
  trackerStepperWrapper: document.getElementById('trackerStepperWrapper'),
  trackerProgressBar: document.getElementById('trackerProgressBar'),
  trackerStepsGrid: document.getElementById('trackerStepsGrid'),
  trackedItemsCount: document.getElementById('trackedItemsCount'),
  trackedItemsList: document.getElementById('trackedItemsList'),
  trackedHistoryTimeline: document.getElementById('trackedHistoryTimeline'),

  // Simulated Live Delivery Map DOM References
  simulatedMapContainer: document.getElementById('simulatedMapContainer'),
  mapLiveBadge: document.getElementById('mapLiveBadge'),
  mapLiveStatusText: document.getElementById('mapLiveStatusText'),
  mapStatusSubtitle: document.getElementById('mapStatusSubtitle'),
  mapCustomerAddressLabel: document.getElementById('mapCustomerAddressLabel'),
  mapShipperMarker: document.getElementById('mapShipperMarker'),
  mapShipperTooltipText: document.getElementById('mapShipperTooltipText'),
  mapSpeedText: document.getElementById('mapSpeedText'),
  mapDistanceText: document.getElementById('mapDistanceText'),
  mapEtaText: document.getElementById('mapEtaText'),
  btnCallShipper: document.getElementById('btnCallShipper'),

  liveMenuCountBadge: document.getElementById('liveMenuCountBadge'),
  menuSearchInput: document.getElementById('menuSearchInput'),
  btnClearSearch: document.getElementById('btnClearSearch'),
  chkOnlyAvailable: document.getElementById('chkOnlyAvailable'),
  categoryPillsContainer: document.getElementById('categoryPillsContainer'),
  foodsGrid: document.getElementById('foodsGrid'),

  foodRouletteSection: document.getElementById('foodRouletteSection'),
  rouletteStatusBadge: document.getElementById('rouletteStatusBadge'),
  rouletteBudgetPills: document.getElementById('rouletteBudgetPills'),
  rouletteStrip: document.getElementById('rouletteStrip'),
  btnSpinRoulette: document.getElementById('btnSpinRoulette'),
  rouletteWinnerModal: document.getElementById('rouletteWinnerModal'),
  rouletteWinnerCard: document.getElementById('rouletteWinnerCard'),
  btnCloseWinnerModal: document.getElementById('btnCloseWinnerModal'),
  winnerRarityLabel: document.getElementById('winnerRarityLabel'),
  winnerFoodImg: document.getElementById('winnerFoodImg'),
  winnerCategoryName: document.getElementById('winnerCategoryName'),
  winnerFoodName: document.getElementById('winnerFoodName'),
  winnerFoodDesc: document.getElementById('winnerFoodDesc'),
  winnerFoodPrice: document.getElementById('winnerFoodPrice'),
  btnAddWinnerToCart: document.getElementById('btnAddWinnerToCart'),
  btnSpinAgainModal: document.getElementById('btnSpinAgainModal'),

  cartCountBadge: document.getElementById('cartCountBadge'),
  btnClearCart: document.getElementById('btnClearCart'),
  cartEmptyState: document.getElementById('cartEmptyState'),
  cartItemsContainer: document.getElementById('cartItemsContainer'),
  checkoutForm: document.getElementById('checkoutForm'),
  customerNameInput: document.getElementById('customerNameInput'),
  customerPhoneInput: document.getElementById('customerPhoneInput'),
  customerEmailInput: document.getElementById('customerEmailInput'),
  deliveryAddressInput: document.getElementById('deliveryAddressInput'),
  orderNoteInput: document.getElementById('orderNoteInput'),
  cartTotalPortions: document.getElementById('cartTotalPortions'),
  cartDiscountBanner: document.getElementById('cartDiscountBanner'),
  cartSubtotalRow: document.getElementById('cartSubtotalRow'),
  cartSubtotalPrice: document.getElementById('cartSubtotalPrice'),
  cartDiscountRow: document.getElementById('cartDiscountRow'),
  cartDiscountAmount: document.getElementById('cartDiscountAmount'),
  cartTotalPrice: document.getElementById('cartTotalPrice'),
  btnSubmitOrder: document.getElementById('btnSubmitOrder'),
  btnSubmitOrderLabel: document.getElementById('btnSubmitOrderLabel'),

  toastContainer: document.getElementById('toastContainer'),
};

/* ==========================================================================
   ICONS & TOAST NOTIFICATIONS
   ========================================================================== */

function refreshIcons() {
  if (window.lucide && typeof window.lucide.createIcons === 'function') {
    window.lucide.createIcons();
  }
}

function showToast(title, message = '', variant = 'info') {
  if (!dom.toastContainer) return;

  const palette = {
    success: {
      border: 'border-emerald-500/40',
      bg: 'bg-slate-900/95',
      icon: 'check-circle-2',
      iconColor: 'text-emerald-400',
    },
    warning: {
      border: 'border-amber-500/40',
      bg: 'bg-slate-900/95',
      icon: 'alert-triangle',
      iconColor: 'text-amber-400',
    },
    error: {
      border: 'border-rose-500/40',
      bg: 'bg-slate-900/95',
      icon: 'alert-octagon',
      iconColor: 'text-rose-400',
    },
    info: {
      border: 'border-orange-500/40',
      bg: 'bg-slate-900/95',
      icon: 'bell-ring',
      iconColor: 'text-orange-400',
    },
  };

  const theme = palette[variant] || palette.info;
  const toast = document.createElement('div');
  toast.className = `pointer-events-auto toast-enter ${theme.bg} text-white border ${theme.border} rounded-2xl p-3.5 shadow-2xl flex items-start gap-3 backdrop-blur-md`;
  toast.innerHTML = `
    <i data-lucide="${theme.icon}" class="w-5 h-5 ${theme.iconColor} shrink-0 mt-0.5"></i>
    <div class="flex-1 min-w-0">
      <div class="text-xs font-bold leading-snug text-white">${escapeHtml(title)}</div>
      ${message ? `<div class="text-[11px] text-slate-300 mt-0.5 leading-relaxed">${escapeHtml(message)}</div>` : ''}
    </div>
  `;

  dom.toastContainer.appendChild(toast);
  refreshIcons();

  setTimeout(() => {
    toast.classList.remove('toast-enter');
    toast.classList.add('toast-exit');
    setTimeout(() => toast.remove(), 240);
  }, 4200);
}

function flashElement(el) {
  if (!el) return;
  el.classList.remove('live-flash');
  void el.offsetWidth;
  el.classList.add('live-flash');
}

/* ==========================================================================
   DB STATUS & SERVICE HEALTH SYNC
   ========================================================================== */

function applyDbStatusUI({ connected, latencyMs, lastError, code }) {
  const wasOnline = state.dbOnline;
  state.dbOnline = Boolean(connected);
  state.dbLatencyMs = latencyMs ?? null;
  state.dbErrorText = lastError || null;

  if (state.dbOnline) {
    if (dom.dbEmergencyBanner) dom.dbEmergencyBanner.classList.add('hidden');
    if (dom.dbStatusBadge) {
      dom.dbStatusBadge.className =
        'flex items-center gap-2 px-3 py-1.5 rounded-full bg-slate-900/90 border border-emerald-500/30 text-emerald-300 text-xs font-semibold shadow-inner';
    }
    if (dom.dbStatusDot) dom.dbStatusDot.className = 'w-2.5 h-2.5 rounded-full bg-emerald-400 pulse-online';
    if (dom.dbStatusText) dom.dbStatusText.textContent = 'Máy chủ Trực tuyến';
    if (dom.dbLatencyBadge) {
      dom.dbLatencyBadge.className =
        'font-mono-code text-[10px] px-1.5 py-0.5 rounded bg-emerald-950/80 text-emerald-400 border border-emerald-800/50';
      dom.dbLatencyBadge.textContent =
        latencyMs !== null && latencyMs !== undefined ? `${Math.round(Number(latencyMs))}ms` : 'OK';
    }

    if (!wasOnline) {
      showToast(
        'Hệ thống đã kết nối trở lại!',
        'Bạn có thể tiếp tục chọn món và theo dõi đơn hàng bình thường.',
        'success'
      );
      loadAllInitialData({ silent: true });
    }
  } else {
    if (dom.dbEmergencyBanner) dom.dbEmergencyBanner.classList.remove('hidden');
    if (dom.dbEmergencyMessage) {
      dom.dbEmergencyMessage.textContent =
        'Hệ thống đang đồng bộ dữ liệu với máy chủ. Mọi thao tác sẽ tiếp tục trong giây lát...';
    }
    if (dom.dbEmergencyCode) dom.dbEmergencyCode.textContent = 'Đang đồng bộ';

    if (dom.dbStatusBadge) {
      dom.dbStatusBadge.className =
        'flex items-center gap-2 px-3 py-1.5 rounded-full bg-rose-950/80 border border-rose-600/50 text-rose-300 text-xs font-bold';
    }
    if (dom.dbStatusDot) dom.dbStatusDot.className = 'w-2.5 h-2.5 rounded-full bg-rose-500 pulse-offline';
    if (dom.dbStatusText) dom.dbStatusText.textContent = 'Đang kết nối lại';
    if (dom.dbLatencyBadge) {
      dom.dbLatencyBadge.className =
        'font-mono-code text-[10px] px-1.5 py-0.5 rounded bg-rose-900/80 text-rose-300';
      dom.dbLatencyBadge.textContent = 'BUSY';
    }

    if (wasOnline) {
      showToast(
        'Đang đồng bộ kết nối máy chủ',
        'Vui lòng chờ trong giây lát trong khi hệ thống thử lại kết nối.',
        'warning'
      );
    }
  }

  updateCheckoutButtonState();
}

async function pollDbHealth() {
  try {
    const status = await getDbStatus();
    const isOnline = Boolean(status?.connected) && !status?.simulatedOffline;
    applyDbStatusUI({
      connected: isOnline,
      latencyMs: status?.latencyMs,
      lastError: status?.lastError,
      code: status?.simulatedOffline ? 'SIMULATED_DB_OFFLINE' : 'DB_OFFLINE',
    });
  } catch (err) {
    applyDbStatusUI({
      connected: false,
      latencyMs: null,
      lastError: err?.message,
      code: err?.code || 'API_UNREACHABLE',
    });
  }
}

/* ==========================================================================
   CUSTOMER ACCOUNT & PROFILE SYNC (`users`)
   ========================================================================== */

const CUSTOMER_NAME_KEY = 'jalongfood_customer_name_v1';
const CUSTOMER_PHONE_KEY = 'jalongfood_customer_phone_v1';
const CUSTOMER_EMAIL_KEY = 'jalongfood_customer_email_v1';

function slugifyName(name) {
  return (name || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]/g, '') || 'khach';
}

function syncCustomerNameUI() {
  const savedName = localStorage.getItem(CUSTOMER_NAME_KEY) || 'Hoàng Long';
  const savedPhone = localStorage.getItem(CUSTOMER_PHONE_KEY) || '0988123456';
  const savedEmail = localStorage.getItem(CUSTOMER_EMAIL_KEY) || 'hoanglong@gmail.com';

  if (dom.customerNameInput && !dom.customerNameInput.value.trim()) {
    dom.customerNameInput.value = savedName;
  }
  if (dom.customerPhoneInput && !dom.customerPhoneInput.value.trim()) {
    dom.customerPhoneInput.value = savedPhone;
  }
  if (dom.customerEmailInput && !dom.customerEmailInput.value.trim()) {
    dom.customerEmailInput.value = savedEmail;
  }
  if (dom.headerCustomerNameDisplay) {
    const curVal = (dom.customerNameInput?.value || savedName).trim() || 'Khách vãng lai';
    dom.headerCustomerNameDisplay.textContent = curVal + ' (Bạn)';
  }
  triggerCustomerCheck();
}

let customerCheckTimer = null;
function triggerCustomerCheck() {
  if (customerCheckTimer) clearTimeout(customerCheckTimer);
  customerCheckTimer = setTimeout(async () => {
    const phone = (dom.customerPhoneInput?.value || '').trim();
    const email = (dom.customerEmailInput?.value || '').trim();
    const name = (dom.customerNameInput?.value || '').trim();

    if (!phone && !email && !name) {
      state.isReturningCustomer = false;
      state.discountPercent = 0;
      renderCart();
      return;
    }

    try {
      const res = await checkCustomer({ phone, email, name });
      if (res && res.isReturning) {
        if (!state.isReturningCustomer) {
          playSuccessChord();
          showToast(
            '🎉 Kích hoạt Ưu đãi Khách cũ -10%!',
            `Chào mừng ${res.user?.full_name || name} quay lại! Bạn được giảm 10% trên toàn bộ đơn hàng.`,
            'success'
          );
        }
        state.isReturningCustomer = true;
        state.discountPercent = 10;
        if (res.user?.default_address && (!dom.deliveryAddressInput.value || !state.addressTouched)) {
          dom.deliveryAddressInput.value = res.user.default_address;
        }
      } else {
        state.isReturningCustomer = false;
        state.discountPercent = 0;
      }
      renderCart();
    } catch (_e) {
      state.isReturningCustomer = false;
      state.discountPercent = 0;
      renderCart();
    }
  }, 350);
}

function getUserById(id) {
  return state.users.find((u) => Number(u.id) === Number(id)) || null;
}

function renderUsersDropdown() {
  if (!state.users.length) return;

  const defaultCust =
    state.users.find((u) => u.role === 'customer') || state.users[0];
  if (defaultCust && !state.selectedUserId) {
    state.selectedUserId = Number(defaultCust.id);
  }

  // Populate hidden select for programmatic compatibility
  if (dom.customerSelect) {
    dom.customerSelect.innerHTML = state.users
      .map((u) => {
        const selected = Number(u.id) === Number(state.selectedUserId) ? 'selected' : '';
        return `<option value="${u.id}" ${selected}>${escapeHtml(u.full_name)}</option>`;
      })
      .join('');
  }

  syncCustomerNameUI();
}

function applySelectedUserAddress(force = false) {
  const user = getUserById(state.selectedUserId);
  if (!user) return;
  if (force || !state.addressTouched || !dom.deliveryAddressInput.value.trim()) {
    dom.deliveryAddressInput.value = user.default_address || 'Số 12 Phố Cổ, Hà Nội';
    state.addressTouched = false;
  }
  syncCustomerNameUI();
}

/* ==========================================================================
   CS:GO STYLE FOOD ROULETTE ("HÔM NAY ĂN GÌ ?")
   ========================================================================== */

const CSGO_RARITIES = {
  milspec: {
    key: 'milspec',
    name: 'Hạt dẻ',
    color: '#38bdf8',
    badgeClass: 'bg-sky-950 text-sky-400 border border-sky-800/80',
    barColor: '#38bdf8',
    glowColor: 'rgba(56, 189, 248, 0.4)',
    cardBg: 'linear-gradient(180deg, rgba(15, 23, 42, 0.95) 0%, rgba(56, 189, 248, 0.12) 100%)',
    borderColor: 'rgba(56, 189, 248, 0.5)',
    title: 'HẠT DẺ (TIẾT KIỆM)',
  },
  restricted: {
    key: 'restricted',
    name: 'Chuẩn vị',
    color: '#a855f7',
    badgeClass: 'bg-purple-950 text-purple-300 border border-purple-800/80',
    barColor: '#a855f7',
    glowColor: 'rgba(168, 85, 247, 0.4)',
    cardBg: 'linear-gradient(180deg, rgba(15, 23, 42, 0.95) 0%, rgba(168, 85, 247, 0.14) 100%)',
    borderColor: 'rgba(168, 85, 247, 0.5)',
    title: 'CHUẨN VỊ (ĐẬM ĐÀ)',
  },
  classified: {
    key: 'classified',
    name: 'No nê',
    color: '#ec4899',
    badgeClass: 'bg-pink-950 text-pink-300 border border-pink-800/80',
    barColor: '#ec4899',
    glowColor: 'rgba(236, 72, 153, 0.45)',
    cardBg: 'linear-gradient(180deg, rgba(15, 23, 42, 0.95) 0%, rgba(236, 72, 153, 0.16) 100%)',
    borderColor: 'rgba(236, 72, 153, 0.6)',
    title: 'NO NÊ (THƠM NGON)',
  },
  covert: {
    key: 'covert',
    name: 'Thượng hạng',
    color: '#f43f5e',
    badgeClass: 'bg-rose-950 text-rose-300 border border-rose-800/80',
    barColor: '#f43f5e',
    glowColor: 'rgba(244, 63, 94, 0.55)',
    cardBg: 'linear-gradient(180deg, rgba(15, 23, 42, 0.95) 0%, rgba(244, 63, 94, 0.2) 100%)',
    borderColor: 'rgba(244, 63, 94, 0.7)',
    title: 'THƯỢNG HẠNG (CAO CẤP)',
  },
  special_rare: {
    key: 'special_rare',
    name: '★ Món Bếp Trưởng VIP ★',
    color: '#fbbf24',
    badgeClass: 'bg-amber-950 text-amber-300 border border-amber-400 shadow-[0_0_12px_rgba(251,191,36,0.5)] font-black',
    barColor: '#fbbf24',
    glowColor: 'rgba(251, 191, 36, 0.75)',
    cardBg: 'linear-gradient(180deg, rgba(25, 20, 10, 0.95) 0%, rgba(251, 191, 36, 0.25) 100%)',
    borderColor: '#fbbf24',
    title: '★ MÓN BẾP TRƯỞNG VIP ★',
  },
};

function getFoodRarity(food) {
  if (food.rarity && CSGO_RARITIES[food.rarity]) {
    return food.rarity;
  }
  const price = Number(food.price || 0);
  if (price < 40000) return 'milspec';
  if (price < 55000) return 'restricted';
  if (price < 65000) return 'classified';
  if (price <= 68000) return 'covert';
  return 'special_rare';
}

async function loadRouletteCandidates(budget = 'all') {
  try {
    state.roulette.budget = budget;
    const items = await getRouletteFoods(budget);
    if (Array.isArray(items) && items.length > 0) {
      state.roulette.candidates = items;
    } else {
      state.roulette.candidates = (state.foods || []).filter((f) => {
        if (!f.is_available || Number(f.stock_quantity) <= 0) return false;
        const p = Number(f.price);
        if (budget === 'under40k') return p < 40000;
        if (budget === '40k-65k') return p >= 40000 && p <= 65000;
        if (budget === 'over65k') return p > 65000;
        return true;
      });
    }

    if (dom.rouletteStatusBadge) {
      dom.rouletteStatusBadge.textContent = `Sẵn sàng quay món (${state.roulette.candidates.length} món)`;
    }

    buildRouletteStrip();
  } catch (err) {
    console.warn('[CustomerApp] loadRouletteCandidates error:', err);
    state.roulette.candidates = state.foods || [];
    buildRouletteStrip();
  }
}

function buildRouletteStrip(designatedWinner = null) {
  if (!dom.rouletteStrip) return;

  const candidates = state.roulette.candidates;
  if (!candidates || candidates.length === 0) {
    dom.rouletteStrip.innerHTML = `
      <div class="p-8 text-center text-xs text-slate-400 w-full">
        Không có món nào trong tầm giá này. Hãy chọn mốc tài chính khác!
      </div>
    `;
    return;
  }

  const TOTAL_CARDS = state.roulette.totalStripCards;
  const WIN_INDEX = state.roulette.winningIndex;

  const winner = designatedWinner || candidates[Math.floor(Math.random() * candidates.length)];
  state.roulette.winner = winner;

  const stripItems = [];
  for (let i = 0; i < TOTAL_CARDS; i++) {
    if (i === WIN_INDEX) {
      stripItems.push(winner);
    } else {
      const rand = candidates[Math.floor(Math.random() * candidates.length)];
      stripItems.push(rand);
    }
  }
  state.roulette.stripItems = stripItems;

  dom.rouletteStrip.style.transition = 'none';
  dom.rouletteStrip.style.transform = 'translateX(0px)';

  dom.rouletteStrip.innerHTML = stripItems
    .map((food, idx) => {
      const rarityKey = getFoodRarity(food);
      const rarity = CSGO_RARITIES[rarityKey] || CSGO_RARITIES.milspec;
      const img = food.image_url || FALLBACK_FOOD_IMG;

      return `
        <div
          data-strip-index="${idx}"
          class="roulette-card shrink-0 flex flex-col justify-between rounded-xl overflow-hidden select-none border border-slate-800 transition-all duration-300 relative group"
          style="width: 160px; height: 172px; margin-right: 8px; background: ${rarity.cardBg}; border-bottom: 4px solid ${rarity.barColor};"
        >
          <div class="px-2 pt-2 flex items-center justify-between">
            <span class="text-[9px] font-bold px-1.5 py-0.5 rounded ${rarity.badgeClass} truncate max-w-[95px]">
              ${rarity.name}
            </span>
            <span class="text-[10px] font-mono-code font-bold text-orange-300">
              ${formatVND(food.price)}
            </span>
          </div>

          <div class="relative w-full h-24 my-auto flex items-center justify-center overflow-hidden px-2">
            <img
              src="${escapeHtml(img)}"
              alt="${escapeHtml(food.name)}"
              class="max-h-20 max-w-full object-contain drop-shadow-[0_4px_10px_rgba(0,0,0,0.6)] group-hover:scale-105 transition-transform"
              onerror="this.src='${FALLBACK_FOOD_IMG}'"
              loading="lazy"
            />
          </div>

          <div class="px-2 pb-2 bg-slate-950/70 border-t border-slate-800/50">
            <span class="text-[9px] text-slate-400 font-extrabold truncate block uppercase tracking-wider">
              ${escapeHtml(food.category_name || 'Món ngon')}
            </span>
            <h5 class="text-[11px] font-extrabold text-white truncate leading-tight mt-0.5" title="${escapeHtml(food.name)}">
              ${escapeHtml(food.name)}
            </h5>
          </div>

          <div class="h-1 w-full" style="background: ${rarity.barColor}; box-shadow: 0 0 8px ${rarity.glowColor};"></div>
        </div>
      `;
    })
    .join('');
}

let rouletteAnimFrame = null;

function spinRoulette() {
  if (state.roulette.isSpinning) return;
  if (!state.roulette.candidates || state.roulette.candidates.length === 0) {
    showToast('Chưa có món ăn', 'Không có món ăn khả dụng để quay.', 'warning');
    return;
  }

  getAudioContext();

  state.roulette.isSpinning = true;
  if (dom.btnSpinRoulette) {
    dom.btnSpinRoulette.disabled = true;
    dom.btnSpinRoulette.classList.add('opacity-50', 'cursor-not-allowed');
    dom.btnSpinRoulette.innerHTML = `
      <i data-lucide="loader" class="w-4 h-4 animate-spin text-amber-300"></i>
      <span>ĐANG QUAY MÓN...</span>
    `;
    refreshIcons();
  }
  if (dom.rouletteStatusBadge) {
    dom.rouletteStatusBadge.textContent = '⚡ Đang quay món... Hãy nín thở!';
  }

  const candidates = state.roulette.candidates;
  const winner = candidates[Math.floor(Math.random() * candidates.length)];
  state.roulette.winner = winner;

  buildRouletteStrip(winner);

  // Force reflow
  dom.rouletteStrip.getBoundingClientRect();

  const viewportWidth = dom.rouletteStrip.parentElement ? dom.rouletteStrip.parentElement.clientWidth : 800;
  const cardPitch = state.roulette.cardPitch;
  const cardWidth = 160;
  const WIN_INDEX = state.roulette.winningIndex;

  const winningCardCenter = WIN_INDEX * cardPitch + cardWidth / 2;
  const centerNeedleOffset = viewportWidth / 2;
  const jitter = (Math.random() - 0.5) * 60;
  const targetTranslateX = -(winningCardCenter - centerNeedleOffset + jitter);

  const durationMs = 5600;
  dom.rouletteStrip.style.transition = `transform ${durationMs}ms cubic-bezier(0.12, 0.8, 0.2, 1)`;
  dom.rouletteStrip.style.transform = `translateX(${targetTranslateX}px)`;

  let lastPassedIdx = 0;
  const startTime = performance.now();

  function trackRouletteTicks(now) {
    const elapsed = now - startTime;
    if (elapsed < durationMs + 200) {
      const transform = window.getComputedStyle(dom.rouletteStrip).transform;
      if (transform && transform !== 'none') {
        const matrix = transform.replace(/matrix\(|\)|\s/g, '').split(',');
        const currentX = Math.abs(parseFloat(matrix[4]) || 0);
        const currentCenterCard = Math.floor((currentX + centerNeedleOffset) / cardPitch);
        if (currentCenterCard > lastPassedIdx) {
          lastPassedIdx = currentCenterCard;
          playCaseTickSound();
        }
      }
      rouletteAnimFrame = requestAnimationFrame(trackRouletteTicks);
    }
  }

  rouletteAnimFrame = requestAnimationFrame(trackRouletteTicks);

  setTimeout(() => {
    cancelAnimationFrame(rouletteAnimFrame);

    const winnerCard = dom.rouletteStrip.querySelector(`[data-strip-index="${WIN_INDEX}"]`);
    if (winnerCard) {
      winnerCard.classList.add('ring-4', 'ring-amber-400', 'shadow-[0_0_25px_rgba(251,191,36,0.9)]', 'scale-105', 'z-20');
    }

    const rarityKey = getFoodRarity(winner);
    playCaseRevealSound(rarityKey);
    triggerNeonConfetti();

    if (dom.rouletteStatusBadge) {
      dom.rouletteStatusBadge.textContent = `🎉 ĐÃ QUAY TRÚNG: ${winner.name}!`;
    }

    setTimeout(() => {
      openRouletteWinnerModal(winner);
      state.roulette.isSpinning = false;
      if (dom.btnSpinRoulette) {
        dom.btnSpinRoulette.disabled = false;
        dom.btnSpinRoulette.classList.remove('opacity-50', 'cursor-not-allowed');
        dom.btnSpinRoulette.innerHTML = `
          <i data-lucide="sparkles" class="w-4 h-4 text-amber-300"></i>
          <span>QUAY MÓN NGAY ⚡</span>
        `;
        refreshIcons();
      }
    }, 700);
  }, durationMs + 100);
}

function openRouletteWinnerModal(winner) {
  if (!dom.rouletteWinnerModal || !winner) return;

  const rarityKey = getFoodRarity(winner);
  const rarity = CSGO_RARITIES[rarityKey] || CSGO_RARITIES.milspec;

  if (dom.winnerRarityLabel) {
    dom.winnerRarityLabel.textContent = rarity.title;
    dom.winnerRarityLabel.style.color = rarity.color;
  }
  if (dom.rouletteWinnerCard) {
    dom.rouletteWinnerCard.style.borderColor = rarity.barColor;
    dom.rouletteWinnerCard.style.boxShadow = `0 0 50px ${rarity.glowColor}`;
  }
  if (dom.winnerFoodImg) {
    dom.winnerFoodImg.src = winner.image_url || FALLBACK_FOOD_IMG;
    dom.winnerFoodImg.onerror = () => {
      dom.winnerFoodImg.src = FALLBACK_FOOD_IMG;
    };
  }
  if (dom.winnerCategoryName) {
    dom.winnerCategoryName.textContent = winner.category_name || 'Món ngon';
  }
  if (dom.winnerFoodName) {
    dom.winnerFoodName.textContent = winner.name;
  }
  if (dom.winnerFoodDesc) {
    dom.winnerFoodDesc.textContent = winner.description || 'Hương vị thơm ngon, chế biến tươi mới từ nguyên liệu hảo hạng!';
  }
  if (dom.winnerFoodPrice) {
    dom.winnerFoodPrice.textContent = formatVND(winner.price);
  }

  dom.rouletteWinnerModal.classList.remove('hidden');
  requestAnimationFrame(() => {
    dom.rouletteWinnerModal.classList.remove('opacity-0');
    if (dom.rouletteWinnerCard) {
      dom.rouletteWinnerCard.classList.remove('scale-95');
      dom.rouletteWinnerCard.classList.add('scale-100');
    }
  });

  refreshIcons();
}

function closeRouletteWinnerModal() {
  if (!dom.rouletteWinnerModal) return;
  dom.rouletteWinnerModal.classList.add('opacity-0');
  if (dom.rouletteWinnerCard) {
    dom.rouletteWinnerCard.classList.remove('scale-100');
    dom.rouletteWinnerCard.classList.add('scale-95');
  }
  setTimeout(() => {
    dom.rouletteWinnerModal.classList.add('hidden');
  }, 300);
}

function addRouletteWinnerToCart() {
  const winner = state.roulette.winner;
  if (!winner) return;

  addToCart(winner.id, 1);
  closeRouletteWinnerModal();
  showToast(
    '🎉 Đã Chốt Món Định Mệnh!',
    `"${winner.name}" đã được đưa vào giỏ hàng. Bạn có thể chốt đơn ngay!`,
    'success'
  );
}

function bindRouletteEvents() {
  if (dom.btnSpinRoulette) {
    dom.btnSpinRoulette.addEventListener('click', () => {
      spinRoulette();
    });
  }

  if (dom.rouletteBudgetPills) {
    dom.rouletteBudgetPills.querySelectorAll('[data-roulette-budget]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        if (state.roulette.isSpinning) return;
        const budget = btn.dataset.rouletteBudget;
        dom.rouletteBudgetPills.querySelectorAll('[data-roulette-budget]').forEach((b) => {
          b.classList.remove('active', 'bg-gradient-to-r', 'from-orange-500', 'to-rose-500', 'text-white', 'shadow-md', 'shadow-orange-500/30', 'font-extrabold');
          b.classList.add('text-slate-300', 'font-bold');
        });
        btn.classList.add('active', 'bg-gradient-to-r', 'from-orange-500', 'to-rose-500', 'text-white', 'shadow-md', 'shadow-orange-500/30', 'font-extrabold');
        btn.classList.remove('text-slate-300');

        playChimeSound(600, 900);
        await loadRouletteCandidates(budget);
      });
    });
  }

  if (dom.btnCloseWinnerModal) {
    dom.btnCloseWinnerModal.addEventListener('click', closeRouletteWinnerModal);
  }

  if (dom.btnSpinAgainModal) {
    dom.btnSpinAgainModal.addEventListener('click', () => {
      closeRouletteWinnerModal();
      setTimeout(() => {
        spinRoulette();
      }, 350);
    });
  }

  if (dom.btnAddWinnerToCart) {
    dom.btnAddWinnerToCart.addEventListener('click', addRouletteWinnerToCart);
  }

  if (dom.rouletteWinnerModal) {
    dom.rouletteWinnerModal.addEventListener('click', (e) => {
      if (e.target === dom.rouletteWinnerModal) {
        closeRouletteWinnerModal();
      }
    });
  }
}

/* ==========================================================================
   LIVE MENU (`categories` & `foods`)
   ========================================================================== */

function getCategoryName(categoryId) {
  const cat = state.categories.find((c) => Number(c.id) === Number(categoryId));
  return cat ? cat.name : `Danh mục #${categoryId}`;
}

function isFoodOrderable(food) {
  return Boolean(food.is_available) && Number(food.stock_quantity) > 0;
}

function getFilteredFoods() {
  const q = state.searchQuery.trim().toLowerCase();
  return state.foods.filter((food) => {
    if (
      state.selectedCategoryId !== 'all' &&
      Number(food.category_id) !== Number(state.selectedCategoryId)
    ) {
      return false;
    }
    if (state.onlyAvailable && !isFoodOrderable(food)) {
      return false;
    }
    if (q) {
      const hay = `${food.name || ''} ${food.description || ''} ${getCategoryName(food.category_id)}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

function renderCategoriesPills() {
  const totalCount = state.foods.length;
  const pills = [
    {
      id: 'all',
      name: 'Tất cả món',
      count: totalCount,
    },
    ...state.categories.map((cat) => ({
      id: String(cat.id),
      name: cat.name,
      count: state.foods.filter((f) => Number(f.category_id) === Number(cat.id)).length,
    })),
  ];

  dom.categoryPillsContainer.innerHTML = pills
    .map((pill) => {
      const active = String(state.selectedCategoryId) === String(pill.id);
      const cls = active
        ? 'bg-gradient-to-r from-orange-500 to-rose-500 text-white border-transparent shadow-lg shadow-orange-500/30'
        : 'bg-slate-900/80 hover:bg-slate-800 text-slate-300 border-slate-700/80';
      return `
        <button
          type="button"
          data-cat-id="${escapeHtml(pill.id)}"
          class="cat-pill-btn shrink-0 px-4 py-2 rounded-2xl border text-xs font-bold flex items-center gap-2 transition duration-200 cursor-pointer ${cls}"
        >
          <span>${escapeHtml(pill.name)}</span>
          <span class="px-2 py-0.5 rounded-full text-[10px] ${active ? 'bg-white/20 text-white' : 'bg-slate-800 text-slate-400'}">
            ${pill.count}
          </span>
        </button>
      `;
    })
    .join('');

  dom.categoryPillsContainer.querySelectorAll('.cat-pill-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.selectedCategoryId = btn.dataset.catId;
      playChimeSound(440, 660);
      renderCategoriesPills();
      renderFoodsGrid();
    });
  });
}

function renderFoodsGrid(highlightFoodId = null) {
  const filtered = getFilteredFoods();
  dom.liveMenuCountBadge.textContent = `${filtered.length} món`;

  if (!filtered.length) {
    dom.foodsGrid.innerHTML = `
      <div class="col-span-full cyber-card rounded-3xl p-10 text-center">
        <div class="w-14 h-14 rounded-2xl bg-slate-900 text-slate-500 flex items-center justify-center mx-auto mb-3">
          <i data-lucide="search-x" class="w-7 h-7"></i>
        </div>
        <p class="text-sm font-bold text-slate-200">Không tìm thấy món ăn phù hợp</p>
        <p class="text-xs text-slate-400 mt-1">Thử đổi từ khóa tìm kiếm hoặc chọn danh mục khác nhé.</p>
      </div>
    `;
    refreshIcons();
    return;
  }

  dom.foodsGrid.innerHTML = filtered
    .map((food) => {
      const available = Boolean(food.is_available);
      const stock = Number(food.stock_quantity ?? 0);
      const orderable = available && stock > 0;
      const categoryName = getCategoryName(food.category_id);
      const inCartItem = state.cart.find((c) => Number(c.foodId) === Number(food.id));
      const inCartQty = inCartItem ? inCartItem.quantity : 0;
      const imageUrl = food.image_url || FALLBACK_FOOD_IMG;

      const isHot = Number(food.id) <= 4;

      return `
        <article
          id="food-card-${food.id}"
          class="cyber-card rounded-3xl overflow-hidden flex flex-col justify-between group transition duration-300"
        >
          <div>
            <!-- Food Image Container -->
            <div class="relative h-44 w-full overflow-hidden bg-slate-900">
              <img
                src="${escapeHtml(imageUrl)}"
                alt="${escapeHtml(food.name)}"
                loading="lazy"
                class="w-full h-full object-cover group-hover:scale-108 transition-transform duration-500 ${!orderable ? 'grayscale opacity-60' : ''}"
                onerror="this.src='${FALLBACK_FOOD_IMG}'"
              />
              <div class="absolute inset-0 bg-gradient-to-t from-slate-950 via-transparent to-black/20"></div>

              <!-- Top Floating Badges -->
              <div class="absolute top-3 left-3 right-3 flex items-center justify-between gap-2 pointer-events-none">
                <span class="px-2.5 py-1 rounded-xl text-[10px] font-black uppercase tracking-wider bg-slate-950/80 backdrop-blur-md text-slate-200 border border-white/10 shadow-lg">
                  ${escapeHtml(categoryName)}
                </span>
                
                ${!orderable
          ? `
                      <span class="px-2.5 py-1 rounded-xl text-[10px] font-bold bg-rose-950/90 text-rose-300 border border-rose-700/60 shadow">
                        Hết món
                      </span>
                    `
          : isHot
            ? `
                        <span class="cyber-flash-badge px-2.5 py-1 rounded-xl text-[10px] font-black text-white shadow-md flex items-center gap-1">
                          <span class="w-1.5 h-1.5 rounded-full bg-white blink-dot"></span>
                          <span>BÁN CHẠY</span>
                        </span>
                      `
            : stock <= 5
              ? `
                          <span class="px-2.5 py-1 rounded-xl text-[10px] font-bold bg-amber-500/90 text-slate-950 shadow flex items-center gap-1">
                            <span>Sắp hết</span>
                          </span>
                        `
              : `
                          <span class="px-2.5 py-1 rounded-xl text-[10px] font-bold bg-emerald-950/90 text-emerald-300 border border-emerald-700/60 shadow flex items-center gap-1">
                            <span class="w-1.5 h-1.5 rounded-full bg-emerald-400 blink-dot"></span>
                            <span>Còn ${stock} phần</span>
                          </span>
                        `
        }
              </div>
            </div>

            <!-- Content Body -->
            <div class="p-4 sm:p-5">
              <h3 class="font-black text-base text-white leading-snug group-hover:text-orange-400 transition" title="${escapeHtml(food.name)}">
                ${escapeHtml(food.name)}
              </h3>
              <p class="text-xs text-slate-400 mt-1.5 line-clamp-2 leading-relaxed min-h-[34px]">
                ${escapeHtml(food.description || 'Món ăn nấu sốt nóng hổi từ nguyên liệu tươi sạch chuẩn vị trong ngày.')}
              </p>
            </div>
          </div>

          <!-- Price & Action Footer -->
          <div class="px-4 sm:px-5 pb-5 pt-3 border-t border-slate-800/80 flex items-center justify-between gap-3">
            <div>
              <span class="text-[10px] uppercase font-bold text-slate-400 block tracking-wider">Giá món</span>
              <span class="text-lg font-black text-orange-400 neon-text-glow">${formatVND(food.price)}</span>
            </div>

            ${!orderable
          ? `
                  <button type="button" disabled class="px-4 py-2.5 rounded-2xl bg-slate-900 border border-slate-800 text-slate-500 text-xs font-bold cursor-not-allowed">
                    Tạm hết món
                  </button>
                `
          : inCartQty > 0
            ? `
                    <div class="flex items-center gap-1.5 bg-slate-900 border border-orange-500/50 rounded-2xl p-1 shadow-md">
                      <button type="button" data-food-dec="${food.id}" class="w-7 h-7 rounded-xl bg-slate-800 hover:bg-orange-500 text-white font-black text-sm flex items-center justify-center transition">−</button>
                      <span class="w-6 text-center text-xs font-black text-orange-400 font-mono-code">${inCartQty}</span>
                      <button type="button" data-food-inc="${food.id}" class="w-7 h-7 rounded-xl bg-orange-500 hover:bg-orange-600 text-white font-black text-sm flex items-center justify-center shadow transition">+</button>
                    </div>
                  `
            : `
                    <button
                      type="button"
                      data-food-add="${food.id}"
                      class="px-4 py-2.5 rounded-2xl bg-gradient-to-r from-orange-500 to-rose-500 hover:from-orange-600 hover:to-rose-600 text-white text-xs font-black flex items-center gap-1.5 shadow-lg shadow-orange-500/25 transition duration-200 cursor-pointer"
                    >
                      <i data-lucide="plus" class="w-3.5 h-3.5"></i>
                      <span>Chọn món</span>
                    </button>
                  `
        }
          </div>
        </article>
      `;
    })
    .join('');

  // Bind cart buttons inside grid
  dom.foodsGrid.querySelectorAll('[data-food-add]').forEach((btn) => {
    btn.addEventListener('click', () => {
      playChimeSound(600, 950);
      addToCart(Number(btn.dataset.foodAdd), 1);
    });
  });
  dom.foodsGrid.querySelectorAll('[data-food-inc]').forEach((btn) => {
    btn.addEventListener('click', () => {
      playChimeSound(700, 1050);
      addToCart(Number(btn.dataset.foodInc), 1);
    });
  });
  dom.foodsGrid.querySelectorAll('[data-food-dec]').forEach((btn) => {
    btn.addEventListener('click', () => {
      playChimeSound(650, 450);
      changeCartQty(Number(btn.dataset.foodDec), -1);
    });
  });

  refreshIcons();

  if (highlightFoodId !== null) {
    const cardEl = document.getElementById(`food-card-${highlightFoodId}`);
    flashElement(cardEl);
  }
}

/* ==========================================================================
   CART MANAGEMENT & CHECKOUT
   ========================================================================== */

function saveCartToStorage() {
  try {
    sessionStorage.setItem(CART_STORAGE_KEY, JSON.stringify(state.cart));
  } catch (_e) { }
}

function loadCartFromStorage() {
  try {
    const raw = sessionStorage.getItem(CART_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        state.cart = parsed
          .filter((it) => it && Number(it.foodId) > 0 && Number(it.quantity) > 0)
          .map((it) => ({
            foodId: Number(it.foodId),
            quantity: Number(it.quantity),
            note: String(it.note || ''),
            isFlashSale: Boolean(it.isFlashSale),
            flashSalePrice: it.isFlashSale ? 1000 : undefined,
          }));
      }
    }
  } catch (_e) {
    state.cart = [];
  }
}

function reconcileCartWithLiveMenu() {
  let modified = false;
  const nextCart = [];

  for (const item of state.cart) {
    const food = state.foods.find((f) => Number(f.id) === Number(item.foodId));
    if (!food || !food.is_available || Number(food.stock_quantity) <= 0) {
      modified = true;
      continue;
    }
    const maxQty = item.isFlashSale ? 1 : Number(food.stock_quantity);
    const clampedQty = Math.min(item.quantity, maxQty);
    if (clampedQty !== item.quantity) {
      modified = true;
    }
    nextCart.push({
      ...item,
      quantity: clampedQty,
    });
  }

  if (modified) {
    state.cart = nextCart;
    saveCartToStorage();
  }
}

function addToCart(foodId, delta = 1) {
  const food = state.foods.find((f) => Number(f.id) === Number(foodId));
  if (!food || !isFoodOrderable(food)) {
    showToast('Món ăn tạm hết', 'Món này vừa hết hàng hoặc ngừng phục vụ.', 'warning');
    return;
  }

  const existing = state.cart.find((c) => Number(c.foodId) === Number(foodId));
  const currentQty = existing ? existing.quantity : 0;
  const nextQty = currentQty + delta;

  if (nextQty > Number(food.stock_quantity)) {
    showToast(
      'Đã đạt giới hạn có sẵn',
      `Món "${food.name}" hiện chỉ còn ${food.stock_quantity} phần trong ngày.`,
      'warning'
    );
    return;
  }

  if (existing) {
    existing.quantity = nextQty;
  } else {
    state.cart.push({
      foodId: Number(foodId),
      quantity: delta,
      note: '',
    });
    showToast('Đã thêm vào giỏ hàng!', `"${food.name}" đã được thêm vào giỏ của bạn.`, 'success');
  }

  saveCartToStorage();
  renderCart();
  renderFoodsGrid();
}

function changeCartQty(foodId, delta) {
  const target = state.cart.find((c) => Number(c.foodId) === Number(foodId));
  if (!target) return;

  const nextQty = target.quantity + delta;
  if (nextQty <= 0) {
    state.cart = state.cart.filter((c) => Number(c.foodId) !== Number(foodId));
  } else {
    const food = state.foods.find((f) => Number(f.id) === Number(foodId));
    if (food && nextQty > Number(food.stock_quantity)) {
      showToast('Đã đạt giới hạn tồn kho', `Chỉ còn ${food.stock_quantity} phần.`, 'warning');
      return;
    }
    target.quantity = nextQty;
  }

  saveCartToStorage();
  renderCart();
  renderFoodsGrid();
}

function updateCheckoutButtonState() {
  const hasItems = state.cart.length > 0;
  const canOrder = hasItems && state.dbOnline;
  dom.btnSubmitOrder.disabled = !canOrder;
}

function renderCart() {
  reconcileCartWithLiveMenu();

  const totalItems = state.cart.reduce((sum, item) => sum + item.quantity, 0);
  dom.cartCountBadge.textContent = String(totalItems);

  if (totalItems > 0) {
    dom.btnClearCart.classList.remove('hidden');
    dom.cartEmptyState.classList.add('hidden');
    dom.cartItemsContainer.classList.remove('hidden');
  } else {
    dom.btnClearCart.classList.add('hidden');
    dom.cartEmptyState.classList.remove('hidden');
    dom.cartItemsContainer.classList.add('hidden');
  }

  dom.cartTotalPortions.textContent = `${totalItems} phần`;

  let subtotal = 0;
  let finalTotal = 0;

  dom.cartItemsContainer.innerHTML = state.cart
    .map((item) => {
      const food = state.foods.find((f) => Number(f.id) === Number(item.foodId));
      if (!food) return '';
      const basePrice = Number(food.price);
      const isDiscounted = state.isReturningCustomer && !item.isFlashSale;
      const effectiveUnitPrice = item.isFlashSale ? 1000 : (isDiscounted ? Math.round(basePrice * 0.90) : basePrice);
      const lineTotal = effectiveUnitPrice * item.quantity;
      const catalogLineTotal = (item.isFlashSale ? 1000 : basePrice) * item.quantity;

      subtotal += catalogLineTotal;
      finalTotal += lineTotal;

      return `
        <div class="bg-slate-900 rounded-2xl p-3 border ${item.isFlashSale ? 'border-amber-500/60 shadow-lg shadow-amber-500/10' : (isDiscounted ? 'border-amber-500/30 bg-gradient-to-b from-slate-900 to-amber-950/20' : 'border-slate-800')} space-y-2">
          <div class="flex items-start justify-between gap-2">
            <div class="min-w-0">
              <div class="flex items-center gap-1.5">
                <h4 class="font-bold text-xs text-white truncate">${escapeHtml(food.name)}</h4>
                ${item.isFlashSale ? '<span class="px-1.5 py-0.2 rounded text-[9px] font-black bg-rose-600 text-white shrink-0">⚡ 1K</span>' : (isDiscounted ? '<span class="px-1.5 py-0.2 rounded text-[9px] font-extrabold bg-amber-500/20 text-amber-300 border border-amber-500/30 shrink-0">🎁 -10%</span>' : '')}
              </div>
              <span class="text-[11px] ${item.isFlashSale ? 'text-amber-300 font-black' : (isDiscounted ? 'text-amber-300 font-extrabold' : 'text-orange-400 font-extrabold')}">
                ${formatVND(effectiveUnitPrice)}
                ${item.isFlashSale ? `<span class="line-through text-slate-500 text-[10px] ml-1">${formatVND(food.price)}</span>` : (isDiscounted ? `<span class="line-through text-slate-500 text-[10px] ml-1">${formatVND(basePrice)}</span>` : '')}
              </span>
            </div>

            <!-- Qty Counter -->
            <div class="flex items-center gap-1 bg-slate-950 border border-slate-800 rounded-xl p-0.5">
              ${item.isFlashSale
          ? `<button type="button" data-cart-dec="${food.id}" class="w-6 h-6 rounded-lg bg-slate-800 hover:bg-rose-500 text-white text-xs font-bold flex items-center justify-center transition" title="Xóa món 1K">✕</button>
                     <span class="w-5 text-center text-xs font-bold text-amber-300 font-mono-code">1</span>
                     <button type="button" disabled class="w-6 h-6 rounded-lg bg-slate-800 text-slate-600 text-xs font-bold flex items-center justify-center cursor-not-allowed" title="Mỗi món 1K tối đa 1 suất">+</button>`
          : `<button type="button" data-cart-dec="${food.id}" class="w-6 h-6 rounded-lg bg-slate-800 hover:bg-orange-500 text-white text-xs font-bold flex items-center justify-center transition">−</button>
                     <span class="w-5 text-center text-xs font-bold text-white font-mono-code">${item.quantity}</span>
                     <button type="button" data-cart-inc="${food.id}" class="w-6 h-6 rounded-lg bg-orange-500 hover:bg-orange-600 text-white text-xs font-bold flex items-center justify-center shadow transition">+</button>`
        }
            </div>
          </div>

          <div class="flex items-center justify-between gap-2 pt-1 border-t border-slate-800/60 text-[11px]">
            <input
              type="text"
              data-cart-note="${food.id}"
              value="${escapeHtml(item.note || '')}"
              placeholder="Ghi chú vị (ít đá, cay...)"
              class="flex-1 bg-transparent text-[11px] text-slate-300 placeholder-slate-600 focus:outline-none"
            />
            <span class="font-extrabold ${item.isFlashSale ? 'text-amber-300' : (isDiscounted ? 'text-amber-300' : 'text-orange-400')} font-mono-code">${formatVND(lineTotal)}</span>
          </div>
        </div>
      `;
    })
    .join('');

  if (state.isReturningCustomer && subtotal > 0 && subtotal > finalTotal) {
    const discountAmount = subtotal - finalTotal;

    if (dom.cartDiscountBanner) dom.cartDiscountBanner.classList.remove('hidden');
    if (dom.cartSubtotalRow) {
      dom.cartSubtotalRow.classList.remove('hidden');
      if (dom.cartSubtotalPrice) dom.cartSubtotalPrice.textContent = formatVND(subtotal);
    }
    if (dom.cartDiscountRow) {
      dom.cartDiscountRow.classList.remove('hidden');
      if (dom.cartDiscountAmount) dom.cartDiscountAmount.textContent = `-${formatVND(discountAmount)}`;
    }
  } else {
    if (dom.cartDiscountBanner) dom.cartDiscountBanner.classList.add('hidden');
    if (dom.cartSubtotalRow) dom.cartSubtotalRow.classList.add('hidden');
    if (dom.cartDiscountRow) dom.cartDiscountRow.classList.add('hidden');
  }

  dom.cartTotalPrice.textContent = formatVND(finalTotal);

  dom.cartItemsContainer.querySelectorAll('[data-cart-dec]').forEach((btn) => {
    btn.addEventListener('click', () => {
      playChimeSound(600, 450);
      changeCartQty(Number(btn.dataset.cartDec), -1);
    });
  });
  dom.cartItemsContainer.querySelectorAll('[data-cart-inc]').forEach((btn) => {
    btn.addEventListener('click', () => {
      playChimeSound(700, 1000);
      changeCartQty(Number(btn.dataset.cartInc), 1);
    });
  });
  dom.cartItemsContainer.querySelectorAll('[data-cart-note]').forEach((inp) => {
    inp.addEventListener('input', () => {
      const target = state.cart.find((c) => Number(c.foodId) === Number(inp.dataset.cartNote));
      if (target) {
        target.note = inp.value;
        saveCartToStorage();
      }
    });
  });

  updateCheckoutButtonState();
}

async function handleCheckoutSubmit(evt) {
  evt.preventDefault();
  if (!state.cart.length || !state.dbOnline) return;

  const customerName = (dom.customerNameInput?.value || '').trim() || 'Khách vãng lai';
  const customerPhone = (dom.customerPhoneInput?.value || '').trim() || '0988123456';
  const customerEmail = (dom.customerEmailInput?.value || '').trim() || `${slugifyName(customerName)}@gmail.com`;

  localStorage.setItem(CUSTOMER_NAME_KEY, customerName);
  localStorage.setItem(CUSTOMER_PHONE_KEY, customerPhone);
  localStorage.setItem(CUSTOMER_EMAIL_KEY, customerEmail);
  syncCustomerNameUI();

  const address = dom.deliveryAddressInput.value.trim();
  if (!address) {
    showToast('Thiếu địa chỉ nhận món', 'Vui lòng nhập địa chỉ để tài xế giao tới bạn.', 'warning');
    dom.deliveryAddressInput.focus();
    return;
  }

  const prevLabel = dom.btnSubmitOrderLabel.textContent;
  dom.btnSubmitOrder.disabled = true;
  dom.btnSubmitOrderLabel.textContent = 'Đang xử lý đơn món...';

  try {
    const created = await createOrder({
      user_id: state.selectedUserId,
      customer_name: customerName,
      customer_phone: customerPhone,
      customer_email: customerEmail,
      delivery_address: address,
      customer_note: dom.orderNoteInput.value.trim(),
      items: state.cart.map((c) => ({
        food_id: c.foodId,
        quantity: c.quantity,
        item_note: c.note,
        is_flash_sale: Boolean(c.isFlashSale),
      })),
    });

    const newOrderId = created?.id ?? created?.order_id ?? created?.orderId ?? null;

    // Reset cart & note
    state.cart = [];
    saveCartToStorage();
    dom.orderNoteInput.value = '';
    renderCart();

    // Trigger Sci-fi Celebration Confetti & Audio Fanfare!
    playSuccessChord();
    triggerNeonConfetti();

    showToast(
      `🎉 Đặt món thành công${newOrderId ? ` (#ORD-${newOrderId})` : ''}!`,
      'Nhà bếp đã nhận đơn và bắt đầu chế biến nóng sốt cho bạn!',
      'success'
    );

    if (newOrderId) {
      state.activeOrderId = Number(newOrderId);
      state.activeOrderDetail = created;

      const orderUserId = created?.user_id ?? created?.userId ?? null;
      if (orderUserId) {
        state.selectedUserId = Number(orderUserId);
        localStorage.setItem(USER_STORAGE_KEY, String(orderUserId));
      }

      // HIỆN NGAY BẢNG THEO DÕI HÀNH TRÌNH ĐƠN HÀNG!
      if (dom.orderTrackerSection) {
        dom.orderTrackerSection.classList.remove('hidden');
      }
      if (dom.trackerEmptyState) {
        dom.trackerEmptyState.classList.add('hidden');
      }
      if (dom.trackerActiveContent) {
        dom.trackerActiveContent.classList.remove('hidden');
      }

      // Hiển thị ngay chi tiết đơn và Map GPS cho đơn vừa đặt
      await loadActiveOrderDetail(newOrderId);
      await Promise.all([refreshFoodsOnly(), loadOrdersForSelectedUser(newOrderId)]);

      if (state.trackerCollapsed) {
        toggleTrackerCollapse(false);
      }
      dom.orderTrackerSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
      flashElement(dom.orderTrackerSection);
    }
  } catch (err) {
    if (err instanceof ApiError && (err.status === 503 || err.code === 'SIMULATED_DB_OFFLINE')) {
      applyDbStatusUI({
        connected: false,
        latencyMs: null,
        lastError: err.message,
        code: err.code || 'DB_OFFLINE',
      });
    } else {
      showToast(
        'Không thể hoàn tất đặt món',
        err?.message || 'Có lỗi xảy ra trong quá trình đặt đơn. Vui lòng thử lại sau giây lát.',
        'error'
      );
      await refreshFoodsOnly();
    }
  } finally {
    dom.btnSubmitOrderLabel.textContent = prevLabel;
    updateCheckoutButtonState();
  }
}

/* ==========================================================================
   ORDER TRACKER & LIVE STATUS JOURNEY (CUSTOMER FRIENDLY)
   ========================================================================== */

function toggleTrackerCollapse(forceState) {
  state.trackerCollapsed =
    typeof forceState === 'boolean' ? forceState : !state.trackerCollapsed;
  dom.orderTrackerBody.classList.toggle('hidden', state.trackerCollapsed);
  dom.btnToggleTrackerBody.innerHTML = `<i data-lucide="${state.trackerCollapsed ? 'chevron-down' : 'chevron-up'}" class="w-4 h-4"></i>`;
  refreshIcons();
}

async function loadOrdersForSelectedUser(preferredOrderId = null) {
  try {
    const allOrders = await getOrders();
    const myOrders = (state.selectedUserId ? allOrders.filter((o) => Number(o.user_id) === Number(state.selectedUserId)) : allOrders)
      .sort((a, b) => Number(b.id) - Number(a.id));

    const ordersToShow = myOrders.length > 0 ? myOrders : allOrders.sort((a, b) => Number(b.id) - Number(a.id));
    state.orders = ordersToShow;

    if (!ordersToShow.length) {
      if (preferredOrderId) {
        state.activeOrderId = Number(preferredOrderId);
        dom.activeOrderSelect.innerHTML = `<option value="${preferredOrderId}">#ORD-${preferredOrderId} (Đơn vừa đặt)</option>`;
        await loadActiveOrderDetail(preferredOrderId);
        return;
      }
      state.activeOrderId = null;
      state.activeOrderDetail = null;
      dom.activeOrderSelect.innerHTML = `<option value="">Chưa có đơn hàng nào</option>`;
      renderOrderTracker();
      return;
    }

    if (preferredOrderId && ordersToShow.some((o) => Number(o.id) === Number(preferredOrderId))) {
      state.activeOrderId = Number(preferredOrderId);
    } else if (!state.activeOrderId || !ordersToShow.some((o) => Number(o.id) === Number(state.activeOrderId))) {
      const activeCandidate = ordersToShow.find(
        (o) => o.status !== 'Completed' && o.status !== 'Cancelled'
      );
      state.activeOrderId = Number((activeCandidate || ordersToShow[0]).id);
    }

    dom.activeOrderSelect.innerHTML = ordersToShow
      .map((o) => {
        const sel = Number(o.id) === Number(state.activeOrderId) ? 'selected' : '';
        const meta = STATUS_META[o.status] || { label: o.status };
        return `<option value="${o.id}" ${sel}>#ORD-${o.id} • ${meta.label} • ${formatVND(o.total_amount)}</option>`;
      })
      .join('');

    await loadActiveOrderDetail(state.activeOrderId);
  } catch (err) {
    console.warn('[CustomerApp] loadOrdersForSelectedUser error:', err);
  }
}

async function loadActiveOrderDetail(orderId) {
  if (!orderId) {
    state.activeOrderDetail = null;
    renderOrderTracker();
    return;
  }

  const detail = await getOrderById(orderId);
  let items = Array.isArray(detail?.items) ? detail.items : Array.isArray(detail?.order_items) ? detail.order_items : null;
  let history = Array.isArray(detail?.history)
    ? detail.history
    : Array.isArray(detail?.status_history)
      ? detail.status_history
      : Array.isArray(detail?.statusHistory)
        ? detail.statusHistory
        : null;

  if (!items) {
    try {
      const tbl = await getTableData('order_items', { limit: 100 });
      items = (tbl.rows || []).filter((r) => Number(r.order_id) === Number(orderId));
    } catch (_e) {
      items = [];
    }
  }
  if (!history) {
    try {
      const tbl = await getTableData('order_status_history', { limit: 100 });
      history = (tbl.rows || []).filter((r) => Number(r.order_id) === Number(orderId));
    } catch (_e) {
      history = [];
    }
  }

  state.activeOrderDetail = {
    ...detail,
    items,
    history,
  };

  renderOrderTracker();
}

function renderDeliveryMap(status, order) {
  if (!dom.simulatedMapContainer) return;

  const address = order.delivery_address || 'Địa chỉ của bạn';
  if (dom.mapCustomerAddressLabel) {
    dom.mapCustomerAddressLabel.textContent = `🏠 ${address}`;
    dom.mapCustomerAddressLabel.title = address;
  }

  if (status === 'Pending') {
    if (dom.mapShipperMarker) {
      dom.mapShipperMarker.style.left = '12%';
      dom.mapShipperMarker.style.top = '24%';
    }
    if (dom.mapLiveStatusText) dom.mapLiveStatusText.textContent = 'Chờ điều xe';
    if (dom.mapLiveBadge) dom.mapLiveBadge.className = 'px-2.5 py-0.5 text-[10px] font-black rounded-full bg-amber-500/20 text-amber-300 border border-amber-500/40 flex items-center gap-1';
    if (dom.mapStatusSubtitle) dom.mapStatusSubtitle.textContent = 'Nhà hàng đã xác nhận món ăn. Hệ thống đang kết nối tài xế gần quán nhất...';
    if (dom.mapShipperTooltipText) dom.mapShipperTooltipText.textContent = 'Đang nhận đơn • 0 km/h';
    if (dom.mapSpeedText) dom.mapSpeedText.textContent = 'Vận tốc: 0 km/h';
    if (dom.mapDistanceText) dom.mapDistanceText.textContent = 'Cách bạn: ~1.2 km';
    if (dom.mapEtaText) dom.mapEtaText.textContent = 'Dự kiến: 12-15 phút';
  } else if (status === 'Preparing') {
    if (dom.mapShipperMarker) {
      dom.mapShipperMarker.style.left = '22%';
      dom.mapShipperMarker.style.top = '28%';
    }
    if (dom.mapLiveStatusText) dom.mapLiveStatusText.textContent = 'Tài xế đã tới quán';
    if (dom.mapLiveBadge) dom.mapLiveBadge.className = 'px-2.5 py-0.5 text-[10px] font-black rounded-full bg-sky-500/20 text-sky-300 border border-sky-500/40 flex items-center gap-1';
    if (dom.mapStatusSubtitle) dom.mapStatusSubtitle.textContent = 'Tài xế đã có mặt tại bếp, đang chờ đầu bếp hoàn tất đóng hộp món ăn nóng hổi...';
    if (dom.mapShipperTooltipText) dom.mapShipperTooltipText.textContent = 'Chờ lấy món • 0 km/h';
    if (dom.mapSpeedText) dom.mapSpeedText.textContent = 'Vận tốc: 0 km/h';
    if (dom.mapDistanceText) dom.mapDistanceText.textContent = 'Cách bạn: ~1.2 km';
    if (dom.mapEtaText) dom.mapEtaText.textContent = 'Dự kiến: 8-10 phút';
  } else if (status === 'Delivering') {
    if (dom.mapShipperMarker) {
      dom.mapShipperMarker.style.left = '52%';
      dom.mapShipperMarker.style.top = '44%';
    }
    if (dom.mapLiveStatusText) dom.mapLiveStatusText.textContent = 'Tài xế đang giao tới bạn';
    if (dom.mapLiveBadge) dom.mapLiveBadge.className = 'px-2.5 py-0.5 text-[10px] font-black rounded-full bg-emerald-500/20 text-emerald-300 border border-emerald-500/40 flex items-center gap-1';
    if (dom.mapStatusSubtitle) dom.mapStatusSubtitle.textContent = 'Tài xế đang chạy xe trên đường giao món. Bạn chú ý điện thoại nhé!';
    if (dom.mapShipperTooltipText) dom.mapShipperTooltipText.textContent = 'Đang giao hàng • 35 km/h';
    if (dom.mapSpeedText) dom.mapSpeedText.textContent = 'Vận tốc: 35 km/h';
    if (dom.mapDistanceText) dom.mapDistanceText.textContent = 'Cách bạn: ~450m';
    if (dom.mapEtaText) dom.mapEtaText.textContent = 'Dự kiến: 3-5 phút';
  } else if (status === 'Completed') {
    if (dom.mapShipperMarker) {
      dom.mapShipperMarker.style.left = '80%';
      dom.mapShipperMarker.style.top = '62%';
    }
    if (dom.mapLiveStatusText) dom.mapLiveStatusText.textContent = 'Đã giao thành công';
    if (dom.mapLiveBadge) dom.mapLiveBadge.className = 'px-2.5 py-0.5 text-[10px] font-black rounded-full bg-emerald-500/20 text-emerald-300 border border-emerald-500/40 flex items-center gap-1';
    if (dom.mapStatusSubtitle) dom.mapStatusSubtitle.textContent = 'Món ăn đã được giao tận tay bạn. Chúc bạn dùng bữa thật ngon miệng!';
    if (dom.mapShipperTooltipText) dom.mapShipperTooltipText.textContent = 'Đã giao tới nơi 🎉';
    if (dom.mapSpeedText) dom.mapSpeedText.textContent = 'Vận tốc: 0 km/h';
    if (dom.mapDistanceText) dom.mapDistanceText.textContent = 'Cách bạn: 0m';
    if (dom.mapEtaText) dom.mapEtaText.textContent = 'Đã hoàn tất';
  } else if (status === 'Cancelled') {
    if (dom.mapShipperMarker) {
      dom.mapShipperMarker.style.left = '12%';
      dom.mapShipperMarker.style.top = '24%';
    }
    if (dom.mapLiveStatusText) dom.mapLiveStatusText.textContent = 'Đơn đã hủy';
    if (dom.mapLiveBadge) dom.mapLiveBadge.className = 'px-2.5 py-0.5 text-[10px] font-black rounded-full bg-rose-500/20 text-rose-300 border border-rose-500/40 flex items-center gap-1';
    if (dom.mapStatusSubtitle) dom.mapStatusSubtitle.textContent = 'Đơn hàng này đã kết thúc lộ trình giao.';
    if (dom.mapShipperTooltipText) dom.mapShipperTooltipText.textContent = 'Đã hủy chuyến';
    if (dom.mapSpeedText) dom.mapSpeedText.textContent = 'Vận tốc: 0 km/h';
    if (dom.mapDistanceText) dom.mapDistanceText.textContent = '---';
    if (dom.mapEtaText) dom.mapEtaText.textContent = 'Đã hủy';
  }
}

function renderOrderTracker(animateStep = false) {
  const order = state.activeOrderDetail;
  if (!order || !order.id) {
    dom.trackerEmptyState.classList.remove('hidden');
    dom.trackerActiveContent.classList.add('hidden');
    return;
  }

  dom.trackerEmptyState.classList.add('hidden');
  dom.trackerActiveContent.classList.remove('hidden');

  const status = order.status || 'Pending';
  const meta = STATUS_META[status] || STATUS_META.Pending;

  dom.trackedOrderCode.textContent = `#ORD-${order.id}`;
  dom.trackedStatusBadge.className = `px-3.5 py-1 rounded-full text-xs font-bold ${meta.badgeClass}`;
  dom.trackedStatusBadge.textContent = meta.label;
  dom.trackedOrderTime.innerHTML = `<i data-lucide="clock" class="w-3.5 h-3.5 text-slate-400"></i><span>${escapeHtml(formatDateTime(order.created_at))}</span>`;
  dom.trackedOrderAddress.textContent = order.delivery_address || '---';

  // Render Simulated Delivery Map GPS
  renderDeliveryMap(status, order);

  const items = Array.isArray(order.items) ? order.items : [];
  const computedTotal =
    order.total_amount !== undefined && order.total_amount !== null
      ? Number(order.total_amount)
      : items.reduce((sum, it) => sum + Number(it.quantity) * Number(it.unit_price), 0);
  dom.trackedOrderTotal.textContent = formatVND(computedTotal);

  const historyList = Array.isArray(order.history) ? [...order.history] : [];
  historyList.sort((a, b) => new Date(a.changed_at) - new Date(b.changed_at) || Number(a.id) - Number(b.id));

  if (status === 'Cancelled') {
    dom.trackerCancelledAlert.classList.remove('hidden');
    const cancelEntry = [...historyList].reverse().find((h) => h.new_status === 'Cancelled');
    dom.trackerCancelledReason.textContent = cancelEntry?.note
      ? `Lý do: "${cancelEntry.note}". Đơn hàng đã được hoàn tất thủ tục hủy.`
      : 'Đơn hàng này đã được hủy theo yêu cầu.';
  } else {
    dom.trackerCancelledAlert.classList.add('hidden');
  }

  const currentIdx = ORDER_STEPS.findIndex((s) => s.key === status);
  const progressPct =
    status === 'Cancelled'
      ? 0
      : currentIdx <= 0
        ? 0
        : Math.round((currentIdx / (ORDER_STEPS.length - 1)) * 100);
  dom.trackerProgressBar.style.width = `${progressPct}%`;

  dom.trackerStepsGrid.innerHTML = ORDER_STEPS.map((step, idx) => {
    const isCancelled = status === 'Cancelled';
    const isDone = !isCancelled && currentIdx > idx;
    const isActive = !isCancelled && currentIdx === idx;

    let circleCls = 'bg-slate-900 text-slate-500 border-slate-800';
    let titleCls = 'text-slate-400';
    if (isDone) {
      circleCls = 'bg-emerald-500 text-slate-950 border-emerald-400 shadow-lg shadow-emerald-500/30';
      titleCls = 'text-emerald-400 font-bold';
    } else if (isActive) {
      circleCls = `bg-gradient-to-tr from-orange-500 to-amber-400 text-slate-950 border-amber-300 ring-4 ring-orange-500/25 shadow-xl shadow-orange-500/40 ${animateStep ? 'step-active-bounce' : ''}`;
      titleCls = 'text-orange-400 font-black';
    }

    return `
      <div class="flex flex-col items-center text-center p-3 rounded-2xl bg-slate-900/60 sm:bg-transparent border sm:border-0 border-slate-800/60">
        <div class="w-11 h-11 rounded-2xl border-2 flex items-center justify-center transition-all duration-300 ${circleCls}">
          <i data-lucide="${isDone ? 'check' : step.icon}" class="w-5 h-5"></i>
        </div>
        <div class="mt-2.5 text-xs ${titleCls}">
          ${idx + 1}. ${escapeHtml(step.viTitle)}
        </div>
        <div class="text-[11px] text-slate-400 hidden sm:block mt-0.5 leading-snug">
          ${escapeHtml(step.viDesc)}
        </div>
      </div>
    `;
  }).join('');

  // Render Ordered Items
  const totalPortions = items.reduce((s, i) => s + Number(i.quantity || 0), 0);
  dom.trackedItemsCount.textContent = `${items.length} món (${totalPortions} phần)`;

  dom.trackedItemsList.innerHTML = items.length
    ? items
      .map((it) => {
        const foodFallback = state.foods.find((f) => Number(f.id) === Number(it.food_id));
        const foodName = it.food_name || it.name || foodFallback?.name || `Món #${it.food_id}`;
        const lineTotal = Number(it.quantity) * Number(it.unit_price);
        return `
            <div class="bg-slate-950/80 rounded-xl p-3 border border-slate-800/80 flex items-start justify-between gap-2 text-xs">
              <div class="min-w-0">
                <div class="font-bold text-white truncate">
                  <span class="text-orange-400 font-black mr-1">${it.quantity}x</span>${escapeHtml(foodName)}
                </div>
                <div class="text-[11px] text-slate-400 mt-0.5">
                  Đơn giá: ${formatVND(it.unit_price)}
                  ${it.item_note ? ` • <span class="text-amber-300 font-medium">${escapeHtml(it.item_note)}</span>` : ''}
                </div>
              </div>
              <span class="font-black text-orange-400 shrink-0 font-mono-code">${formatVND(lineTotal)}</span>
            </div>
          `;
      })
      .join('')
    : `<p class="text-xs text-slate-400 py-4 text-center">Chưa có món ăn nào.</p>`;

  // Render Delivery Journey Timeline (Pure Customer Friendly)
  const timelineDesc = [...historyList].reverse();
  dom.trackedHistoryTimeline.innerHTML = timelineDesc.length
    ? timelineDesc
      .map((h, i) => {
        const statusTextMap = {
          Pending: 'Nhà hàng đã xác nhận đơn hàng',
          Preparing: 'Bếp đã tiếp nhận và đang nấu món',
          Delivering: 'Tài xế đã nhận món và đang giao tới bạn',
          Completed: 'Đã giao thành công tận tay khách hàng',
          Cancelled: 'Đơn hàng đã được hủy',
        };
        const friendlyMessage = statusTextMap[h.new_status] || `Đơn hàng chuyển sang: ${h.new_status}`;

        return `
            <li class="relative ${i === 0 ? 'bg-slate-950/80 p-3 rounded-2xl border border-cyan-500/30 shadow-lg' : 'py-1.5'}">
              <span class="absolute -left-[21px] top-3.5 w-3 h-3 rounded-full ${i === 0 ? 'bg-cyan-400 ring-4 ring-cyan-500/20' : 'bg-slate-700'}"></span>
              <div class="flex flex-wrap items-center justify-between gap-1 text-[11px]">
                <div class="font-bold text-white flex items-center gap-1.5">
                  ${i === 0 ? '<span class="w-1.5 h-1.5 rounded-full bg-cyan-400 blink-dot"></span>' : ''}
                  <span>${escapeHtml(friendlyMessage)}</span>
                </div>
                <span class="font-mono-code text-[10px] text-slate-400">${escapeHtml(formatDateTime(h.changed_at))}</span>
              </div>
              ${h.note ? `<div class="text-[11px] text-slate-400 mt-1 italic">"${escapeHtml(h.note)}"</div>` : ''}
            </li>
          `;
      })
      .join('')
    : `<li class="text-xs text-slate-400 py-3">Đang cập nhật hành trình đơn...</li>`;

  refreshIcons();
}

/* ==========================================================================
   INITIAL DATA LOADING & REAL-TIME SUBSCRIPTIONS
   ========================================================================== */

async function refreshFoodsOnly(highlightFoodId = null) {
  try {
    const foods = await getFoods({ include_unavailable: 'true', all: 'true' });
    state.foods = foods;
    renderCategoriesPills();
    renderFoodsGrid(highlightFoodId);
    renderCart();
    if (!state.roulette.isSpinning) {
      loadRouletteCandidates(state.roulette.budget);
    }
  } catch (err) {
    console.warn('[CustomerApp] Failed refreshing foods:', err.message);
  }
}

async function loadAllInitialData({ silent = false } = {}) {
  try {
    const [status, categories, users, foods] = await Promise.all([
      getDbStatus().catch(() => null),
      getCategories().catch((e) => {
        console.warn('[CustomerApp] Failed loading categories:', e);
        return [];
      }),
      getUsers().catch((e) => {
        console.warn('[CustomerApp] Failed loading users:', e);
        return [];
      }),
      getFoods({ include_unavailable: 'true', all: 'true' }).catch((e) => {
        console.warn('[CustomerApp] Failed loading foods:', e);
        return [];
      }),
    ]);

    if (status) {
      applyDbStatusUI({
        connected: Boolean(status.connected) && !status.simulatedOffline,
        latencyMs: status.latencyMs,
        lastError: status.lastError,
        code: status.simulatedOffline ? 'SIMULATED_DB_OFFLINE' : null,
      });
    } else {
      applyDbStatusUI({
        connected: true,
        latencyMs: 1,
      });
    }

    state.categories = Array.isArray(categories) ? categories : [];
    state.users = Array.isArray(users) ? users : [];
    state.foods = Array.isArray(foods) ? foods : [];

    const savedUserId = localStorage.getItem(USER_STORAGE_KEY);
    const defaultCustomer =
      (savedUserId && state.users.find((u) => Number(u.id) === Number(savedUserId))) ||
      state.users.find((u) => u.role === 'customer') ||
      state.users[0];

    if (defaultCustomer && !state.selectedUserId) {
      state.selectedUserId = Number(defaultCustomer.id);
    }

    renderUsersDropdown();
    applySelectedUserAddress(false);
    renderCategoriesPills();
    renderFoodsGrid();
    renderCart();
    await loadRouletteCandidates('all');

    // Giữ màn hình thoáng để khách chọn món ngay; chỉ hiện hành trình khi khách vừa đặt món xong hoặc chủ động mở
    const sessionOrderId = sessionStorage.getItem('last_placed_order_id');
    if (sessionOrderId && dom.orderTrackerSection) {
      dom.orderTrackerSection.classList.remove('hidden');
      await loadOrdersForSelectedUser(Number(sessionOrderId));
    } else if (dom.orderTrackerSection) {
      dom.orderTrackerSection.classList.add('hidden');
    }
  } catch (err) {
    console.error('[CustomerApp] loadAllInitialData error:', err);
    if (!silent) {
      applyDbStatusUI({
        connected: false,
        latencyMs: null,
        lastError: err?.message,
        code: err?.code || 'DB_OFFLINE',
      });
    }
  }
}

let foodSyncTimer = null;
let orderSyncTimer = null;

function scheduleRealtimeFoodSync(foodId, toastLabel) {
  if (foodSyncTimer) clearTimeout(foodSyncTimer);
  foodSyncTimer = setTimeout(async () => {
    await refreshFoodsOnly(foodId);
    if (toastLabel) {
      showToast('Thực đơn vừa cập nhật!', toastLabel, 'info');
    }
  }, 180);
}

function scheduleRealtimeOrderSync(orderId, newStatus) {
  // Chỉ đồng bộ khi khách hàng đã bấm đặt món và đang chủ động theo dõi đơn hàng này
  if (!state.activeOrderId) return;
  if (orderId && Number(orderId) !== Number(state.activeOrderId)) return;

  if (orderSyncTimer) clearTimeout(orderSyncTimer);
  orderSyncTimer = setTimeout(async () => {
    await loadActiveOrderDetail(state.activeOrderId);
    await loadOrdersForSelectedUser(state.activeOrderId);

    if (dom.orderTrackerSection) {
      dom.orderTrackerSection.classList.remove('hidden');
    }
    if (dom.trackerEmptyState) {
      dom.trackerEmptyState.classList.add('hidden');
    }
    if (dom.trackerActiveContent) {
      dom.trackerActiveContent.classList.remove('hidden');
    }

    if (Number(orderId) === Number(state.activeOrderId)) {
      playOrderStepSound();
      renderOrderTracker(true);
      flashElement(dom.orderTrackerSection);

      if (newStatus === 'Completed') {
        playSuccessChord();
        triggerNeonConfetti();
      }

      if (newStatus) {
        const meta = STATUS_META[newStatus];
        showToast(
          `Đơn hàng #${orderId} vừa cập nhật!`,
          meta ? meta.label : `Trạng thái mới: ${newStatus}`,
          newStatus === 'Cancelled' ? 'error' : 'success'
        );
      }
    }
  }, 160);
}

function setupRealtimeSubscription() {
  const client = createRealtimeClient({ transport: 'sse' });

  client.onStatusChange((snap) => {
    state.transport = snap.transport;
    if (dom.realtimeTransportBadge) {
      dom.realtimeTransportBadge.textContent = 'LIVE';
    }
  });

  // 1. Live Food CRUD & Stock Updates
  const handleFoodEvent = (envelope) => {
    const payload = envelope?.data || envelope || {};
    const record = payload.data || payload.food || payload;
    const foodId = record?.id ?? payload?.record_id ?? null;
    const foodName = record?.name ? `"${record.name}"` : foodId ? `Món #${foodId}` : 'Thực đơn';

    let actionDesc = `${foodName} vừa được cập nhật số lượng!`;
    if (envelope?.type === 'food:created') {
      actionDesc = `Món mới ${foodName} vừa được thêm vào thực đơn!`;
    } else if (envelope?.type === 'food:deleted') {
      actionDesc = `${foodName} vừa tạm ngừng phục vụ.`;
    }

    scheduleRealtimeFoodSync(foodId, actionDesc);
  };

  client.on('food:created', handleFoodEvent);
  client.on('food:updated', handleFoodEvent);
  client.on('food:deleted', handleFoodEvent);

  // 2. Live Order Status Updates
  const handleOrderEvent = (envelope) => {
    const payload = envelope?.data || envelope || {};
    const inner = payload.data || payload.order || payload;
    const orderId = inner?.order_id ?? inner?.id ?? payload?.record_id ?? null;
    const newStatus = inner?.new_status ?? inner?.status ?? null;

    if (envelope?.type === 'order:deleted') {
      if (state.orders.some((o) => Number(o.id) === Number(orderId))) {
        showToast(
          `Đơn hàng #${orderId} đã được dọn sạch`,
          'Đơn hàng không còn trong danh sách.',
          'info'
        );
        loadOrdersForSelectedUser();
      }
      return;
    }

    scheduleRealtimeOrderSync(orderId, newStatus);
  };

  client.on('order:created', handleOrderEvent);
  client.on('order:status_updated', handleOrderEvent);
  client.on('order:updated', handleOrderEvent);
  client.on('order:deleted', handleOrderEvent);

  // 3. Live DB Connection State Events
  const handleDbStateEvent = (envelope) => {
    const payload = envelope?.data || envelope || {};
    if (payload.offline === true || payload.simulatedOffline === true || payload.connected === false) {
      applyDbStatusUI({
        connected: false,
        latencyMs: null,
        lastError: 'Hệ thống đang đồng bộ kết nối...',
        code: 'DB_BUSY',
      });
    } else {
      pollDbHealth();
    }
  };

  client.on('db:status_changed', handleDbStateEvent);
  client.on('db:simulation_changed', handleDbStateEvent);
  client.on('db:config_changed', handleDbStateEvent);
  client.on('db:listener_changed', () => {
    pollDbHealth();
  });

  // 4. Real-time Database Health
  setInterval(pollDbHealth, 8000);
}

/* ==========================================================================
   DOM EVENT LISTENERS & BOOTSTRAP
   ========================================================================== */

function bindUiEvents() {
  bindRouletteEvents();

  if (window.self !== window.top && dom.navSplitMode) {
    dom.navSplitMode.classList.add('hidden');
  }

  if (dom.btnRetryHealth) {
    dom.btnRetryHealth.addEventListener('click', pollDbHealth);
  }

  if (dom.customerSelect) {
    dom.customerSelect.addEventListener('change', async () => {
      state.selectedUserId = Number(dom.customerSelect.value);
      localStorage.setItem(USER_STORAGE_KEY, String(state.selectedUserId));
      state.addressTouched = false;
      applySelectedUserAddress(true);
      state.activeOrderId = null;
      await loadOrdersForSelectedUser();
    });
  }

  dom.deliveryAddressInput.addEventListener('input', () => {
    state.addressTouched = true;
  });

  if (dom.customerNameInput) {
    dom.customerNameInput.addEventListener('input', () => {
      const name = dom.customerNameInput.value.trim() || 'Khách vãng lai';
      localStorage.setItem(CUSTOMER_NAME_KEY, name);
      if (dom.customerEmailInput && (!dom.customerEmailInput.value || dom.customerEmailInput.dataset.autoFilled === 'true')) {
        const slug = slugifyName(name);
        dom.customerEmailInput.value = `${slug}@gmail.com`;
        dom.customerEmailInput.dataset.autoFilled = 'true';
      }
      if (dom.headerCustomerNameDisplay) {
        dom.headerCustomerNameDisplay.textContent = name + ' (Bạn)';
      }
      triggerCustomerCheck();
    });
  }

  if (dom.customerPhoneInput) {
    dom.customerPhoneInput.addEventListener('input', () => {
      localStorage.setItem(CUSTOMER_PHONE_KEY, dom.customerPhoneInput.value.trim());
      triggerCustomerCheck();
    });
  }

  if (dom.customerEmailInput) {
    dom.customerEmailInput.addEventListener('input', () => {
      dom.customerEmailInput.dataset.autoFilled = 'false';
      localStorage.setItem(CUSTOMER_EMAIL_KEY, dom.customerEmailInput.value.trim());
      triggerCustomerCheck();
    });
  }

  if (dom.btnCallShipper) {
    dom.btnCallShipper.addEventListener('click', () => {
      playChimeSound(750, 1100);
      showToast(
        '📞 Đang kết nối tài xế',
        'Gọi tới tài xế Lê Hoàng Giao Nhanh: 0908.123.456 (Xe AirBlade 29-X1 888.88)',
        'info'
      );
    });
  }

  dom.menuSearchInput.addEventListener('input', () => {
    state.searchQuery = dom.menuSearchInput.value;
    dom.btnClearSearch.classList.toggle('hidden', !state.searchQuery);
    renderFoodsGrid();
  });

  dom.btnClearSearch.addEventListener('click', () => {
    state.searchQuery = '';
    dom.menuSearchInput.value = '';
    dom.btnClearSearch.classList.add('hidden');
    renderFoodsGrid();
  });

  dom.chkOnlyAvailable.addEventListener('change', () => {
    state.onlyAvailable = dom.chkOnlyAvailable.checked;
    renderFoodsGrid();
  });

  dom.btnClearCart.addEventListener('click', () => {
    state.cart = [];
    saveCartToStorage();
    renderCart();
    renderFoodsGrid();
  });

  dom.checkoutForm.addEventListener('submit', handleCheckoutSubmit);

  dom.activeOrderSelect.addEventListener('change', async () => {
    state.activeOrderId = Number(dom.activeOrderSelect.value) || null;
    await loadActiveOrderDetail(state.activeOrderId);
  });

  dom.btnRefreshTracker.addEventListener('click', () => {
    loadOrdersForSelectedUser(state.activeOrderId);
  });

  dom.btnToggleTrackerBody.addEventListener('click', () => {
    toggleTrackerCollapse();
  });
}

async function initCustomerApp() {
  refreshIcons();
  loadCartFromStorage();
  bindUiEvents();
  await loadAllInitialData();
  setupRealtimeSubscription();
}

initCustomerApp();
