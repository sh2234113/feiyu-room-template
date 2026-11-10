// 海风菜园：纯状态机。浏览器与服务端共享作物目录，时间及存档以服务端为准。
// advanceGarden 不修改输入；水分只在实际生长时消耗，离线结算与逐次结算等价。
const MINUTE = 60_000;
const MAX_STOCK = 1_000_000_000;
const EPSILON = 1e-10;

export const GARDEN_RULES = Object.freeze({
  version: 1, plotCount: 8, compostCost: 8,
  waterDurationFactor: 0.75, fertilizerGrowth: 1.2, fertilizerYield: 2
});

export const CROPS = Object.freeze([
  { id: 'radish', name: '小萝卜', icon: '🥬', color: 0xdb5268, growMs: 2 * MINUTE, seedCost: 2, sellPrice: 2, yield: 3, type: 'root', description: '最先成熟的入门作物，饱满的红萝卜藏在叶丛下。' },
  { id: 'carrot', name: '胡萝卜', icon: '🥕', color: 0xe98935, growMs: 4 * MINUTE, seedCost: 3, sellPrice: 3, yield: 3, type: 'root', description: '羽状叶逐渐长高，成熟后可以拔出橙色根茎。' },
  { id: 'lettuce', name: '生菜', icon: '🥬', color: 0x83b84d, growMs: 3 * MINUTE, seedCost: 2, sellPrice: 2, yield: 4, type: 'leaf', description: '层层嫩叶向外舒展，适合快速补满菜篮。' },
  { id: 'tomato', name: '番茄', icon: '🍅', color: 0xd94b35, growMs: 6 * MINUTE, seedCost: 4, sellPrice: 4, yield: 4, type: 'fruit', description: '沿支架长大，从绿叶间结出一串红果实。' },
  { id: 'cucumber', name: '黄瓜', icon: '🥒', color: 0x43804b, growMs: 7 * MINUTE, seedCost: 4, sellPrice: 4, yield: 4, type: 'vine', description: '藤蔓攀着竹架向上，垂下细长的翠绿黄瓜。' },
  { id: 'eggplant', name: '茄子', icon: '🍆', color: 0x714078, growMs: 9 * MINUTE, seedCost: 5, sellPrice: 5, yield: 4, type: 'fruit', description: '宽大的叶片下面，长出有光泽的紫色茄子。' },
  { id: 'pepper', name: '甜椒', icon: '🫑', color: 0xde7840, growMs: 8 * MINUTE, seedCost: 5, sellPrice: 5, yield: 4, type: 'fruit', description: '小巧的灌丛里结出厚实甜椒，成熟时色彩鲜亮。' },
  { id: 'pumpkin', name: '南瓜', icon: '🎃', color: 0xd68c31, growMs: 12 * MINUTE, seedCost: 7, sellPrice: 9, yield: 3, type: 'vine', description: '藤叶铺满土面，等待几颗带棱纹的大南瓜长成。' },
  { id: 'corn', name: '玉米', icon: '🌽', color: 0xe6bd50, growMs: 10 * MINUTE, seedCost: 6, sellPrice: 6, yield: 4, type: 'corn', description: '挺拔的秆叶和金黄玉米棒，是菜园里最高的风景。' },
  { id: 'strawberry', name: '草莓', icon: '🍓', color: 0xdc4e62, growMs: 6 * MINUTE, seedCost: 5, sellPrice: 5, yield: 5, type: 'berry', description: '矮矮的叶丛开花结果，红草莓成熟后一次收进篮子。' },
  { id: 'potato', name: '土豆', icon: '🥔', color: 0xb18a54, growMs: 8 * MINUTE, seedCost: 4, sellPrice: 4, yield: 5, type: 'root', description: '地上的叶丛慢慢茂盛，收获时挖出一窝土豆。' },
  { id: 'cabbage', name: '卷心菜', icon: '🥬', color: 0x8bac66, growMs: 11 * MINUTE, seedCost: 6, sellPrice: 7, yield: 4, type: 'leaf', description: '叶片一层层抱拢，最终长成圆滚滚的菜球。' }
].map((crop) => Object.freeze(crop)));

const CROP_BY_ID = new Map(CROPS.map((crop) => [crop.id, crop]));
const object = (value) => !!value && typeof value === 'object' && !Array.isArray(value);
const finite = (value, fallback = 0) => typeof value === 'number' && Number.isFinite(value) ? value : fallback;
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const stock = (value, fallback = 0) => Math.floor(clamp(finite(value, fallback), 0, MAX_STOCK));
const timestamp = (value, fallback) => Math.floor(clamp(finite(value, fallback), 0, Number.MAX_SAFE_INTEGER));
const getNow = (now) => timestamp(now, Date.now());
const emptyPlot = (id) => ({ id, tilled: false, cropId: null, progress: 0, moisture: 0, fertilized: false, plantedAt: null });
const cropStocks = (value, fallback = 0) => Object.fromEntries(CROPS.map((crop) => [crop.id, stock(object(value) ? value[crop.id] : undefined, fallback)]));

// Care metadata travels with every manual transaction. Completion receipts and
// harvested inventory therefore share one atomic server save.
export function normalizeGardenCare(raw = {}) {
  const clean = (v, n=160) => typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, '').slice(0,n) : '';
  const action = (v) => {
    if (!object(v) || !['till','plant','water','fertilize','harvest','sell','buySeed','buyCompost','visit'].includes(v.type)) return null;
    const out = {type:v.type};
    if (Number.isInteger(v.plotId) && v.plotId>=0 && v.plotId<8) out.plotId=v.plotId;
    if (CROP_BY_ID.has(v.cropId)) out.cropId=v.cropId;
    if (Number.isInteger(v.quantity) && v.quantity>=1 && v.quantity<=99) out.quantity=v.quantity;
    return out;
  };
  const job = (v) => {
    if (!object(v) || !clean(v.id,96) || !action(v.action)) return null;
    return {id:clean(v.id,96),requestId:clean(v.requestId,96),action:action(v.action),source:v.source==='requested'?'requested':'auto',phase:['queued','walking','working'].includes(v.phase)?v.phase:'queued',createdAt:timestamp(v.createdAt,0),startedAt:timestamp(v.startedAt,0),workUntil:timestamp(v.workUntil,0),fingerprint:clean(v.fingerprint,160),expectedPlot:object(v.expectedPlot)?{cropId:CROP_BY_ID.has(v.expectedPlot.cropId)?v.expectedPlot.cropId:null,plantedAt:v.expectedPlot.plantedAt===null?null:timestamp(v.expectedPlot.plantedAt,0)}:null};
  };
  return {
    autoEnabled:raw?.autoEnabled!==false,nextId:stock(raw?.nextId),rotation:stock(raw?.rotation),nextPlanAt:timestamp(raw?.nextPlanAt,0),
    forceUntil:timestamp(raw?.forceUntil,0),
    status:clean(raw?.status)||'小蓝鱼会在空闲时照料菜园',
    pendingConflict:(()=>{
      const c=raw?.pendingConflict;
      if(!object(c)||!clean(c.id,64)||!clean(c.question,260))return null;
      return {id:clean(c.id,64),question:clean(c.question,260),kind:clean(c.kind,32),createdAt:timestamp(c.createdAt,0),deadline:timestamp(c.deadline,0),defaultDecision:c.defaultDecision==='force'?'force':'defer'};
    })(),
    task:job(raw?.task),queue:(Array.isArray(raw?.queue)?raw.queue:[]).map(job).filter(Boolean).slice(0,16),
    receipts:(Array.isArray(raw?.receipts)?raw.receipts:[]).filter(v=>object(v)&&clean(v.requestId,96)).slice(-64).map(v=>({requestId:clean(v.requestId,96),jobId:clean(v.jobId,96),fingerprint:clean(v.fingerprint,160),status:['queued','completed','failed','cancelled'].includes(v.status)?v.status:'failed',message:clean(v.message),at:timestamp(v.at,0)})),
    recent:(Array.isArray(raw?.recent)?raw.recent:[]).filter(v=>object(v)&&clean(v.id,96)).slice(-16).map(v=>({id:clean(v.id,96),type:clean(v.type,24),ok:v.ok===true,message:clean(v.message),at:timestamp(v.at,0)}))
  };
}

export function createGarden(now = Date.now()) {
  const at = getNow(now);
  const plots = Array.from({ length: GARDEN_RULES.plotCount }, (_, id) => emptyPlot(id));
  plots[0] = { id: 0, tilled: true, cropId: 'radish', progress: 1, moisture: 0.4, fertilized: false, plantedAt: Math.max(0, at - 2 * MINUTE) };
  plots[1] = { id: 1, tilled: true, cropId: 'lettuce', progress: 0.4, moisture: 0.5, fertilized: false, plantedAt: Math.max(0, at - 1.2 * MINUTE) };
  plots[2] = { id: 2, tilled: true, cropId: 'tomato', progress: 0.7, moisture: 0.5, fertilized: false, plantedAt: Math.max(0, at - 4.2 * MINUTE) };
  plots[3] = { id: 3, tilled: true, cropId: 'carrot', progress: 0.25, moisture: 0.65, fertilized: false, plantedAt: Math.max(0, at - MINUTE) };
  return {
    version: GARDEN_RULES.version, updatedAt: at, coins: 36,
    seeds: cropStocks(null, 3), inventory: cropStocks(null), compost: 3,
    plots, care: normalizeGardenCare(), stats: { harvests: 0, totalYield: 0 },
    log: [{ at, text: '菜园开张了：小萝卜已成熟，生菜、番茄和胡萝卜正在长大；另有四块田等你播种。' }]
  };
}

// Repair only recognized fields. Existing incomplete saves never gain another
// starter harvest; the four demonstration crops are created only for a new save.
export function normalizeGarden(raw, now = Date.now()) {
  if (!object(raw)) return createGarden(now);
  const at = getNow(now);
  const updatedAt = timestamp(raw.updatedAt, at);
  const candidates = Array.isArray(raw.plots) ? raw.plots : [];
  const plots = Array.from({ length: GARDEN_RULES.plotCount }, (_, id) => {
    const saved = candidates.find((p) => object(p) && p.id === id);
    if (!saved) return emptyPlot(id);
    const crop = CROP_BY_ID.get(saved.cropId);
    if (!crop) return { ...emptyPlot(id), tilled: saved.tilled === true };
    return {
      id, tilled: true, cropId: crop.id,
      progress: clamp(finite(saved.progress), 0, 1),
      moisture: clamp(finite(saved.moisture), 0, 1),
      fertilized: saved.fertilized === true,
      plantedAt: timestamp(saved.plantedAt, updatedAt)
    };
  });
  return {
    version: GARDEN_RULES.version, updatedAt,
    coins: stock(raw.coins), seeds: cropStocks(raw.seeds),
    inventory: cropStocks(raw.inventory), compost: stock(raw.compost),
    plots, care: normalizeGardenCare(raw.care),
    stats: { harvests: stock(raw.stats?.harvests), totalYield: stock(raw.stats?.totalYield) },
    log: (Array.isArray(raw.log) ? raw.log : []).filter((entry) => object(entry) && typeof entry.text === 'string')
      .slice(-30).map((entry) => ({ at: timestamp(entry.at, updatedAt), text: entry.text.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 160) }))
  };
}

export function advanceGarden(raw, now = Date.now()) {
  const state = normalizeGarden(raw, now);
  const at = Math.max(getNow(now), state.updatedAt);
  const elapsed = at - state.updatedAt;
  if (elapsed > 0) {
    for (const plot of state.plots) {
      const crop = CROP_BY_ID.get(plot.cropId);
      if (!crop || plot.progress >= 1 || plot.moisture <= 0) continue;
      const rate = plot.fertilized ? GARDEN_RULES.fertilizerGrowth : 1;
      const waterDuration = crop.growMs * GARDEN_RULES.waterDurationFactor;
      const activeMs = Math.min(elapsed, plot.moisture * waterDuration, (1 - plot.progress) * crop.growMs / rate);
      plot.progress = Math.min(1, plot.progress + activeMs * rate / crop.growMs);
      plot.moisture = Math.max(0, plot.moisture - activeMs / waterDuration);
      if (plot.progress >= 1 - EPSILON) plot.progress = 1;
      if (plot.moisture < EPSILON) plot.moisture = 0;
    }
  }
  state.updatedAt = at;
  return state;
}

function addLog(state, text) {
  state.log.push({ at: state.updatedAt, text });
  state.log = state.log.slice(-30);
}

// Failure settles natural elapsed time but never spends coins, consumes stock,
// creates rewards, or partially applies an action. Commands cannot supply time.
export function applyGardenAction(raw, action, now = Date.now()) {
  const state = advanceGarden(raw, now);
  const fail = (message) => ({ state, ok: false, message });
  const done = (message) => { addLog(state, message); return { state, ok: true, message }; };
  if (!object(action) || typeof action.type !== 'string') return fail('没有识别出这个菜园操作。');
  const plotActions = ['till', 'plant', 'water', 'fertilize', 'harvest'];
  let plot;
  if (plotActions.includes(action.type)) {
    if (!Number.isInteger(action.plotId) || action.plotId < 0 || action.plotId >= GARDEN_RULES.plotCount) return fail('这块田地不存在。');
    plot = state.plots[action.plotId];
  }
  const crop = CROP_BY_ID.get(action.cropId);
  const quantity = action.quantity === undefined ? 1 : action.quantity;
  if (['buySeed', 'sell', 'buyCompost'].includes(action.type) && (!Number.isInteger(quantity) || quantity < 1 || quantity > 99)) return fail('每次数量需要是 1 到 99 的整数。');

  if (action.type === 'till') {
    if (plot.cropId) return fail('这里已经种着作物，先等它成熟再收获。');
    if (plot.tilled) return fail('这块田已经松好土，可以直接播种。');
    plot.tilled = true;
    return done(`${plot.id + 1} 号田已松土，挑一种喜欢的种子吧。`);
  }
  if (action.type === 'plant') {
    if (!crop) return fail('这种种子暂时不在种子铺里。');
    if (plot.cropId) return fail('这里已经种着作物，不能重复播种。');
    if (!plot.tilled) return fail('先松土，种子才能住进这块田。');
    if (state.seeds[crop.id] < 1) return fail(`${crop.name}种子用完了，去种子铺补充一些。`);
    state.seeds[crop.id] -= 1;
    Object.assign(plot, { cropId: crop.id, progress: 0, moisture: 0.8, fertilized: false, plantedAt: state.updatedAt });
    return done(`${plot.id + 1} 号田种下了${crop.name}，记得留意土壤水分。`);
  }
  if (action.type === 'water') {
    if (!plot.cropId) return fail('先播下种子，再给它浇水吧。');
    if (plot.progress >= 1) return fail('作物已经成熟，可以直接收获。');
    if (plot.moisture >= 0.98) return fail('土壤还很湿润，暂时不用再浇水。');
    plot.moisture = 1;
    return done(`给 ${plot.id + 1} 号田浇好了水，小苗继续生长。`);
  }
  if (action.type === 'fertilize') {
    if (!plot.cropId) return fail('先种下作物，再给这一茬施肥。');
    if (plot.progress >= 1) return fail('这一茬已经成熟，留着肥料给下一茬吧。');
    if (plot.fertilized) return fail('这一茬已经施过肥了。');
    if (state.compost < 1) return fail('堆肥用完了，可以到种子铺补充。');
    state.compost -= 1;
    plot.fertilized = true;
    return done(`${plot.id + 1} 号田用上了堆肥：生长加快，收获时多得 2 份。`);
  }
  if (action.type === 'harvest') {
    const plantedCrop = CROP_BY_ID.get(plot.cropId);
    if (!plantedCrop) return fail('这块田暂时没有可以收获的作物。');
    if (plot.progress < 1) return fail('还没长熟呢，再照顾它一会儿。');
    const yieldCount = plantedCrop.yield + (plot.fertilized ? GARDEN_RULES.fertilizerYield : 0);
    if (state.inventory[plantedCrop.id] > MAX_STOCK - yieldCount) return fail('仓库里这种作物太多了，先卖出一些再收获。');
    state.inventory[plantedCrop.id] += yieldCount;
    state.stats.harvests = Math.min(MAX_STOCK, state.stats.harvests + 1);
    state.stats.totalYield = Math.min(MAX_STOCK, state.stats.totalYield + yieldCount);
    Object.assign(plot, { ...emptyPlot(plot.id), tilled: true });
    return done(`收获${plantedCrop.name} × ${yieldCount}，已经放进仓库；这块田可以再播种了。`);
  }
  if (action.type === 'buySeed') {
    if (!crop) return fail('种子铺没有这种种子。');
    const cost = crop.seedCost * quantity;
    if (state.coins < cost) return fail('金币不够，可以先卖出仓库里的收成。');
    if (state.seeds[crop.id] > MAX_STOCK - quantity) return fail('这种种子已经很多了，先用掉一些吧。');
    state.coins -= cost; state.seeds[crop.id] += quantity;
    return done(`买到了${crop.name}种子 × ${quantity}，花费 ${cost} 金币。`);
  }
  if (action.type === 'sell') {
    if (!crop) return fail('仓库里没有这种作物。');
    if (state.inventory[crop.id] < quantity) return fail(`仓库里的${crop.name}数量不够。`);
    const income = crop.sellPrice * quantity;
    if (state.coins > MAX_STOCK - income) return fail('金币存放已满，先到种子铺消费一些吧。');
    state.inventory[crop.id] -= quantity; state.coins += income;
    return done(`卖出${crop.name} × ${quantity}，收入 ${income} 金币。`);
  }
  if (action.type === 'buyCompost') {
    const cost = GARDEN_RULES.compostCost * quantity;
    if (state.coins < cost) return fail('金币不够，堆肥可以下次再买。');
    if (state.compost > MAX_STOCK - quantity) return fail('堆肥存放已满，先给作物施肥吧。');
    state.coins -= cost; state.compost += quantity;
    return done(`补充堆肥 × ${quantity}，花费 ${cost} 金币。`);
  }
  return fail('没有识别出这个菜园操作。');
}

export function gardenView(raw, now = Date.now()) {
  const state = advanceGarden(raw, now);
  return {
    ...state,
    plots: state.plots.map((plot) => {
      const crop = CROP_BY_ID.get(plot.cropId);
      const mature = !!crop && plot.progress >= 1;
      const rate = plot.fertilized ? GARDEN_RULES.fertilizerGrowth : 1;
      return {
        ...plot, mature,
        stage: mature ? 3 : plot.progress >= 0.45 ? 2 : plot.progress >= 0.15 ? 1 : 0,
        remainingMs: crop ? Math.ceil((1 - plot.progress) * crop.growMs / rate) : 0,
        waterRemainingMs: crop && !mature ? Math.ceil(plot.moisture * crop.growMs * GARDEN_RULES.waterDurationFactor) : 0,
        needsWater: !!crop && !mature && plot.moisture <= 0,
        expectedYield: crop ? crop.yield + (plot.fertilized ? GARDEN_RULES.fertilizerYield : 0) : 0
      };
    })
  };
}
