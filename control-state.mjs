// Exact order from main/device_state.h. Text is presentation, never a command.
export const DEVICE_STATES = Object.freeze([
  {name:'状态未知',description:'等待设备报告当前状态。'},
  {name:'启动中',description:'噜米正在准备声音与网络。'},
  {name:'配网中',description:'请按照设备提示完成 Wi-Fi 配置。'},
  {name:'待命',description:'我在这里，随时听你说。'},
  {name:'连接中',description:'正在连接对话服务，请稍候。'},
  {name:'聆听中',description:'说吧，我在认真听。'},
  {name:'回答中',description:'正在把想说的话，慢慢告诉你。'},
  {name:'播报中',description:'噜米正在播放一条通知。'},
  {name:'更新中',description:'设备正在更新，请保持通电。'},
  {name:'激活中',description:'请按照设备提示完成激活。'},
  {name:'音频测试',description:'设备正在测试麦克风与扬声器。'},
  {name:'设备异常',description:'请查看下方设备提示。'},
]);

export function controlAvailability(snapshot, {connected = false, stale = false, hidden = false} = {}) {
  const ready = connected && !!snapshot && !stale && !hidden;
  return {
    sync: connected && !hidden,
    volume: ready,
    voice: ready && snapshot.wifi?.connected === true && [3,5,6,7].includes(snapshot.state),
  };
}

export class HoldToTalk {
  constructor({send, onChange = () => {}, canStart = () => true, maxHoldMs=30000, setTimer=setTimeout, clearTimer=clearTimeout, onError=()=>{}}) {
    this.send = send;
    this.onChange = onChange;
    this.active = false;
    this.generation = 0;
    Object.assign(this,{canStart,maxHoldMs,setTimer,clearTimer,onError});
  }
  async start() {
    if (this.active || !this.canStart()) return false;
    this.active = true;
    const generation = ++this.generation;
    this.onChange(true);
    this.timer=this.setTimer(()=>this.stop().catch(this.onError),this.maxHoldMs);
    try { await this.send('listen_start'); return true; }
    catch (error) {
      if (generation === this.generation) this.reset();
      throw error;
    }
  }
  async stop() {
    if (!this.active) return;
    this.reset();
    await this.send('listen_stop');
  }
  reset() {
    this.clearTimer(this.timer);this.timer=null;
    this.active = false;
    this.generation++;
    this.onChange(false);
  }
}

// One gesture owns both its delayed press and release, including cancellation.
export class ScreenInputController {
  constructor({hold,canStart,toggle,onError=()=>{},onPress=()=>{},setTimer=setTimeout,clearTimer=clearTimeout,holdDelay=350}) {
    Object.assign(this,{hold,canStart,toggle,onError,onPress,setTimer,clearTimer,holdDelay});this.gesture=null;
  }
  press(id,{immediate=false}={}) {
    if (this.gesture || this.hold.active || !this.canStart()) return false;
    const gesture={id,held:immediate};this.gesture=gesture;this.onPress(true);
    const begin=()=>{
      if (this.gesture!==gesture || !this.canStart()) return;
      gesture.held=true;return this.hold.start().catch(this.onError);
    };
    if (immediate) begin();else this.timer=this.setTimer(begin,this.holdDelay);
    return true;
  }
  async release(id,{cancel=false}={}) {
    const gesture=this.gesture;if (!gesture || gesture.id!==id) return;
    this.clearTimer(this.timer);this.timer=null;this.gesture=null;this.onPress(false);
    if (gesture.held) await this.hold.stop();
    else if (!cancel && this.canStart()) await this.toggle();
  }
  async cancel() {
    if (this.gesture) await this.release(this.gesture.id,{cancel:true});
    else if (this.hold.active) await this.hold.stop();
  }
  disconnected() {
    this.clearTimer(this.timer);this.timer=null;this.gesture=null;this.hold.reset();this.onPress(false);
  }
}
