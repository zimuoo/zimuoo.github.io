import {UUIDS, frameJson, MessageReassembler, validateControl} from './ble-protocol.mjs';

// Every GATT operation shares this one queue, including connect and disconnect.
export class BleClient {
  constructor({bluetooth = globalThis.navigator?.bluetooth, onState = () => {}, onMessage = () => {}, onError = () => {}} = {}) {
    this.bluetooth = bluetooth;
    this.onState = onState;
    this.onMessage = onMessage;
    this.onError = onError;
    this.phase = 'disconnected';
    this.device = null;
    this.rx = null;
    this.tx = null;
    this.epoch = 0;
    this.requestId = 0;
    this.pendingWrites = 0;
    this.tail = Promise.resolve();
    this.decoder = new MessageReassembler();
    this.receive = event => {
      if (!this.connected) return;
      try {
        const message = this.decoder.push(event.target.value);
        if (message !== null) this.onMessage(message);
      } catch (error) { this.onError(error); }
    };
    this.disconnected = () => {
      this.epoch++;
      this.detach();
      this.setPhase('disconnected');
    };
  }
  get connected() { return this.phase === 'connected' && !!this.device?.gatt?.connected; }
  setPhase(phase) { this.phase = phase; this.onState(phase); }
  serialize(work) {
    const result = this.tail.then(work);
    this.tail = result.catch(() => {});
    return result;
  }
  check(epoch) {
    if (epoch !== this.epoch) throw new Error('连接已取消，请重新连接');
  }
  detach() {
    this.tx?.removeEventListener('characteristicvaluechanged', this.receive);
    this.device?.removeEventListener('gattserverdisconnected', this.disconnected);
    this.decoder.reset();
    this.rx = null;
    this.tx = null;
    this.device = null;
  }
  async connect() {
    if (this.phase !== 'disconnected') throw new Error('连接正在进行中');
    if (!this.bluetooth) throw new Error('当前浏览器没有 Web Bluetooth，请在 Bluefy 中打开 HTTPS 网页');
    const epoch = ++this.epoch;
    this.setPhase('connecting');
    let chosen;
    try {
      // Keep requestDevice directly in the tap's call stack for user activation.
      chosen = await this.bluetooth.requestDevice({filters: [{services: [UUIDS.service]}]});
      this.check(epoch);
      await this.serialize(async () => {
        this.check(epoch);
        this.device = chosen;
        chosen.addEventListener('gattserverdisconnected', this.disconnected);
        const server = await chosen.gatt.connect(); this.check(epoch);
        const service = await server.getPrimaryService(UUIDS.service); this.check(epoch);
        this.rx = await service.getCharacteristic(UUIDS.rx); this.check(epoch);
        this.tx = await service.getCharacteristic(UUIDS.tx); this.check(epoch);
        this.tx.addEventListener('characteristicvaluechanged', this.receive);
        await this.tx.startNotifications(); this.check(epoch);
        this.decoder.reset();
        this.setPhase('connected');
      });
      await this.send('sync');
    } catch (error) {
      if (epoch === this.epoch) {
        this.detach();
        if (chosen?.gatt?.connected) chosen.gatt.disconnect();
        this.setPhase('disconnected');
      } else if (chosen?.gatt?.connected) chosen.gatt.disconnect();
      throw error;
    }
  }
  async disconnect() {
    ++this.epoch;
    const device = this.device;
    const tx = this.tx;
    this.detach();
    this.setPhase('disconnected');
    await this.serialize(async () => {
      if (device?.gatt?.connected) {
        try { await tx?.stopNotifications(); } catch { /* The radio may already be gone. */ }
        device.gatt.disconnect();
      }
    });
  }
  async send(cmd, value) {
    if (!this.connected) throw new Error('蓝牙尚未连接');
    if (this.pendingWrites >= 8) throw new Error('操作较多，请稍后再试');
    this.requestId = this.requestId >= 0x7fffffff ? 1 : this.requestId + 1;
    const control = {v: 1, id: this.requestId, cmd};
    if (value !== undefined) control.value = value;
    validateControl(control);
    const packets = frameJson(control, {messageId: control.id & 255});
    const epoch = this.epoch;
    this.pendingWrites++;
    try {
      await this.serialize(async () => {
        this.check(epoch);
        if (!this.connected) throw new Error('蓝牙连接已断开');
        const rx = this.rx;
        for (const packet of packets) {
          this.check(epoch);
          if (typeof rx.writeValueWithResponse === 'function') await rx.writeValueWithResponse(packet);
          else if (typeof rx.writeValue === 'function') await rx.writeValue(packet);
          else throw new Error('浏览器不支持响应式 GATT 写入');
        }
      });
      return control.id;
    } finally { this.pendingWrites--; }
  }
}
