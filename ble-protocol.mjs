import {validateRemoteDisplay} from './remote-screen.mjs?screen=lumi-controls';

export const UUIDS = Object.freeze({
  service: '6e400001-b5a3-f393-e0a9-e50e24dcca9e',
  rx: '6e400002-b5a3-f393-e0a9-e50e24dcca9e',
  tx: '6e400003-b5a3-f393-e0a9-e50e24dcca9e',
});

const encoder = new TextEncoder();
const integer = (value, min, max) => Number.isSafeInteger(value) && value >= min && value <= max;

export function frameJson(value, {messageId = 0, maxPacketBytes = 20, maxBytes = 768} = {}) {
  if (!integer(messageId, 0, 255) || !integer(maxPacketBytes, 5, 512)) throw new Error('Invalid packet options');
  const bytes = encoder.encode(JSON.stringify(value));
  if (!bytes.length || bytes.length > maxBytes) throw new Error('Message exceeds byte limit / too large');
  const payloadSize = maxPacketBytes - 4;
  const count = Math.ceil(bytes.length / payloadSize);
  if (count > 65536) throw new Error('Too many chunks');
  const packets = [];
  for (let index = 0; index < count; index++) {
    const payload = bytes.subarray(index * payloadSize, (index + 1) * payloadSize);
    const packet = new Uint8Array(payload.length + 4);
    packet[0] = (index === 0 ? 1 : 0) | (index === count - 1 ? 2 : 0);
    packet[1] = messageId;
    new DataView(packet.buffer).setUint16(2, index, true);
    packet.set(payload, 4);
    packets.push(packet);
  }
  return packets;
}

export class MessageReassembler {
  constructor({maxBytes = 8192, timeoutMs = 20000} = {}) {
    this.maxBytes = maxBytes;
    this.timeoutMs = timeoutMs;
    this.reset();
  }
  reset() {
    this.buffer = null;
    this.length = 0;
    this.nextIndex = 0;
    this.messageId = -1;
    this.startedAt = 0;
  }
  push(input, now = Date.now()) {
    try {
      const bytes = ArrayBuffer.isView(input)
        ? new Uint8Array(input.buffer, input.byteOffset, input.byteLength)
        : new Uint8Array(input);
      if (bytes.length < 5) throw new Error('Short BLE packet');
      const flags = bytes[0];
      const index = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint16(2, true);
      if (flags & ~3) throw new Error('Invalid BLE flags');
      if (flags & 1) {
        if (index !== 0) throw new Error('START requires chunk zero');
        this.reset();
        this.buffer = new Uint8Array(this.maxBytes);
        this.messageId = bytes[1];
        this.startedAt = now;
      }
      if (!this.buffer || bytes[1] !== this.messageId || index !== this.nextIndex) throw new Error('Out-of-order BLE chunk');
      if (now - this.startedAt > this.timeoutMs) throw new Error('BLE assembly timeout');
      if (this.length + bytes.length - 4 > this.maxBytes) throw new Error('BLE message overflow');
      this.buffer.set(bytes.subarray(4), this.length);
      this.length += bytes.length - 4;
      this.nextIndex++;
      if (!(flags & 2)) return null;
      const text = new TextDecoder('utf-8', {fatal: true}).decode(this.buffer.subarray(0, this.length));
      const result = JSON.parse(text);
      this.reset();
      return result;
    } catch (error) {
      this.reset();
      throw error;
    }
  }
}

export function validateControl(value) {
  const allowed = ['sync', 'toggle_chat', 'listen_start', 'listen_stop', 'set_volume', 'display_ack', 'display_fail'];
  if (!value || value.v !== 1 || !integer(value.id, 0, 0x7fffffff) || !allowed.includes(value.cmd)) throw new Error('Invalid control');
  const withValue=['set_volume','display_ack','display_fail'].includes(value.cmd);
  const keys = withValue ? ['v', 'id', 'cmd', 'value'] : ['v', 'id', 'cmd'];
  if (Object.keys(value).some(key => !keys.includes(key))) throw new Error('Unexpected control field');
  if (value.cmd === 'set_volume' && !integer(value.value, 0, 100)) throw new Error('Invalid volume');
  if (['display_ack','display_fail'].includes(value.cmd) && !integer(value.value,1,0x7fffffff)) throw new Error('Invalid display revision');
  return value;
}

export function validateSnapshot(value) {
  if (!value || value.v !== 1 || value.type !== 'snapshot' || !integer(value.seq, 0, Number.MAX_SAFE_INTEGER) ||
      !integer(value.state, 0, 11) || !integer(value.volume, 0, 100) ||
      typeof value.status !== 'string' || typeof value.notification !== 'string' || typeof value.emotion !== 'string' ||
      !Number.isFinite(value.uptime_s) || value.uptime_s < 0 ||
      typeof value.wifi?.connected !== 'boolean' || typeof value.wifi.ssid !== 'string' || !Number.isFinite(value.wifi.rssi) ||
      !Array.isArray(value.messages) || value.messages.length > 6 ||
      value.messages.some(message => !message || !['system', 'user', 'assistant'].includes(message.role) || typeof message.text !== 'string')) {
    throw new Error('设备快照格式不匹配，请检查固件版本');
  }
  if (value.display!==undefined) validateRemoteDisplay(value.display);
  return value;
}
