// Shared by the production bridge and local preview. A job is proposed first,
// walked to second, worked on third, then committed with its receipt in ONE
// garden save. The home save is only a presentation/behavior checkpoint.
import { CROPS, GARDEN_RULES, advanceGarden, applyGardenAction, gardenView, normalizeGardenCare } from '../public/room/garden-state.js';
import { loadGarden, saveGarden } from './garden-store.js';
import { loadHomeState, saveHomeState, advanceHomeState, beginGardenWork, endGardenWork, homeView } from './home-state.js';

const ACTIONS = ['till','plant','water','fertilize','harvest','sell','buySeed','buyCompost'];
const plotAction = (a) => ['till','plant','water','fertilize','harvest'].includes(a.type);
const labels = {till:'松土',plant:'播种',water:'浇水',fertilize:'施肥',harvest:'采收',sell:'出售收成',buySeed:'购买种子',buyCompost:'补充堆肥',visit:'巡视菜园'};
const keyOf = (a) => JSON.stringify([a.type,a.plotId??null,a.cropId??null,a.quantity??1,a.enabled??null]);

function restReason(home, now, env = {}) {
  const hour = new Date(now).getHours() + new Date(now).getMinutes()/60;
  if (home.asleep || home.sleepPending || hour >= 22.5 || hour < 6.8) return '天晚了，先休息，醒来再照料菜园';
  const n=home.needs;
  if (n.pain >= .28 || n.energy < .35) return '先恢复体力，菜园稍后再照料';
  if (n.thirst >= .62 || n.hunger >= .66 || n.bladder >= .7) return '先照顾身体，稍后回来继续';
  if ((home.command && now < home.command.until) || (home.freeTarget && now < home.freeTarget.until) || now < home.reactionUntil || now < home.lastInteractionAt + 20_000) return '先回应你的安排，之后再来菜园';
  if ((env.unread || 0)>0 && now-(home.lastPhoneAt||0)>20*60_000) return '先看看消息，稍后再照料菜园';
  return '';
}

export function planGardenAction(raw, rotation = 0, now = Date.now()) {
  const g=advanceGarden(raw,now);
  const dry=g.plots.filter(p=>p.cropId && p.progress<1 && p.moisture<.25).sort((a,b)=>a.moisture-b.moisture)[0];
  if(dry) return {type:'water',plotId:dry.id};
  const mature=g.plots.find(p=>p.cropId && p.progress>=1);
  if(mature) return {type:'harvest',plotId:mature.id};
  // Keep one of each crop in the basket; sell the rest to fund the next sowing.
  const sale=CROPS.find(c=>g.inventory[c.id]>1 || (g.coins<2 && g.inventory[c.id]>0));
  if(sale) return {type:'sell',cropId:sale.id,quantity:Math.min(99,g.inventory[sale.id]-(g.coins<2?0:1))};
  const empty=g.plots.find(p=>!p.cropId);
  if(empty){
    if(!empty.tilled) return {type:'till',plotId:empty.id};
    const planted=new Set(g.plots.map(p=>p.cropId));
    const order=Array.from({length:CROPS.length},(_,i)=>CROPS[(rotation+i)%CROPS.length]);
    const chosen=order.find(c=>!planted.has(c.id) && g.seeds[c.id]>0) || order.find(c=>g.seeds[c.id]>0);
    if(chosen) return {type:'plant',plotId:empty.id,cropId:chosen.id};
    const buy=order.find(c=>!planted.has(c.id) && c.seedCost<=g.coins) || order.find(c=>c.seedCost<=g.coins);
    if(buy) return {type:'buySeed',cropId:buy.id,quantity:1};
  }
  const feed=g.plots.find(p=>p.cropId && p.progress<.75 && !p.fertilized);
  if(feed && g.compost>0) return {type:'fertilize',plotId:feed.id};
  // Never buy optional fertilizer at the expense of the next planting cycle.
  if(feed && g.compost===0 && g.coins>=GARDEN_RULES.compostCost+12) return {type:'buyCompost',quantity:1};
  const missing=CROPS.slice(rotation%CROPS.length).concat(CROPS.slice(0,rotation%CROPS.length)).find(c=>g.seeds[c.id]===0 && g.coins>=c.seedCost+8);
  if(missing) return {type:'buySeed',cropId:missing.id,quantity:1};
  return null;
}

function createJob(g, action, source, now, requestId='') {
  const care=g.care; care.nextId+=1;
  const p=plotAction(action)?g.plots[action.plotId]:null;
  return {id:`garden-${care.nextId}`,requestId,action,source,phase:'queued',createdAt:now,startedAt:0,workUntil:0,fingerprint:keyOf(action),expectedPlot:p?{cropId:p.cropId,plantedAt:p.plantedAt}:null};
}
function finish(g, job, ok, message, now, status=ok?'completed':'failed'){
  const c=g.care;
  c.recent.push({id:job.id,type:job.action.type,ok,message,at:now}); c.recent=c.recent.slice(-16);
  const r=c.receipts.find(v=>v.jobId===job.id); if(r) Object.assign(r,{status,message,at:now});
  c.task=null;c.status=message;c.nextPlanAt=now+2500;
  if(ok && job.action.type==='plant') c.rotation=(CROPS.findIndex(x=>x.id===job.action.cropId)+1)%CROPS.length;
}
function validForJob(g, job, now){
  const p=job.expectedPlot ? g.plots[job.action.plotId] : null;
  if(p && (p.cropId!==job.expectedPlot.cropId || p.plantedAt!==job.expectedPlot.plantedAt)) return {ok:false,message:'这畦已经有人照料过，已取消旧任务，重新安排'};
  return job.action.type==='visit'?{ok:true}:applyGardenAction(g,job.action,now);
}
function publicView(g,home,now){
  const view=gardenView(g,now), task=view.care.task;
  view.care={...view.care,task:task?{...task,...task.action}:null,queued:view.care.queue.length,character:{room:home.room,activity:home.activity,walking:!!home.route && now<home.route.arriveAt}};
  return view;
}

const CARE_CONFLICT_MS = 30_000;

/** 手头真正会挡住“现在去菜园”的事情；菜园任务本身不算冲突。 */
function careBlocker(g, h, now, env = {}) {
  if (g.care.task || g.care.queue.length) return { kind: 'already' };
  if (h.asleep || h.sleepPending) {
    return { kind: 'sleep', label: '正在睡觉/准备睡觉', defaultDecision: 'defer' };
  }
  if (h.command && now < h.command.until) {
    return { kind: 'command', label: '正在按你的安排做事', defaultDecision: 'defer' };
  }
  if (h.freeTarget && now < h.freeTarget.until) {
    return { kind: 'command', label: '正在走去你指的地方', defaultDecision: 'defer' };
  }
  if (h.route || h.dwell) {
    return { kind: 'home', label: '正在做手头的事', defaultDecision: 'defer' };
  }
  const reason = restReason(h, now, env);
  if (reason) return { kind: 'needs', label: reason, defaultDecision: 'defer' };
  return null;
}

function pendingQuestion(blocker) {
  const tail = blocker.defaultDecision === 'force' ? '直接去菜园照料' : '把手里的事做完';
  return `她现在${blocker.label}。要先让她做完，还是直接去菜园照料？30 秒内不回答，她会先${tail}。`;
}

/** 用户选择“直接去照料”时，把挡路的房间行为清掉；身体/睡眠也按用户选择让路。 */
function forceCare(g, h, now) {
  g.care.autoEnabled = true;
  g.care.nextPlanAt = 0;
  g.care.forceUntil = now + 5 * 60_000;
  h.asleep = false;
  h.sleepPending = false;
  h.command = null;
  h.route = null;
  h.dwell = null;
  h.freeTarget = null;
  h.reactionUntil = 0;
  h.nextDecisionAt = 0;
}

function resolvePending(g, h, decision, now) {
  const pending = g.care.pendingConflict;
  if (!pending) return false;
  g.care.pendingConflict = null;
  if (decision === 'force') {
    forceCare(g, h, now);
    g.care.status = '你让她先去菜园，她已经出发了';
  } else {
    g.care.nextPlanAt = now + 15_000;
    g.care.status = '先把手头的事做完，稍后再去菜园';
  }
  return true;
}

export function createGardenCaretaker({homeFile,gardenFile,getEnv=()=>({}),storage={loadHomeState,saveHomeState,loadGarden,saveGarden}}){
  if(!homeFile||!gardenFile) throw new Error('菜园照料需要独立的房间与菜园存档路径');
  let lastHomeSave=0;
  function tick(now=Date.now()){
    const env=getEnv(now)||{};
    let g=advanceGarden(storage.loadGarden(gardenFile,now),now);
    let h=storage.loadHomeState(homeFile,now);
    let careDirty=false;
    const pending=g.care.pendingConflict;
    if(pending && now>=pending.deadline){
      resolvePending(g,h,pending.defaultDecision,now);
      careDirty=true;
    }
    const beforeCare=JSON.stringify(g.care);
    let homeTransition=false, gardenCommit=false;
    // Recover from a crash after garden commit but before home checkpoint.
    const owner=h.route?.target?.gardenJobId || h.dwell?.target?.gardenJobId;
    if(owner && owner!==g.care.task?.id){
      h=endGardenWork(h,{id:owner},now,'菜园操作已结算，继续接下来的安排');homeTransition=true;
    }
    const forced = Number(g.care.forceUntil) > now;
    let reason = g.care.pendingConflict ? '在等你回答，先不安排菜园' : (forced ? '' : restReason(h,now,env));
    if(g.care.task && reason){
      const job=g.care.task;
      h=endGardenWork(h,job,now,reason);
      finish(g,job,false,`${reason}；已暂停这次${labels[job.action.type]}`,now,'cancelled');homeTransition=true;
    }
    const mayPlan=!reason && (g.care.task || g.care.queue.length || (g.care.autoEnabled && now>=g.care.nextPlanAt));
    const beforeMotion=JSON.stringify([h.route,h.dwell,h.asleep,h.sleepPending]);
    if(reason && !h.route && !h.dwell)h.nextDecisionAt=0;
    const advanced=advanceHomeState(h,now,{...env,gardenReady:!!mayPlan}); h=advanced.state;
    if(beforeMotion!==JSON.stringify([h.route,h.dwell,h.asleep,h.sleepPending]))homeTransition=true;
    reason = g.care.pendingConflict ? '在等你回答，先不安排菜园' : (Number(g.care.forceUntil) > now ? '' : restReason(h,now,env));
    if(g.care.task && reason){
      const interrupted=g.care.task;h=endGardenWork(h,interrupted,now,reason);
      finish(g,interrupted,false,`${reason}；已暂停这次${labels[interrupted.action.type]}`,now,'cancelled');homeTransition=true;
    }
    const job=g.care.task;
    if(job){
      const route=h.route?.target?.gardenJobId===job.id;
      const dwell=h.dwell?.target?.gardenJobId===job.id;
      if(route){job.phase='walking';g.care.status=`正在走去${labels[job.action.type]}`;}
      else if(dwell){
        job.phase='working';job.workUntil=h.dwell.until;g.care.status=`小蓝鱼正在${labels[job.action.type]}`;
        if(now>=h.dwell.until){
          const valid=validForJob(g,job,now);
          const result=valid.ok?(job.action.type==='visit'?{ok:true,state:g,message:'到了菜园门口，看看菜畦的长势'}:applyGardenAction(g,job.action,now)):valid;
          if(result.state)g=result.state;
          finish(g,job,result.ok,`小蓝鱼：${result.message}`,now);
          // Persist receipt BEFORE clearing home dwell: replay cannot spend/reward twice.
          storage.saveGarden(gardenFile,g);gardenCommit=true;
          h=endGardenWork(h,job,now,g.care.status,result.ok);homeTransition=true;
        }
      }else if(h.route||h.dwell||h.command||h.freeTarget||reason){
        finish(g,job,false,'你的新安排已接手，原菜园任务已取消',now,'cancelled');homeTransition=true;
      }else{
        // Missing home checkpoint after crash: restart the physical trip; no effect yet.
        h=beginGardenWork(h,job,now);job.startedAt=now;job.phase='walking';homeTransition=true;
      }
    }
    if(!g.care.task){
      if(reason){g.care.status=reason;}
      else if(!h.route&&!h.dwell&&now>=g.care.nextPlanAt){
        let next=g.care.queue.shift()||null;
        if(!next&&g.care.autoEnabled){
          const action=planGardenAction(g,g.care.rotation,now);
          if(action)next=createJob(g,action,'auto',now);
        }
        if(next){
          const valid=validForJob(g,next,now);
          if(!valid.ok){finish(g,next,false,valid.message,now);}
          else{
            g.care.task=next;next.startedAt=now;next.phase='walking';
            h=beginGardenWork(h,next,now);g.care.status=`出发去${labels[next.action.type]}`;homeTransition=true;
          }
        }else{g.care.status=g.care.autoEnabled?'菜园照料好了，等作物慢慢长大':'自主照料已暂停，你仍可请小蓝鱼完成指定操作';g.care.nextPlanAt=now+15_000;}
      }
    }
    if(!gardenCommit && (careDirty || JSON.stringify(g.care)!==beforeCare))storage.saveGarden(gardenFile,g);
    // Routine needs are checkpointed at most every 20 seconds, physical job transitions immediately.
    const checkpoint=homeTransition||now-lastHomeSave>=20_000;
    if(checkpoint){h=storage.saveHomeState(homeFile,h,now);lastHomeSave=now;}
    return {state:h,env,garden:publicView(g,h,now),changed:advanced.changed||homeTransition};
  }
  function control(input={},now=Date.now()){
    // Validation/idempotency precede tick: a malformed request never starts work.
    if(!input || typeof input!=='object' || Array.isArray(input))return {ok:false,message:'照料安排需要有效的操作内容'};
    const type=input.type==='go'?'visit':input.type;
    if(![...ACTIONS,'visit','auto','careNow'].includes(type))return {ok:false,message:'没有识别出这项照料安排'};
    if(input.requestId!==undefined && (typeof input.requestId!=='string'||!input.requestId.trim()||input.requestId.length>96||/[\u0000-\u001f\u007f]/.test(input.requestId)))return {ok:false,message:'请求编号必须是 1 到 96 字的文本'};
    if(type==='auto'&&typeof input.enabled!=='boolean')return {ok:false,message:'请选择开启或暂停自主照料'};
    const action={type};
    for(const field of ['plotId','cropId','quantity'])if(input[field]!==undefined)action[field]=input[field];
    if(type==='auto')action.enabled=input.enabled;
    let g=advanceGarden(storage.loadGarden(gardenFile,now),now);
    if(type==='careNow'){
      let h=storage.loadHomeState(homeFile,now);
      const decision=input.decision;
      if(decision!==undefined && !['force','defer'].includes(decision))return {ok:false,message:'请选择先做手头的事或直接去菜园'};
      if(g.care.pendingConflict){
        if(!decision)return {ok:true,conflict:true,pending:g.care.pendingConflict,message:g.care.pendingConflict.question,garden:publicView(g,h,now),home:homeView(h,now,getEnv(now))};
        resolvePending(g,h,decision,now);
        storage.saveGarden(gardenFile,g);storage.saveHomeState(homeFile,h,now);
        const result=tick(now);
        return {ok:true,accepted:decision==='force',conflict:false,status:result.garden.care.status,message:decision==='force'?'你选了直接去菜园，她已经出发了':'先做手头的事，稍后再照料',garden:result.garden,home:homeView(result.state,now,result.env)};
      }
      const blocker=careBlocker(g,h,now,getEnv(now));
      if(blocker && blocker.kind!=='already'){
        const pending={id:`care-${now}-${Math.random().toString(36).slice(2,8)}`,question:pendingQuestion(blocker),kind:blocker.kind,createdAt:now,deadline:now+CARE_CONFLICT_MS,defaultDecision:blocker.defaultDecision||'defer'};
        g.care.pendingConflict=pending;
        g.care.status=pending.question;
        g.care=normalizeGardenCare(g.care);storage.saveGarden(gardenFile,g);
        return {ok:true,conflict:true,pending,message:pending.question,garden:publicView(g,h,now),home:homeView(h,now,getEnv(now))};
      }
      g.care.autoEnabled=true;g.care.nextPlanAt=0;
      g.care=normalizeGardenCare(g.care);storage.saveGarden(gardenFile,g);
      const result=tick(now);
      return {ok:true,accepted:true,conflict:false,status:result.garden.care.status,message:blocker?.kind==='already'?'她已经在照料菜园了':'她放下手里的事，先去菜园了',garden:result.garden,home:homeView(result.state,now,result.env)};
    }
    const requestId=input.requestId||'';const fingerprint=keyOf(action);
    const existing=requestId&&g.care.receipts.find(r=>r.requestId===requestId);
    if(existing){
      if(existing.fingerprint!==fingerprint)return {ok:false,message:'相同请求编号不能用于不同的操作'};
      const h=storage.loadHomeState(homeFile,now);return {ok:!['failed','cancelled'].includes(existing.status),accepted:existing.status==='queued',requestId,status:existing.status,message:existing.message,garden:publicView(g,h,now),home:homeView(h,now,getEnv(now))};
    }
    if(type==='auto'){
      g.care.autoEnabled=input.enabled;g.care.nextPlanAt=0;
      // Disabling autonomy cancels only the automatic job; explicit requests remain.
      if(!input.enabled&&g.care.task?.source==='auto'){
        const job=g.care.task,h=endGardenWork(storage.loadHomeState(homeFile,now),job,now,'自主照料已暂停');
        finish(g,job,false,'自主照料已暂停',now,'cancelled');storage.saveHomeState(homeFile,h,now);
      }
      const message=input.enabled?'小蓝鱼会自己安排照料菜园':'已暂停自主照料';g.care.status=message;
      if(requestId)g.care.receipts.push({requestId,jobId:'',fingerprint,status:'completed',message,at:now});
      g.care=normalizeGardenCare(g.care);storage.saveGarden(gardenFile,g);
      const result=tick(now);return {ok:true,accepted:false,status:'completed',requestId,message,garden:result.garden,home:homeView(result.state,now,result.env)};
    }
    if(g.care.queue.length>=16)return {ok:false,message:'她已经记下很多安排，等完成一些后再告诉她吧'};
    const valid=type==='visit'?{ok:true}:applyGardenAction(g,action,now);
    if(!valid.ok)return {ok:false,message:valid.message};
    const job=createJob(g,action,'requested',now,requestId);g.care.queue.push(job);g.care.nextPlanAt=0;
    const message=`已记下${labels[type]}，小蓝鱼会走到现场完成；完成后才会结算`;
    if(requestId)g.care.receipts.push({requestId,jobId:job.id,fingerprint,status:'queued',message,at:now});
    g.care=normalizeGardenCare(g.care);storage.saveGarden(gardenFile,g);
    const result=tick(now);return {ok:true,accepted:true,status:'queued',requestId,message,garden:result.garden,home:homeView(result.state,now,result.env)};
  }
  return {tick,control};
}
