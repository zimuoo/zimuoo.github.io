import {BleClient} from './ble-client.mjs';
import {validateSnapshot} from './ble-protocol.mjs';
import {screenState} from './screen-state.mjs';

const $ = id => document.getElementById(id);
const demo = new URLSearchParams(location.search).get('demo') === '1';
const browserReady = location.protocol === 'https:' && window.isSecureContext && !!navigator.bluetooth;
const STALE_MS = 30000;
let snapshot = null;
let lastSnapshotAt = 0;
let phase = 'disconnected';
let demoActive = false;
let longPressTimer;
let panelTimer;
let pointerStart = null;
let lastDemoStep = -1;

const client = new BleClient({
  onState: next => {
    phase = next;
    if (next === 'disconnected') lastSnapshotAt = 0;
    render();
  },
  onMessage: receive,
  onError: error => showError(error),
});

function connected() { return demo ? demoActive : client.connected; }
function stale() { return !!snapshot && (!lastSnapshotAt || Date.now() - lastSnapshotAt > STALE_MS); }
function showError(error) {
  // Keep native pairing/GATT error names and text available for diagnosis.
  const name = error?.name && error.name !== 'Error' ? `${error.name}: ` : '';
  $('error-message').textContent = `${name}${error?.message || String(error)}`;
  $('error-message').hidden = false;
}
function clearError() { $('error-message').textContent = ''; $('error-message').hidden = true; }

function receive(message) {
  try {
    if (message?.v !== 1) throw new Error('不支持的设备消息版本');
    if (message.type === 'snapshot') {
      const next = validateSnapshot(message);
      if (snapshot && next.seq < snapshot.seq && lastSnapshotAt) return;
      snapshot = next;
      lastSnapshotAt = Date.now();
      render();
    } else if (message.type === 'result') {
      if (!Number.isSafeInteger(message.id) || typeof message.ok !== 'boolean') throw new Error('设备响应格式不匹配');
      if (!message.ok) showError(new Error(typeof message.error === 'string' ? message.error : '设备未执行，请重试'));
    } else throw new Error('无法识别设备消息');
  } catch (error) { showError(error); }
}

function render() {
  const online = connected();
  const view = screenState(snapshot,{connected:online,stale:stale(),demo});
  $('screen').dataset.motion = view.motion;
  $('screen').dataset.mood = view.mood;
  $('subtitle').textContent = view.caption.text;
  $('subtitle').dataset.role = view.caption.role;
  $('screen-notice').textContent = view.notice;
  $('screen-notice').hidden = !view.notice;
  $('activity').textContent = phase === 'connecting' ? '正在连接' : online && !snapshot ? '正在同步' : view.activity;
  $('connect-button').hidden = online;
  $('connect-button').disabled = phase === 'connecting' || (!demo && !browserReady);
  $('connect-button').textContent = phase === 'connecting' ? '连接中…' : '连接噜米';
  $('pairing-hint').hidden = phase !== 'connecting';
  $('panel-connect').hidden = online;
  $('panel-connect').disabled = phase === 'connecting' || (!demo && !browserReady);
  $('sync-button').disabled = !online || document.hidden;
  $('disconnect-button').disabled = !online;
  $('panel-status').textContent = demo ? '演示数据 · 未连接设备' : !online ? (phase === 'connecting' ? '连接中' : '未连接') : stale() ? '连接中 · 状态未更新' : '已连接';
  $('lumi').setAttribute('aria-label', `噜米${view.activity ? `，${view.activity}` : ''}。长按显示连接选项`);
}

async function connect() {
  clearError();
  if (demo) { demoActive = true; phase = 'connected'; updateDemo(); hidePanel(); return; }
  try {
    // Retain the last caption until a fresh snapshot arrives; label it honestly.
    await client.connect();
    hidePanel();
  } catch (error) { showError(error); }
}
async function sync() {
  clearError();
  try {
    if (demo) updateDemo();
    else await client.send('sync');
    hidePanel();
  } catch (error) { showError(error); }
}
async function disconnect() {
  try {
    if (demo) { demoActive = false; phase = 'disconnected'; lastSnapshotAt = 0; render(); }
    else await client.disconnect();
    hidePanel();
  } catch (error) { showError(error); }
}
function showPanel() {
  clearTimeout(panelTimer);
  $('connection-panel').hidden = false;
  $('lumi').setAttribute('aria-expanded','true');
  panelTimer = setTimeout(hidePanel, 8000);
}
function hidePanel() {
  clearTimeout(panelTimer);
  const focusInside = $('connection-panel').contains(document.activeElement);
  $('connection-panel').hidden = true;
  $('lumi').setAttribute('aria-expanded','false');
  if (focusInside) $('lumi').focus({preventScroll:true});
}
function cancelLongPress() { clearTimeout(longPressTimer); pointerStart = null; }

$('connect-button').addEventListener('click',connect);
$('panel-connect').addEventListener('click',connect);
$('sync-button').addEventListener('click',sync);
$('disconnect-button').addEventListener('click',disconnect);
$('close-panel').addEventListener('click',hidePanel);
$('lumi').addEventListener('pointerdown',event => {
  if (event.button !== 0) return;
  cancelLongPress();
  pointerStart = {x:event.clientX,y:event.clientY,id:event.pointerId};
  $('lumi').setPointerCapture(event.pointerId);
  longPressTimer = setTimeout(() => { pointerStart = null; showPanel(); },650);
});
$('lumi').addEventListener('pointermove',event => {
  if (pointerStart && Math.hypot(event.clientX-pointerStart.x,event.clientY-pointerStart.y)>12) cancelLongPress();
});
for (const event of ['pointerup','pointercancel','lostpointercapture']) $('lumi').addEventListener(event,cancelLongPress);
$('lumi').addEventListener('contextmenu',event => event.preventDefault());
$('lumi').addEventListener('keydown',event => {
  if (['Enter',' '].includes(event.key)) { event.preventDefault(); showPanel(); $('close-panel').focus(); }
});
$('connection-panel').addEventListener('pointerdown',() => { clearTimeout(panelTimer); panelTimer=setTimeout(hidePanel,8000); });
document.addEventListener('pointerdown',event => {
  if (!$('connection-panel').hidden && !$('connection-panel').contains(event.target) && !$('lumi').contains(event.target)) hidePanel();
});
document.addEventListener('keydown',event => { if (event.key === 'Escape') hidePanel(); });
document.addEventListener('visibilitychange',() => {
  cancelLongPress();
  if (document.hidden) hidePanel();
  else if (connected() && !demo) client.send('sync').catch(showError);
  render();
});
window.addEventListener('pagehide',cancelLongPress);
window.addEventListener('blur',cancelLongPress);

// Explicit QA only. This never requests a Bluetooth device or claims a real link.
function updateDemo() {
  const step = Math.floor(Date.now()/8000)%3;
  const scenes = [
    {state:3,emotion:'happy',messages:[{role:'assistant',text:'我在呢。'}]},
    {state:5,emotion:'neutral',messages:[{role:'user',text:'噜米，今天心情怎么样？'}]},
    {state:6,emotion:'happy',messages:[{role:'assistant',text:'和你待在一起，就很好。'}]},
  ];
  if (!snapshot || step !== lastDemoStep) {
    snapshot = {v:1,type:'snapshot',seq:(snapshot?.seq||0)+1,status:'',notification:'',volume:58,wifi:{connected:true,ssid:'演示网络',rssi:-52},uptime_s:120,...scenes[step]};
    lastDemoStep = step;
  }
  lastSnapshotAt = Date.now(); render();
}
if (demo) {
  $('demo-indicator').hidden = false;
  demoActive = true; phase = 'connected'; updateDemo();
} else {
  if (!navigator.bluetooth) showError(new Error('请使用 Bluefy 打开此页面。'));
  else if (location.protocol !== 'https:' || !window.isSecureContext) showError(new Error('请打开 HTTPS 网页后连接。'));
  render();
}
setInterval(() => { if (demo && demoActive && !document.hidden) updateDemo(); else render(); },1000);
