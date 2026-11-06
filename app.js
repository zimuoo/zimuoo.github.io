import {BleClient} from './ble-client.mjs';
import {validateSnapshot} from './ble-protocol.mjs';
import {DEVICE_STATES, controlAvailability, HoldToTalk} from './control-state.mjs';

const $ = id => document.getElementById(id);
const demo = new URLSearchParams(location.search).get('demo') === '1';
// 8192 bytes at MTU 23, 16 payload bytes and 20ms pacing can take >10s.
const STALE_MS = 30000;
const browserReady = location.protocol === 'https:' && window.isSecureContext && !!navigator.bluetooth;
let snapshot = null;
let lastSnapshotAt = 0;
let phase = 'disconnected';
let renderedMessages = '';
let volumeEditing = false;
let activePointer = null;
let demoConnected = false;
let demoTimer;

const client = new BleClient({
  onState: next => {
    phase = next;
    if (next === 'disconnected') { lastSnapshotAt = 0; hold.reset(); activePointer = null; }
    render();
  },
  onMessage: receive,
  onError: error => feedback(`同步中断：${error.message}。可点“重新同步”。`, true),
});

function feedback(text, error = false) {
  $('feedback').textContent = text;
  $('feedback').classList.toggle('is-error', error);
}
function connected() { return demo ? demoConnected : client.connected; }
function stale() { return !!snapshot && (!lastSnapshotAt || Date.now() - lastSnapshotAt > STALE_MS); }
function availability() { return controlAvailability(snapshot, {connected:connected(),stale:stale(),hidden:document.hidden}); }

function receive(message) {
  try {
    if (message?.v !== 1) throw new Error('不支持的蓝牙协议版本');
    if (message.type === 'snapshot') {
      const next = validateSnapshot(message);
      if (snapshot && next.seq < snapshot.seq && lastSnapshotAt) return;
      snapshot = next;
      lastSnapshotAt = Date.now();
      if (hold.active && (!next.wifi.connected || [0,1,2,8,9,10,11].includes(next.state))) stopHolding();
      render();
    } else if (message.type === 'result') {
      if (!Number.isSafeInteger(message.id) || typeof message.ok !== 'boolean') throw new Error('命令结果格式不匹配');
      feedback(message.ok ? '设备已确认操作' : `设备未执行：${typeof message.error === 'string' ? message.error : '请稍后重试'}`, !message.ok);
    } else throw new Error('无法识别设备消息');
  } catch (error) { feedback(error.message, true); }
}

async function send(cmd, value) {
  if (!connected()) throw new Error('蓝牙连接已断开');
  feedback(demo ? '演示操作，仅改变模拟界面' : '正在发送操作，等待设备确认…');
  if (demo) {
    if (cmd === 'set_volume') snapshot.volume = value;
    if (cmd === 'listen_start') snapshot.state = 5;
    if (cmd === 'listen_stop') snapshot.state = 3;
    if (cmd === 'toggle_chat') snapshot.state = snapshot.state === 5 ? 3 : 5;
    snapshot.status = DEVICE_STATES[snapshot.state].name;
    snapshot.seq++;
    lastSnapshotAt = Date.now();
    render();
    return;
  }
  return client.send(cmd, value);
}
function handleError(error) {
  if (error?.name === 'NotFoundError') feedback('未选择设备。准备好后，可再次点“连接设备”。');
  else feedback(`连接或操作未完成：${error.message || '请重试'}。首次连接请确认系统配对；取消后可重新连接。`, true);
}
const hold = new HoldToTalk({send, onChange: active => {
  $('ptt-button').classList.toggle('is-holding', active);
  $('ptt-button').querySelector('span').textContent = active ? '松开发送' : '按住说话';
  $('ptt-button').setAttribute('aria-pressed', String(active));
}});
function stopHolding() { activePointer = null; return hold.stop().catch(handleError); }

function renderMessages() {
  const messages = snapshot?.messages || [];
  const signature = JSON.stringify(messages);
  if (signature === renderedMessages) return;
  renderedMessages = signature;
  $('message-count').textContent = `最近 ${messages.length} 条`;
  if (!messages.length) {
    $('messages').replaceChildren($('empty-conversation') || createEmpty());
    return;
  }
  const fragment = document.createDocumentFragment();
  const names = {assistant:'小智',user:'你',system:'设备提示'};
  for (const message of messages) {
    const article = document.createElement('article');
    article.className = `message message-${message.role}`;
    const name = document.createElement('span');
    name.className = 'message-label';
    name.textContent = names[message.role];
    const body = document.createElement('p');
    body.className = 'message-body';
    body.textContent = message.text;
    article.append(name, body);
    fragment.append(article);
  }
  $('messages').replaceChildren(fragment);
}
function createEmpty() {
  const empty = document.createElement('div');
  empty.id = 'empty-conversation'; empty.className = 'empty-conversation';
  const title = document.createElement('h3'); title.textContent = '等下一段对话开始';
  const note = document.createElement('p'); note.textContent = '向小智说声你好，文字会同步到这里。';
  empty.append(title, note);
  return empty;
}
function render() {
  const online = connected();
  const isStale = stale();
  const controls = availability();
  const state = snapshot ? DEVICE_STATES[snapshot.state] : null;
  $('connect-button').disabled = phase === 'connecting' || (!demo && !browserReady);
  $('connect-button').textContent = phase === 'connecting' ? '连接中…' : online ? '断开连接' : '连接设备';
  $('connect-button').classList.toggle('is-disconnect', online);
  $('connection-title').textContent = demo ? '界面演示 · 虚拟小智' : online ? (client.device?.name || '小智已连接') : '让小智来到手机上';
  $('connection-note').textContent = phase === 'connecting' ? '请允许蓝牙，并确认系统配对' : online ? (isStale ? '状态已过期，请重新同步' : '蓝牙显示与控制已就绪') : '在 Bluefy 中连接身边的小智';
  $('ble-status').replaceChildren();
  const dot = document.createElement('i');
  $('ble-status').append(dot, document.createTextNode(demo ? (online ? '演示蓝牙' : '演示已断开') : online ? '蓝牙已连接' : '蓝牙未连接'));
  $('ble-status').classList.toggle('is-online', online);
  $('wifi-status').lastChild.textContent = snapshot ? (snapshot.wifi.connected ? (demo ? '演示 Wi-Fi' : 'Wi-Fi 已连接') : 'Wi-Fi 未连接') : 'Wi-Fi 待同步';
  $('wifi-status').classList.toggle('is-online', !!snapshot?.wifi.connected && online && !isStale);
  $('wifi-status').title = snapshot ? `${snapshot.wifi.ssid || '未连接网络'} · ${snapshot.wifi.rssi} dBm` : '等待设备报告网络状态';
  $('freshness').textContent = !online ? (snapshot ? '上次记录' : '等待连接') : !snapshot ? '等待设备同步' : isStale ? '状态已过期' : demo ? '模拟数据' : '刚刚同步';
  $('companion').dataset.state = !online || isStale ? 'offline' : snapshot?.state === 5 ? 'listening' : 'online';
  $('status-title').textContent = !online ? '等你连接' : !snapshot ? '正在同步' : isStale ? '等候重新同步' : snapshot.status || state.name;
  $('state-description').textContent = !online ? (snapshot ? '已断开，下面保留的是上次同步内容。' : '熟悉的声音，换一个陪伴的方式。') : isStale ? '蓝牙仍连接，但设备状态已有一段时间未更新。' : state?.description || '连接成功，正在等小智的第一条消息。';
  const emotion = snapshot?.emotion || 'neutral';
  const sad = ['sad','crying','angry','fearful','scared','confused'].includes(emotion);
  const happy = ['happy','laughing','funny','loving','confident','winking','excited'].includes(emotion);
  $('companion').dataset.mood = sad ? 'sad' : happy ? 'happy' : 'neutral';
  $('face-mouth').setAttribute('d', sad ? 'M69 86 Q80 76 91 86' : happy ? 'M66 78 Q80 98 94 78' : 'M69 81 Q80 88 91 81');
  $('companion').setAttribute('aria-label', `小智状态：${snapshot?.status || '未连接'}；表情：${emotion}`);
  $('listen-button').disabled = !controls.voice;
  $('listen-button').setAttribute('aria-checked', String(online && !isStale && snapshot?.state === 5));
  $('listen-label').textContent = snapshot?.state === 5 ? '结束聆听' : snapshot?.state === 6 ? '打断回答' : '开始聆听';
  $('ptt-button').disabled = !controls.voice && !hold.active;
  $('volume').disabled = !controls.volume;
  $('sync-button').disabled = !controls.sync;
  if (!volumeEditing && snapshot) { $('volume').value = snapshot.volume; $('volume-value').textContent = `${snapshot.volume}%`; }
  $('control-hint').textContent = !online ? '连接并同步设备后，即可使用语音控制。' : !snapshot ? '等待第一条设备状态，请稍候或点“重新同步”。' : isStale ? '设备状态已过期，语音与音量控制暂不可用。' : [0,1,2,8,9,10,11].includes(snapshot.state) ? '设备正在准备中，请先按下方提示完成操作。' : !snapshot.wifi.connected ? '设备 Wi-Fi 尚未连接，语音暂不可用。' : snapshot.state === 4 ? '正在连接对话服务，请稍候。' : '轻点开始聆听，或按住说话、松开发送。';
  const notification = snapshot?.notification || '';
  $('notification').hidden = !notification;
  $('notification-text').textContent = notification;
  renderMessages();
}

$('connect-button').addEventListener('click', async () => {
  try {
    if (connected()) {
      await stopHolding();
      if (demo) { demoConnected = false; phase = 'disconnected'; clearInterval(demoTimer); lastSnapshotAt = 0; render(); }
      else await client.disconnect();
      feedback(demo ? '演示连接已断开' : '蓝牙已断开');
      return;
    }
    if (demo) { startDemo(); return; }
    snapshot = null; renderedMessages = ''; lastSnapshotAt = 0;
    feedback('请选择你的 P4。首次连接请确认 iOS 的配对请求。');
    await client.connect();
  } catch (error) { handleError(error); }
});
$('sync-button').addEventListener('click', () => send('sync').catch(handleError));
$('listen-button').addEventListener('click', async () => {
  if (!availability().voice) return;
  await stopHolding();
  send('toggle_chat').catch(handleError);
});
$('ptt-button').addEventListener('pointerdown', event => {
  if (event.button !== 0 || activePointer !== null || !availability().voice) return;
  event.preventDefault();
  activePointer = event.pointerId;
  $('ptt-button').setPointerCapture(event.pointerId);
  hold.start().catch(handleError);
});
for (const type of ['pointerup','pointercancel','lostpointercapture']) $('ptt-button').addEventListener(type, event => {
  if (event.pointerId === activePointer) stopHolding();
});
$('ptt-button').addEventListener('keydown', event => {
  if (![' ','Enter'].includes(event.key) || event.repeat || !availability().voice) return;
  event.preventDefault(); hold.start().catch(handleError);
});
$('ptt-button').addEventListener('keyup', event => {
  if ([' ','Enter'].includes(event.key)) { event.preventDefault(); stopHolding(); }
});
$('ptt-button').addEventListener('blur', () => stopHolding());
$('ptt-button').addEventListener('contextmenu', event => event.preventDefault());
$('volume').addEventListener('pointerdown', () => { volumeEditing = true; });
$('volume').addEventListener('input', () => { volumeEditing = true; $('volume-value').textContent = `${$('volume').value}%`; });
$('volume').addEventListener('change', () => {
  volumeEditing = false;
  if (availability().volume) send('set_volume', Number($('volume').value)).catch(handleError);
});
$('volume').addEventListener('pointercancel', () => { volumeEditing = false; render(); });
$('volume').addEventListener('blur', () => { volumeEditing = false; render(); });
document.addEventListener('visibilitychange', () => {
  if (document.hidden) stopHolding();
  else if (connected()) send('sync').catch(handleError);
  render();
});
window.addEventListener('pagehide', () => { stopHolding(); });
window.addEventListener('blur', () => { stopHolding(); });
setInterval(() => {
  if (stale() && hold.active) stopHolding();
  render();
}, 1000);

function startDemo() {
  demoConnected = true; phase = 'connected';
  snapshot = {v:1,type:'snapshot',seq:1,status:'我在，听你说',notification:'这是界面演示。真实设备的配网、激活提示也会出现在这里。',emotion:'happy',state:3,volume:58,wifi:{connected:true,ssid:'演示网络',rssi:-52},messages:[{role:'user',text:'今天想带你出去走走。'},{role:'assistant',text:'好呀。你看风景，我陪你聊天。\n声音在身边，文字在手心。'}],uptime_s:120};
  lastSnapshotAt = Date.now();
  clearInterval(demoTimer);
  demoTimer = setInterval(() => { snapshot.uptime_s++; snapshot.seq++; lastSnapshotAt = Date.now(); }, 1000);
  feedback('界面演示模式：没有连接设备，也不会发送真实控制。');
  render();
}

if (demo) {
  $('demo-banner').hidden = false;
  $('environment-note').textContent = '当前为界面演示，连接、状态和操作均为模拟。';
  startDemo();
} else {
  if (!window.isSecureContext || location.protocol !== 'https:') {
    $('environment-note').textContent = '真实连接请用 Bluefy 打开 HTTPS 网页。当前 HTTP 仅适合本机界面预览。';
    if (!['localhost','127.0.0.1','[::1]'].includes(location.hostname)) $('connect-button').disabled = true;
  }
  if (!navigator.bluetooth) $('environment-note').textContent = '当前浏览器不支持 Web Bluetooth。请用 Bluefy 打开 HTTPS 网页，再允许蓝牙与系统配对。';
  render();
}
