import { CROPS, GARDEN_RULES } from './garden-state.js';

const byId = new Map(CROPS.map((crop) => [crop.id, crop]));
const clamp01 = (v) => Math.max(0, Math.min(1, Number(v) || 0));
const count = (v) => Math.max(0, Math.floor(Number(v) || 0));
const duration = (ms) => {
  if (!Number.isFinite(ms)) return '等待浇水';
  const sec = Math.max(0, Math.ceil(ms / 1000));
  if (sec < 60) return `${sec} 秒`;
  const min = Math.ceil(sec / 60);
  return min >= 60 ? `${Math.floor(min / 60)} 小时 ${min % 60} 分` : `${min} 分钟`;
};

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
function button(className, text, handler, label) {
  const node = el('button', className, text);
  node.type = 'button';
  if (label) node.setAttribute('aria-label', label);
  if (handler) node.addEventListener('click', handler);
  return node;
}

/** Garden presentation only. Actions and saved progression belong to the server. */
export function mountGardenUI({ onAction, onControl, onSelectPlot, onClose, onHomeAction } = {}) {
  let view = null;
  let open = false;
  let collapsed = false;
  let activeTab = 'grow';
  let selected = 0;
  let chosenCrop = CROPS[0]?.id || 'radish';
  let busy = false;
  let disposed = false;
  let feedbackMessage = '';
  let feedbackTone = '';

  const panel = el('section', 'garden-panel');
  panel.id = 'garden-panel';
  panel.hidden = true;
  panel.setAttribute('aria-label', '小蓝鱼的菜园');
  const header = el('header', 'garden-header');
  const heading = el('div', 'garden-heading');
  heading.append(el('p', 'garden-eyebrow', '后院小日子 · 从一粒种子开始'));
  heading.append(el('h2', '', '小蓝鱼的菜园'));
  const headerTools = el('div', 'garden-header-tools');
  const collapse = button('garden-icon-button', '−', () => {
    collapsed = !collapsed;
    renderVisibility();
  }, '收起菜园面板');
  collapse.setAttribute('aria-expanded', 'true');
  const close = button('garden-icon-button', '×', () => {
    setOpen(false);
    onClose?.();
  }, '返回小屋');
  headerTools.append(collapse, close);
  header.append(heading, headerTools);
  const statusStrip = el('div', 'garden-status-strip');
  const coins = el('strong', '', '—');
  const compost = el('strong', '', '—');
  const harvests = el('strong', '', '—');
  for (const [title, value] of [['金币', coins], ['堆肥', compost], ['已收获', harvests]]) {
    const item = el('div', 'garden-stat');
    item.append(el('span', '', title), value);
    statusStrip.append(item);
  }
  const body = el('div', 'garden-body');
  const stewardship = el('div', 'garden-stewardship');
  const stewardshipCopy = el('div', 'garden-stewardship-copy');
  const stewardshipTitle = el('strong', '', '小蓝鱼的照料安排');
  const stewardshipStatus = el('span', 'garden-stewardship-status', '正在看看她的安排…');
  stewardshipStatus.setAttribute('role', 'status');
  stewardshipStatus.setAttribute('aria-live', 'polite');
  stewardshipCopy.append(stewardshipTitle, stewardshipStatus);
  const stewardshipControls = el('div', 'garden-stewardship-controls');
  const autoToggle = button('garden-auto-toggle', '自主照料', () => invoke({ type: 'auto', enabled: !view?.care?.autoEnabled }, true));
  autoToggle.setAttribute('role', 'switch');
  autoToggle.setAttribute('aria-checked', 'false');
  autoToggle.setAttribute('aria-label', '小蓝鱼自主照料菜园');
  const callHer = button('garden-call-her', '请她来', () => invoke({ type: 'visit' }, true), '请小蓝鱼来菜园');
  const startCare = button('garden-start-care', '开始照料', () => startCareNow(), '让小蓝鱼现在放下手头的事去照料菜园');
  stewardshipControls.append(autoToggle, startCare, callHer);
  stewardship.append(stewardshipCopy, stewardshipControls);
  // 菜园里的通用相处功能。床、电视、房间导航等和屋子强绑定的入口不搬过来。
  const companionship = el('section', 'garden-companionship');
  const companionshipTitle = el('h3', 'garden-companionship-title', '和她相处');
  companionshipTitle.append(el('small', '', '走到田边也能陪她'));
  const socialGrid = el('div', 'garden-social-grid');
  for (const [action, label] of [
    ['pet', '摸摸头'], ['feed', '喂小鱼干'], ['water', '倒杯水'],
    ['play', '陪她玩'], ['talk', '留句话'], ['wake', '叫醒'],
    ['lamp', '灯']
  ]) {
    socialGrid.append(button('garden-social-button', label, () => onHomeAction?.(action), label));
  }
  companionship.append(companionshipTitle, socialGrid);
  companionship.append(el('p', 'garden-grab-hint', '按住小蓝鱼可以把她抱起来，松手放到菜园里的田边；开启开放或组合视角后可用 W/A/S/D 和方向键看她。'));
  const conflict = el('section', 'garden-conflict');
  conflict.hidden = true;
  conflict.setAttribute('role', 'alertdialog');
  conflict.setAttribute('aria-label', '菜园照料任务冲突');
  const conflictQuestion = el('p', 'garden-conflict-question');
  const conflictCountdown = el('span', 'garden-conflict-countdown');
  const conflictActions = el('div', 'garden-conflict-actions');
  const deferButton = button('garden-conflict-defer', '先做前面的事', () => resolveConflict('defer'));
  const forceButton = button('garden-conflict-force', '直接去照料', () => resolveConflict('force'));
  conflictActions.append(deferButton, forceButton);
  conflict.append(el('strong', 'garden-conflict-title', '先做哪件事？'), conflictQuestion, conflictCountdown, conflictActions);
  let conflictData = null;
  let conflictDeadline = 0;
  let conflictTimer = 0;
  const tabs = el('nav', 'garden-tabs');
  tabs.setAttribute('aria-label', '菜园功能');
  tabs.setAttribute('role', 'tablist');
  const tabButtons = new Map();
  const contents = new Map();
  for (const [id, label] of [['grow', '种植'], ['store', '仓库'], ['shop', '种子铺']]) {
    const tab = button('garden-tab', label, () => { activeTab = id; renderVisibility(); scroll.scrollTop = 0; });
    tab.id = `garden-tab-${id}`;
    tab.setAttribute('role', 'tab');
    tab.setAttribute('aria-controls', `garden-content-${id}`);
    tabButtons.set(id, tab);
    tabs.append(tab);
    const content = el('div', 'garden-tab-content');
    content.id = `garden-content-${id}`;
    content.setAttribute('role', 'tabpanel');
    content.setAttribute('aria-labelledby', tab.id);
    contents.set(id, content);
  }
  const scroll = el('div', 'garden-scroll');
  scroll.append(...contents.values());
  const feedback = el('p', 'garden-feedback');
  feedback.setAttribute('role', 'status');
  feedback.setAttribute('aria-live', 'polite');
  feedback.textContent = '正在看看菜园里的小苗…';
  body.append(tabs, scroll, feedback);
  panel.append(header, statusStrip, stewardship, companionship, conflict, body);
  document.body.append(panel);

  // Eight persistent plot controls remain focusable while the view is refreshed.
  const grow = contents.get('grow');
  const sectionTitle = el('div', 'garden-section-heading');
  const readySummary = el('span', 'garden-ready-summary');
  sectionTitle.append(el('h3', '', '我的八畦菜地'), readySummary);
  grow.append(sectionTitle);
  const plotGrid = el('div', 'garden-plot-grid');
  const plotControls = [];
  for (let id = 0; id < 8; id++) {
    const tile = button('garden-plot-tile', undefined, () => {
      selectPlot(id);
      onSelectPlot?.(id);
    });
    tile.id = `garden-select-plot-${id}`;
    const number = el('span', 'garden-plot-number', String(id + 1).padStart(2, '0'));
    const icon = el('span', 'garden-plot-icon', '·');
    icon.setAttribute('aria-hidden', 'true');
    const state = el('span', 'garden-plot-state', '待翻土');
    tile.append(number, icon, state);
    plotGrid.append(tile);
    plotControls.push({ tile, icon, state });
  }
  grow.append(plotGrid);

  const detail = el('section', 'garden-bed-detail');
  const detailHead = el('div', 'garden-detail-heading');
  const detailTitle = el('h3', '', '第 1 畦');
  const detailBadge = el('span', 'garden-stage-badge', '待翻土');
  detailHead.append(detailTitle, detailBadge);
  const detailDescription = el('p', 'garden-detail-description');
  const meters = el('div', 'garden-meters');
  function makeMeter(name, type) {
    const row = el('div', `garden-meter garden-meter-${type}`);
    const label = el('div', 'garden-meter-label');
    const value = el('span', 'garden-meter-value');
    label.append(el('span', '', name), value);
    const track = el('div', 'garden-meter-track');
    track.setAttribute('role', 'progressbar');
    track.setAttribute('aria-label', name);
    track.setAttribute('aria-valuemin', '0');
    track.setAttribute('aria-valuemax', '100');
    const fill = el('i');
    track.append(fill);
    row.append(label, track);
    meters.append(row);
    return { row, value, track, fill };
  }
  const progress = makeMeter('生长进度', 'growth');
  const moisture = makeMeter('土壤水分', 'water');
  const eta = el('p', 'garden-eta');
  const actionRow = el('div', 'garden-action-row');
  const actionButtons = new Map();
  for (const [type, label] of [['till', '翻松土壤'], ['plant', '播下种子'], ['water', '浇水'], ['fertilize', '施一份堆肥'], ['harvest', '采收这一畦']]) {
    const action = button(`garden-action ${['till', 'plant', 'harvest'].includes(type) ? 'garden-action-primary' : ''}`, label, () => {
      invoke({ type, plotId: selected, ...(type === 'plant' ? { cropId: chosenCrop } : {}) });
    });
    action.dataset.gardenAction = type;
    actionRow.append(action);
    actionButtons.set(type, action);
  }
  detail.append(detailHead, detailDescription, meters, eta, actionRow);
  grow.append(detail);

  const seedPicker = el('section', 'garden-seed-picker');
  const seedTitle = el('div', 'garden-section-heading');
  seedTitle.append(el('h3', '', '这一畦想种什么？'));
  const goShop = button('garden-text-button', '补充种子 →', () => { activeTab = 'shop'; renderVisibility(); scroll.scrollTop = 0; });
  seedTitle.append(goShop);
  seedPicker.append(seedTitle);
  const cropGrid = el('div', 'garden-crop-grid');
  const cropControls = new Map();
  for (const crop of CROPS) {
    const tile = button('garden-crop-tile', undefined, () => { chosenCrop = crop.id; render(); });
    tile.id = `garden-crop-${crop.id}`;
    const icon = el('span', 'garden-crop-icon', crop.icon || '🌱');
    icon.setAttribute('aria-hidden', 'true');
    const name = el('span', 'garden-crop-name', crop.name);
    const info = el('span', 'garden-crop-info');
    tile.append(icon, name, info);
    cropGrid.append(tile);
    cropControls.set(crop.id, { tile, info });
  }
  seedPicker.append(cropGrid);
  grow.append(seedPicker);

  const care = el('details', 'garden-care');
  care.append(el('summary', '', '种菜小手册'));
  const careCopy = el('div', 'garden-care-copy');
  careCopy.append(
    el('p', 'garden-care-steps', '翻土 → 播种 → 浇水 → 成长 → 收获'),
    el('p', '', '缺水时小苗会暂停生长，浇水后继续；离开页面也会按土壤水分计算成长，不会枯死。'),
    el('p', '', '每一茬可施肥一次，帮助作物生长并增加收成。成熟后采收，果蔬会存进仓库。'),
    el('p', '', '把收成出售换金币，再去种子铺补充种子和堆肥。采收后的菜地可以接着播种。')
  );
  careCopy.append(el('p', '', '开启自主照料后，小蓝鱼会走到菜园安排翻土、播种、浇水、施肥和采收，也会出售收成、补充种子与堆肥。累了、饿了或睡觉时，她会先照顾自己；你仍然可以随时帮忙。'));
  care.append(careCopy);
  grow.append(care);

  const store = contents.get('store');
  const storageLead = el('div', 'garden-tab-intro');
  const storageCount = el('strong', '', '0');
  storageLead.append(el('span', 'garden-kicker', '把今天的收成好好收起来'), storageCount, el('span', 'garden-storage-unit', '份果蔬在仓库'));
  store.append(storageLead);
  const storageRows = new Map();
  const emptyStorage = el('p', 'garden-empty', '还没有收成。第 1 畦的萝卜已经成熟，去摘下第一份快乐吧。');
  store.append(emptyStorage);
  const inventoryList = el('div', 'garden-inventory-list');
  for (const crop of CROPS) {
    const row = el('div', 'garden-inventory-row');
    const icon = el('span', 'garden-list-icon', crop.icon || '🌱');
    icon.setAttribute('aria-hidden', 'true');
    const copy = el('div', 'garden-list-copy');
    const stock = el('span', 'garden-list-meta');
    copy.append(el('strong', '', crop.name), stock);
    const sell = button('garden-small-button', '出售全部', () => {
      invoke({ type: 'sell', cropId: crop.id, quantity: Math.min(99, count(view?.inventory?.[crop.id])) });
    }, `出售全部${crop.name}`);
    row.append(icon, copy, sell);
    inventoryList.append(row);
    storageRows.set(crop.id, { row, stock, sell });
  }
  store.append(inventoryList);
  const logHeading = el('div', 'garden-section-heading garden-log-heading');
  logHeading.append(el('h3', '', '菜园日记'));
  const logList = el('ol', 'garden-log');
  store.append(logHeading, logList);
  let lastLogKey = '';

  const shop = contents.get('shop');
  const shopLead = el('div', 'garden-shop-intro');
  shopLead.append(el('h3', '', '下一茬，种一点新鲜的'), el('p', '', '12 种作物慢慢养，种子买下后可以随时播种。'));
  shop.append(shopLead);
  const shopList = el('div', 'garden-shop-list');
  const shopRows = new Map();
  for (const crop of CROPS) {
    const row = el('div', 'garden-shop-row');
    const icon = el('span', 'garden-list-icon', crop.icon || '🌱');
    icon.setAttribute('aria-hidden', 'true');
    const copy = el('div', 'garden-list-copy');
    const name = el('strong', '', crop.name);
    const meta = el('span', 'garden-list-meta');
    const yieldText = Array.isArray(crop.yield) ? crop.yield.join('–') : crop.yield;
    meta.textContent = `约 ${duration(crop.growMs)} · 收获 ${yieldText || '多'} 份`;
    const held = el('span', 'garden-shop-held');
    copy.append(name, meta, held);
    const buy = button('garden-small-button', `${crop.seedCost} 金币`, () => invoke({ type: 'buySeed', cropId: crop.id, quantity: 1 }), `购买一份${crop.name}种子，${crop.seedCost}金币`);
    row.append(icon, copy, buy);
    shopList.append(row);
    shopRows.set(crop.id, { held, buy });
  }
  const compostRow = el('div', 'garden-compost-card');
  const compostCopy = el('div', 'garden-list-copy');
  compostCopy.append(el('strong', '', '天然堆肥'), el('span', 'garden-list-meta', '每茬施一次，让小苗长得更好'));
  const buyCompost = button('garden-small-button', '购买一份', () => invoke({ type: 'buyCompost', quantity: 1 }), '购买一份堆肥');
  compostRow.append(el('span', 'garden-list-icon', '🍂'), compostCopy, buyCompost);
  shop.append(shopList, compostRow);

  function updateConflictCountdown() {
    if (!conflictData) return;
    const left = Math.max(0, Math.ceil((conflictDeadline - Date.now()) / 1000));
    conflictCountdown.textContent = left > 0 ? `${left} 秒内不回答，她会自己决定` : '30 秒到了，让她自己决定';
    if (left <= 0) {
      conflictCountdown.textContent = '30 秒到了，让她自己决定';
      if (conflictTimer) clearInterval(conflictTimer);
      conflictTimer = 0;
    }
  }
  function hideConflict() {
    conflict.hidden = true;
    conflictData = null;
    conflictDeadline = 0;
    if (conflictTimer) clearInterval(conflictTimer);
    conflictTimer = 0;
  }
  function showConflict(pending) {
    if (!pending || !pending.id) { hideConflict(); return; }
    if (conflictData?.id === pending.id) {
      conflict.hidden = false;
      if (!conflictTimer && conflictDeadline > Date.now()) {
        conflictTimer = setInterval(updateConflictCountdown, 1000);
        updateConflictCountdown();
      }
      return;
    }
    conflict.hidden = false;
    conflictData = pending;
    conflictDeadline = Number(pending.deadline) || Date.now() + 30_000;
    conflictQuestion.textContent = pending.question || '她现在手头有事，要先做还是直接去照料？';
    conflict.hidden = false;
    if (conflictTimer) clearInterval(conflictTimer);
    updateConflictCountdown();
    conflictTimer = setInterval(updateConflictCountdown, 1000);
  }
  async function resolveConflict(decision) {
    if (busy || !conflictData) return;
    const pending = conflictData;
    hideConflict();
    busy = true;
    feedbackMessage = decision === 'force' ? '你让她直接去菜园…' : '先让她做完手头的事…';
    feedbackTone = '';
    render();
    try {
      const result = await onControl?.({ type: 'careNow', decision, conflictId: pending.id });
      if (disposed) return;
      feedbackMessage = result?.message || '已经记下了。';
      feedbackTone = result?.ok === false ? 'warning' : 'success';
    } catch {
      feedbackMessage = '这次没能记下，检查连接后再试一次。';
      feedbackTone = 'warning';
    } finally {
      busy = false;
      if (!disposed) render();
    }
  }
  async function startCareNow() {
    if (busy || !view || disposed) return;
    busy = true;
    feedbackMessage = '正在告诉她先去菜园…';
    feedbackTone = '';
    render();
    try {
      const result = await onControl?.({ type: 'careNow' });
      if (disposed) return;
      if (result?.conflict && result.pending) {
        showConflict(result.pending);
        feedbackMessage = '她手头还有事，先问问你。';
        feedbackTone = 'warning';
      } else {
        feedbackMessage = result?.message || '她已经在照料菜园了。';
        feedbackTone = result?.ok === false ? 'warning' : 'success';
      }
    } catch {
      feedbackMessage = '这次没能安排，检查连接后再试一次。';
      feedbackTone = 'warning';
    } finally {
      busy = false;
      if (!disposed) render();
    }
  }

  function status(plot) {
    if (!plot?.cropId) return plot?.tilled ? '待播种' : '待翻土';
    if (plot.mature) return '可收获';
    if (plot.moisture <= 0) return '需要浇水';
    return ['种子入土', '小苗冒头', '茁壮生长', '即将成熟'][Math.min(3, count(plot.stage))];
  }
  function updateMeter(control, value) {
    const percent = Math.round(clamp01(value) * 100);
    control.value.textContent = `${percent}%`;
    control.fill.style.width = `${percent}%`;
    control.track.setAttribute('aria-valuenow', String(percent));
  }
  async function invoke(action, isControl = false) {
    if (busy || !view || disposed) return;
    busy = true;
    feedbackTone = '';
    feedbackMessage = isControl ? '正在告诉小蓝鱼…' : '正在照料这片小菜园…';
    render();
    try {
      const result = await (isControl ? onControl?.(action) : onAction?.(action));
      if (disposed) return;
      feedbackMessage = result?.message || (result?.ok === false ? '这一步还没有完成，请再试一次。' : '照料完成。');
      feedbackTone = result?.ok === false ? 'warning' : 'success';
    } catch {
      feedbackMessage = '这次没能保存，检查连接后再试一次。';
      feedbackTone = 'warning';
    } finally {
      busy = false;
      if (!disposed) render();
    }
  }
  function renderVisibility() {
    panel.hidden = !open;
    panel.classList.toggle('is-collapsed', collapsed);
    document.body.classList.toggle('garden-open', open);
    body.hidden = collapsed;
    statusStrip.hidden = collapsed;
    stewardship.hidden = collapsed;
    companionship.hidden = collapsed;
    if (collapsed && conflictTimer) { clearInterval(conflictTimer); conflictTimer = 0; }
    conflict.hidden = collapsed || !conflictData;
    collapse.textContent = collapsed ? '+' : '−';
    collapse.setAttribute('aria-label', collapsed ? '展开菜园面板' : '收起菜园面板');
    collapse.setAttribute('aria-expanded', String(!collapsed));
    for (const [id, tab] of tabButtons) {
      tab.classList.toggle('active', id === activeTab);
      tab.setAttribute('aria-selected', String(id === activeTab));
      contents.get(id).hidden = id !== activeTab;
    }
  }
  function render() {
    renderVisibility();
    panel.setAttribute('aria-busy', String(busy || !view));
    if (!view) return;
    const care = view.care;
    const careEnabled = care?.autoEnabled === true;
    autoToggle.classList.toggle('is-on', careEnabled);
    autoToggle.setAttribute('aria-checked', String(careEnabled));
    autoToggle.title = careEnabled ? '暂停小蓝鱼自主照料；手动操作仍然可用' : '让小蓝鱼自行安排种植、采收和补给';
    autoToggle.disabled = busy || !care;
    startCare.disabled = busy || !care;
    startCare.classList.toggle('is-caring', care?.task?.source === 'auto' || care?.queue > 0);
    if (view?.care?.pendingConflict) showConflict(view.care.pendingConflict); else if (!conflictTimer) hideConflict();
    callHer.disabled = busy || !care || care.task?.type === 'visit';
    stewardshipTitle.textContent = careEnabled ? '小蓝鱼 · 自主照料中' : '小蓝鱼 · 自主照料已暂停';
    const task = care?.task;
    const workNames = { till: '翻松土壤', plant: '播种', water: '浇水', fertilize: '施肥', harvest: '采收', sell: '出售收成', buySeed: '补充种子', buyCompost: '补充堆肥', visit: '来菜园散步' };
    const taskPlace = Number.isInteger(task?.plotId) ? `第 ${task.plotId + 1} 畦 · ` : '';
    const taskText = task ? `${task.phase === 'walking' ? '正在前往' : '正在'}${taskPlace}${workNames[task.type] || '照料菜园'}` : '';
    const careStatus = typeof care?.status === 'string' ? care.status : '';
    const statusText = taskText || careStatus || (careEnabled ? '她会在有空时照顾小苗' : '点击“请她来”，一起看看小苗');
    const queueSize = Array.isArray(care?.queued) ? care.queued.length : count(care?.queued);
    stewardshipStatus.textContent = statusText + (queueSize ? ` · 另有 ${queueSize} 项安排` : '');
    stewardshipStatus.title = stewardshipStatus.textContent;
    callHer.textContent = care?.character?.room === 'garden' && !care.character.walking ? '她在菜园' : '请她来';
    coins.textContent = count(view.coins).toLocaleString();
    compost.textContent = count(view.compost).toLocaleString();
    harvests.textContent = `${count(view.stats?.totalYield)} 份`;
    const plots = Array.isArray(view.plots) ? view.plots : [];
    const ripeCount = plots.filter((plot) => plot.mature).length;
    readySummary.textContent = ripeCount ? `${ripeCount} 畦可采收` : '点菜地，也可点场景';
    for (let id = 0; id < 8; id++) {
      const plot = plots.find((item) => item.id === id);
      const crop = byId.get(plot?.cropId);
      const control = plotControls[id];
      const state = status(plot);
      control.tile.classList.toggle('selected', id === selected);
      control.tile.classList.toggle('is-ripe', !!plot?.mature);
      control.tile.classList.toggle('is-dry', !!plot?.cropId && !plot.mature && plot.moisture <= 0);
      control.tile.setAttribute('aria-pressed', String(id === selected));
      control.tile.setAttribute('aria-label', `第 ${id + 1} 畦，${crop?.name || '空菜地'}，${state}`);
      control.icon.textContent = crop ? (crop.icon || '🌱') : (plot?.tilled ? '〰' : '+');
      control.state.textContent = plot?.mature ? '可收获' : crop?.name || state;
      control.tile.disabled = busy;
    }
    const plot = plots.find((item) => item.id === selected);
    const crop = byId.get(plot?.cropId);
    const seed = byId.get(chosenCrop) || CROPS[0];
    const state = status(plot);
    detailTitle.textContent = `第 ${selected + 1} 畦${crop ? ` · ${crop.name}` : ''}`;
    detailBadge.textContent = state;
    detailBadge.classList.toggle('is-ripe', !!plot?.mature);
    detailBadge.classList.toggle('is-dry', !!plot?.cropId && !plot.mature && plot.moisture <= 0);
    if (plot?.mature) detailDescription.textContent = `${crop.name}长好了，把这一份新鲜收入篮子吧。`;
    else if (crop) detailDescription.textContent = plot.moisture <= 0 ? '土壤有点干，小苗在等一壶水。' : (plot.fertilized ? '堆肥已经施好，水分充足时会继续成长。' : '给小苗一点水和耐心，它会慢慢长大。');
    else if (plot?.tilled) detailDescription.textContent = `土壤松软，准备种下${seed?.name || '新的作物'}。`;
    else detailDescription.textContent = '先松一松土，让种子有个舒适的小窝。';
    meters.hidden = !crop;
    if (crop) {
      updateMeter(progress, plot.progress);
      updateMeter(moisture, plot.moisture);
      moisture.row.classList.toggle('is-dry', plot.moisture <= 0.2);
    }
    eta.textContent = !crop ? '翻土 → 播种 → 浇水 → 收获' : plot.mature ? '成熟作物会留在地里，等你来采。' : plot.moisture <= 0 ? '生长暂停 · 浇水后继续' : `水分充足时，约 ${duration(plot.remainingMs)} 后可收获`;
    seedPicker.hidden = !!crop;
    const actionVisibility = { till: !crop && !plot?.tilled, plant: !crop && !!plot?.tilled, water: !!crop && !plot?.mature, fertilize: !!crop && !plot?.mature, harvest: !!plot?.mature };
    for (const [type, node] of actionButtons) {
      node.hidden = !actionVisibility[type];
      node.disabled = busy || !plot;
      if (type === 'plant') {
        node.textContent = count(view.seeds?.[chosenCrop]) ? `播种${seed?.name || ''} · 1 份种子` : '种子不足，请去种子铺';
        node.disabled ||= !count(view.seeds?.[chosenCrop]);
      }
      if (type === 'water') {
        node.textContent = plot?.moisture >= 0.98 ? '水分充足' : '给这畦浇水';
        node.disabled ||= plot?.moisture >= 0.98;
      }
      if (type === 'fertilize') {
        node.textContent = plot?.fertilized ? '本茬已施肥' : count(view.compost) ? '施肥 · 1 份堆肥' : '堆肥用完了';
        node.disabled ||= !!plot?.fertilized || !count(view.compost);
      }
    }
    for (const crop of CROPS) {
      const control = cropControls.get(crop.id);
      const quantity = count(view.seeds?.[crop.id]);
      control.tile.classList.toggle('selected', crop.id === chosenCrop);
      control.tile.setAttribute('aria-pressed', String(crop.id === chosenCrop));
      control.tile.setAttribute('aria-label', `选择${crop.name}，现有 ${quantity} 份种子，约 ${duration(crop.growMs)}成熟`);
      control.tile.disabled = busy;
      control.info.textContent = `${quantity} 份 · ${duration(crop.growMs)}`;
      const stock = count(view.inventory?.[crop.id]);
      const row = storageRows.get(crop.id);
      row.row.hidden = !stock;
      row.stock.textContent = `${stock} 份 · 共值 ${stock * crop.sellPrice} 金币`;
      row.sell.textContent = stock > 99 ? '出售 99 份' : '出售全部';
      row.sell.setAttribute('aria-label', stock > 99 ? `出售 99 份${crop.name}` : `出售全部${crop.name}`);
      row.sell.disabled = busy || !stock;
      const shopRow = shopRows.get(crop.id);
      shopRow.held.textContent = `已有 ${quantity} 份种子`;
      shopRow.buy.disabled = busy || count(view.coins) < crop.seedCost;
    }
    const compostCost = GARDEN_RULES.compostCost;
    buyCompost.disabled = busy || count(view.coins) < compostCost;
    buyCompost.textContent = `${compostCost} 金币`;
    buyCompost.setAttribute('aria-label', `购买一份堆肥，${compostCost}金币`);
    const stockTotal = CROPS.reduce((sum, crop) => sum + count(view.inventory?.[crop.id]), 0);
    storageCount.textContent = stockTotal.toLocaleString();
    emptyStorage.hidden = stockTotal > 0;
    if (!stockTotal && count(view.stats?.harvests) > 0) emptyStorage.textContent = '仓库空空的。收获后的果蔬会存放在这里。';
    const logs = Array.isArray(view.log) ? view.log.slice(-8).reverse() : [];
    const logKey = JSON.stringify(logs);
    if (lastLogKey !== logKey) {
      lastLogKey = logKey;
      logList.replaceChildren();
      for (const entry of logs) {
        const row = el('li');
        const stamp = new Date(entry.at);
        const time = Number.isFinite(stamp.getTime()) ? stamp.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) : '';
        row.append(el('time', '', time), el('span', '', String(entry.text || '')));
        logList.append(row);
      }
      if (!logs.length) logList.append(el('li', 'garden-log-empty', '第一篇菜园日记，等你来写。'));
    }
    feedback.className = `garden-feedback ${feedbackTone ? `is-${feedbackTone}` : ''}`;
    feedback.textContent = feedbackMessage || (ripeCount ? '有作物成熟了，选中金色菜地就可以采收。' : '不必一直守着，小苗会安静地长大。');
  }
  function setView(nextView) {
    if (disposed || !nextView || !Array.isArray(nextView.plots)) return;
    view = nextView;
    render();
  }
  function setOpen(value) {
    if (disposed) return;
    open = !!value;
    if (open) collapsed = false;
    renderVisibility();
  }
  function selectPlot(id) {
    const next = Number(id);
    if (!Number.isInteger(next) || next < 0 || next > 7 || disposed) return;
    if (next !== selected || activeTab !== 'grow') scroll.scrollTop = 0;
    selected = next;
    activeTab = 'grow';
    collapsed = false;
    feedbackMessage = '';
    feedbackTone = '';
    render();
  }
  const onKey = (event) => {
    if (event.key === 'Escape') { setOpen(false); onClose?.(); }
    event.stopPropagation();
  };
  panel.addEventListener('keydown', onKey);
  renderVisibility();
  return {
    setView,
    setOpen,
    selectPlot,
    destroy() {
      disposed = true;
      panel.removeEventListener('keydown', onKey);
      panel.remove();
      document.body.classList.remove('garden-open');
    }
  };
}
