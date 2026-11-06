import {BleClient} from './ble-client.mjs?screen=lumi-controls';
import {validateSnapshot} from './ble-protocol.mjs?screen=lumi-controls';
import {screenState} from './screen-state.mjs?screen=lumi-controls';
import {controlAvailability,HoldToTalk,ScreenInputController} from './control-state.mjs?screen=lumi-controls';
import {ScreenImageAssembler,RemoteScreenRenderer} from './remote-screen.mjs?screen=lumi-controls';

const $=id=>document.getElementById(id);
const demo=new URLSearchParams(location.search).get('demo')==='1';
const browserReady=location.protocol==='https:' && window.isSecureContext && !!navigator.bluetooth;
const STALE_MS=30000;
let snapshot=null,lastSnapshotAt=0,lastSyncAt=0,phase='disconnected',demoActive=false,lastDemoStep=-1;
let input,hold,volumeEditing=false;

function connected() {return demo?demoActive:client.connected;}
function stale() {return !!snapshot && (!lastSnapshotAt || Date.now()-lastSnapshotAt>STALE_MS);}
function availability() {return controlAvailability(snapshot,{connected:connected(),stale:stale(),hidden:document.hidden});}
function voiceAvailable() {return availability().voice && $('connection-panel').hidden;}
function showError(error) {
  const name=error?.name && error.name!=='Error'?`${error.name}: `:'';
  $('error-message').textContent=`${name}${error?.message || String(error)}`;$('error-message').hidden=false;
}
function clearError() {$('error-message').textContent='';$('error-message').hidden=true;}
async function send(cmd,value) {
  if (!demo) return client.send(cmd,value);
  if (cmd==='set_volume') snapshot={...snapshot,volume:value};
  if (cmd==='listen_start') snapshot={...snapshot,state:5};
  if (cmd==='listen_stop') snapshot={...snapshot,state:3};
  if (cmd==='toggle_chat') snapshot={...snapshot,state:snapshot.state===5?3:5};
  lastSnapshotAt=Date.now();render();
}

const renderer=new RemoteScreenRenderer({
  surface:$('remote-screen'),image:$('remote-image'),canvas:$('remote-canvas'),text:$('remote-text'),progress:$('remote-progress'),send,
  isVisible:()=>connected() && !document.hidden && $('connection-panel').hidden && !$('remote-screen').hidden && $('remote-screen').getClientRects().length>0,
  onError:showError,
});
const assembly=new ScreenImageAssembler({onImage:image=>renderer.present(image),onFailure:failure=>renderer.fail(failure)});
const client=new BleClient({
  onState:next=>{
    phase=next;
    if (next==='disconnected') {lastSnapshotAt=0;lastSyncAt=0;input?.disconnected();assembly.reset();renderer.clear();}
    render();
  },onMessage:receive,onError:showError,
});
hold=new HoldToTalk({send,canStart:voiceAvailable,onChange:()=>render(),onError:showError});
input=new ScreenInputController({hold,canStart:voiceAvailable,toggle:()=>send('toggle_chat'),onError:showError,onPress:pressed=>{
  $('screen').dataset.pressed=String(pressed);render();
}});

function receive(message) {
  try {
    if (message?.v!==1) throw new Error('不支持的设备消息版本');
    if (message.type==='screen_chunk') {assembly.push(message);return;}
    if (message.type==='snapshot') {
      const next=validateSnapshot(message);
      if (snapshot && next.seq<snapshot.seq && lastSnapshotAt) return;
      snapshot=next;lastSnapshotAt=Date.now();
      if (assembly.update(next.display??null)) renderer.update(assembly.current);
      if (hold.active && (!connected() || stale() || !snapshot.wifi.connected)) input.cancel().catch(showError);
      render();
    } else if (message.type==='result') {
      if (!Number.isSafeInteger(message.id) || typeof message.ok!=='boolean') throw new Error('设备响应格式不匹配');
      if (!message.ok) showError(new Error(typeof message.error==='string'?message.error:'设备未执行，请重试'));
    } else throw new Error('无法识别设备消息');
  } catch(error) {showError(error);}
}

function render() {
  const online=connected(),view=screenState(snapshot,{connected:online,stale:stale(),demo});
  const allowed=availability(),active=!!hold?.active;
  $('screen').dataset.motion=active?'listening':view.motion;$('screen').dataset.mood=view.mood;
  $('screen').dataset.holding=String(active);
  $('screen').dataset.remote=['wechat_qr','wechat_verify'].includes(assembly.current?.kind)?'image':assembly.current?.kind==='status'?'status':'none';
  $('remote-screen').dataset.kind=assembly.current?.kind || 'none';
  $('subtitle').textContent=view.caption.text;$('subtitle').dataset.role=view.caption.role;
  $('screen-notice').textContent=view.notice;$('screen-notice').hidden=!view.notice;
  $('activity').textContent=phase==='connecting'?'正在连接':online && !snapshot?'正在同步':view.activity;
  $('connect-button').hidden=online;$('connect-button').disabled=phase==='connecting' || (!demo && !browserReady);
  $('connect-button').textContent=phase==='connecting'?'连接中…':'连接噜米';$('pairing-hint').hidden=phase!=='connecting';
  $('panel-connect').hidden=online;$('panel-connect').disabled=$('connect-button').disabled;
  $('sync-button').disabled=!allowed.sync;$('disconnect-button').disabled=!online;
  $('panel-status').textContent=demo?'演示数据 · 未连接设备':!online?(phase==='connecting'?'连接中':'未连接'):stale()?'已连接 · 状态未更新':'已连接';
  $('lumi').disabled=!active && !voiceAvailable();$('microphone-button').disabled=!active && !voiceAvailable();
  $('lumi').setAttribute('aria-pressed',String(active));$('microphone-button').setAttribute('aria-pressed',String(active));
  $('microphone-label').textContent=active?'松开结束':'按住说话';
  $('input-status').textContent=active?(snapshot?.state===5?'正在聆听，松开结束':'正在准备聆听，松开结束'):!online?'连接后，轻点噜米或按住说话':stale()?'状态未更新，请在设置中同步':!snapshot?.wifi?.connected?'等待设备连接 Wi-Fi':voiceAvailable()?'轻点噜米对话，也可以按住说话':'等待设备就绪';
  $('volume-input').disabled=!allowed.volume;
  if (!volumeEditing && snapshot) {$('volume-input').value=snapshot.volume;$('volume-value').textContent=`${snapshot.volume}%`;}
}

async function connect() {
  clearError();
  if (demo) {demoActive=true;phase='connected';updateDemo();hidePanel();return;}
  try {await client.connect();hidePanel();} catch(error) {showError(error);}
}
async function sync() {clearError();try {if (demo) updateDemo();else await client.send('sync');hidePanel();} catch(error) {showError(error);}}
async function disconnect() {
  try {
    await input.cancel().catch(showError);
    if (demo) {demoActive=false;phase='disconnected';lastSnapshotAt=0;input.disconnected();assembly.reset();renderer.clear();render();}
    else await client.disconnect();
    hidePanel();
  } catch(error) {showError(error);}
}
function showPanel() {
  input.cancel().catch(showError);$('connection-panel').hidden=false;$('settings-button').setAttribute('aria-expanded','true');
  render();$('close-panel').focus();
}
function hidePanel() {
  const focusInside=$('connection-panel').contains(document.activeElement);
  $('connection-panel').hidden=true;$('settings-button').setAttribute('aria-expanded','false');
  if (focusInside) $('settings-button').focus({preventScroll:true});render();renderer.checkVisible();
}

function bindVoiceInput(element,immediate) {
  let start=null;
  element.addEventListener('pointerdown',event=>{
    if (event.button!==0 || !input.press(`pointer:${event.pointerId}`,{immediate})) return;
    event.preventDefault();start={id:event.pointerId,x:event.clientX,y:event.clientY};element.setPointerCapture(event.pointerId);
  });
  element.addEventListener('pointermove',event=>{
    if (start && start.id===event.pointerId && Math.hypot(event.clientX-start.x,event.clientY-start.y)>20) {start=null;input.cancel().catch(showError);}
  });
  for (const name of ['pointerup','pointercancel','lostpointercapture']) element.addEventListener(name,event=>{
    if (!start || start.id!==event.pointerId) return;
    start=null;input.release(`pointer:${event.pointerId}`,{cancel:name!=='pointerup'}).catch(showError);
  });
  element.addEventListener('contextmenu',event=>event.preventDefault());
  element.addEventListener('keydown',event=>{
    if (!['Enter',' '].includes(event.key) || event.repeat) return;
    event.preventDefault();
    if (event.key==='Enter' && !immediate) {if (voiceAvailable()) send('toggle_chat').catch(showError);}
    else input.press(`key:${event.key}`,{immediate:true});
  });
  element.addEventListener('keyup',event=>{if (['Enter',' '].includes(event.key)) {event.preventDefault();input.release(`key:${event.key}`).catch(showError);}});
  element.addEventListener('blur',()=>input.cancel().catch(showError));
  // Assistive technology can activate a button without pointer or keyboard events.
  element.addEventListener('click',event=>{event.preventDefault();if (event.detail===0 && voiceAvailable()) send('toggle_chat').catch(showError);});
}
bindVoiceInput($('lumi'),false);bindVoiceInput($('microphone-button'),true);
$('settings-button').addEventListener('click',showPanel);
$('connect-button').addEventListener('click',connect);$('panel-connect').addEventListener('click',connect);
$('sync-button').addEventListener('click',sync);$('disconnect-button').addEventListener('click',disconnect);$('close-panel').addEventListener('click',hidePanel);
$('volume-input').addEventListener('input',()=>{volumeEditing=true;$('volume-value').textContent=`${$('volume-input').value}%`;});
$('volume-input').addEventListener('change',async()=>{
  try {if (availability().volume) await send('set_volume',Number($('volume-input').value));} catch(error) {showError(error);} finally {volumeEditing=false;}
});
document.addEventListener('pointerdown',event=>{if (!$('connection-panel').hidden && !$('connection-panel').contains(event.target) && !$('settings-button').contains(event.target)) hidePanel();});
document.addEventListener('keydown',event=>{
  if (event.key==='Escape') {input.cancel().catch(showError);hidePanel();}
  if (event.key==='Tab' && !$('connection-panel').hidden) {
    const buttons=[...$('connection-panel').querySelectorAll('button:not([disabled]),input:not([disabled])')].filter(node=>!node.hidden);
    if (event.shiftKey && document.activeElement===buttons[0]) {event.preventDefault();buttons.at(-1)?.focus();}
    else if (!event.shiftKey && document.activeElement===buttons.at(-1)) {event.preventDefault();buttons[0]?.focus();}
  }
});
document.addEventListener('visibilitychange',()=>{
  if (document.hidden) {input.cancel().catch(showError);hidePanel();}
  else if (connected() && !demo) {client.send('sync').catch(showError);renderer.checkVisible();}
  render();
});
window.addEventListener('pagehide',()=>{input.cancel().catch(showError);assembly.reset();renderer.clear();});
window.addEventListener('blur',()=>input.cancel().catch(showError));
window.addEventListener('pageshow',()=>{if (connected() && !demo) client.send('sync').catch(showError);});

function updateDemo() {
  const step=Math.floor(Date.now()/8000)%3;
  const scenes=[{state:3,emotion:'happy',messages:[{role:'assistant',text:'我在呢。'}]},
    {state:5,emotion:'neutral',messages:[{role:'user',text:'噜米，今天心情怎么样？'}]},
    {state:6,emotion:'happy',messages:[{role:'assistant',text:'和你待在一起，就很好。'}]}];
  if (!snapshot || step!==lastDemoStep) {snapshot={v:1,type:'snapshot',seq:(snapshot?.seq||0)+1,status:'',notification:'',volume:58,wifi:{connected:true,ssid:'演示网络',rssi:-52},uptime_s:120,...scenes[step]};lastDemoStep=step;}
  lastSnapshotAt=Date.now();render();
}
if (demo) {$('demo-indicator').hidden=false;demoActive=true;phase='connected';updateDemo();}
else {if (!navigator.bluetooth) showError(new Error('请使用 Bluefy 打开此页面。'));else if (!browserReady) showError(new Error('请打开 HTTPS 网页后连接。'));render();}
setInterval(()=>{
  assembly.expire();renderer.checkVisible();
  // Idle devices need no state-change notification. Refresh that state before
  // the stale guard disables controls, without restarting an image in flight.
  const now=Date.now();
  if (!demo && connected() && !document.hidden && !assembly.buffer && now-lastSnapshotAt>=15000 && now-lastSyncAt>=15000) {
    lastSyncAt=now;client.send('sync').catch(showError);
  }
  if (hold.active && (!connected() || stale())) {if (connected()) input.cancel().catch(showError);else input.disconnected();}
  if (demo && demoActive && !document.hidden) updateDemo();else render();
},1000);
