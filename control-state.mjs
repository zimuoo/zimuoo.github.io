// Exact order from main/device_state.h. Text is presentation, never a command.
export const DEVICE_STATES = Object.freeze([
  {name:'状态未知',description:'等待设备报告当前状态。'},
  {name:'启动中',description:'小智正在准备声音与网络。'},
  {name:'配网中',description:'请按照设备提示完成 Wi-Fi 配置。'},
  {name:'待命',description:'我在这里，随时听你说。'},
  {name:'连接中',description:'正在连接对话服务，请稍候。'},
  {name:'聆听中',description:'说吧，我在认真听。'},
  {name:'回答中',description:'正在把想说的话，慢慢告诉你。'},
  {name:'播报中',description:'小智正在播放一条通知。'},
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
  constructor({send, onChange = () => {}}) {
    this.send = send;
    this.onChange = onChange;
    this.active = false;
    this.generation = 0;
  }
  async start() {
    if (this.active) return;
    this.active = true;
    const generation = ++this.generation;
    this.onChange(true);
    try { await this.send('listen_start'); }
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
    this.active = false;
    this.generation++;
    this.onChange(false);
  }
}
