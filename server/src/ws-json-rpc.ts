import crypto from 'node:crypto';
import net from 'node:net';
import { EventEmitter } from 'node:events';

type Pending = { resolve:(value:any)=>void; reject:(err:any)=>void; timer:NodeJS.Timeout };

export class WsJsonRpcClient extends EventEmitter {
  private socket: net.Socket | null = null;
  private buffer = Buffer.alloc(0);
  private nextId = 1;
  private pending = new Map<number, Pending>();

  constructor(private host:string, private port:number, private path = '/') { super(); }

  async connect() {
    const header = await new Promise<string>((resolve, reject) => {
      const key = crypto.randomBytes(16).toString('base64');
      const socket = net.connect({ host:this.host, port:this.port }, () => {
        socket.write([
          `GET ${this.path} HTTP/1.1`,
          `Host: ${this.host}:${this.port}`,
          'Upgrade: websocket',
          'Connection: Upgrade',
          `Sec-WebSocket-Key: ${key}`,
          'Sec-WebSocket-Version: 13',
          '',
          '',
        ].join('\r\n'));
      });
      let headerBuffer = Buffer.alloc(0);
      const onHandshake = (chunk:Buffer) => {
        headerBuffer = Buffer.concat([headerBuffer, chunk]);
        const idx = headerBuffer.indexOf('\r\n\r\n');
        if (idx < 0) return;
        const head = headerBuffer.slice(0, idx).toString('utf8');
        if (!/^HTTP\/1\.1 101\b/.test(head)) {
          socket.destroy();
          reject(new Error(`websocket handshake failed: ${head.split('\r\n')[0] || 'no status'}`));
          return;
        }
        socket.off('data', onHandshake);
        this.socket = socket;
        socket.on('data', data => this.onData(data));
        socket.on('error', err => this.emit('error', err));
        socket.on('close', () => this.onClose());
        const rest = headerBuffer.slice(idx + 4);
        if (rest.length) this.onData(rest);
        resolve(head);
      };
      socket.on('data', onHandshake);
      socket.on('error', reject);
    });
    this.emit('handshake', header);
    return header;
  }

  isConnected() { return !!this.socket && !this.socket.destroyed; }

  request(method:string, params?:any, timeoutMs = 120_000) {
    if (!this.socket || this.socket.destroyed) throw new Error('websocket is not connected');
    const id = this.nextId++;
    const body:any = { id, method };
    if (params !== undefined) body.params = params;
    this.sendFrame(JSON.stringify(body));
    return new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
    });
  }

  notify(method:string, params?:any) {
    if (!this.socket || this.socket.destroyed) return;
    const body:any = { method };
    if (params !== undefined) body.params = params;
    this.sendFrame(JSON.stringify(body));
  }

  respond(id:number|string, result:any) {
    if (!this.socket || this.socket.destroyed) return;
    this.sendFrame(JSON.stringify({ id, result }));
  }

  close() {
    try { this.sendFrame(Buffer.alloc(0), 8); } catch {}
    this.socket?.end();
    this.socket = null;
  }

  private onClose() {
    const pending = [...this.pending.values()];
    this.pending.clear();
    for (const p of pending) {
      clearTimeout(p.timer);
      p.reject(new Error('websocket closed'));
    }
    this.emit('close');
  }

  private onData(data:Buffer) {
    this.buffer = Buffer.concat([this.buffer, data]);
    for (;;) {
      const frame = this.readFrame();
      if (!frame) return;
      if (frame.opcode === 8) {
        this.socket?.end();
        return;
      }
      if (frame.opcode === 9) {
        this.sendFrame(frame.payload, 10);
        continue;
      }
      if (frame.opcode !== 1) continue;
      let msg:any;
      const text = frame.payload.toString('utf8');
      try { msg = JSON.parse(text); } catch { this.emit('raw', text); continue; }
      if (msg.id !== undefined && this.pending.has(msg.id)) {
        const pending = this.pending.get(msg.id)!;
        clearTimeout(pending.timer);
        this.pending.delete(msg.id);
        if (msg.error) pending.reject(Object.assign(new Error(msg.error.message || 'rpc error'), { data: msg.error }));
        else pending.resolve(msg.result);
        continue;
      }
      if (msg.id !== undefined && msg.method) this.emit('request', msg);
      else if (msg.method) this.emit('notification', msg);
      else this.emit('message', msg);
    }
  }

  private readFrame() {
    if (this.buffer.length < 2) return null;
    const b0 = this.buffer[0];
    const b1 = this.buffer[1];
    const opcode = b0 & 0x0f;
    const masked = !!(b1 & 0x80);
    let len = b1 & 0x7f;
    let offset = 2;
    if (len === 126) {
      if (this.buffer.length < offset + 2) return null;
      len = this.buffer.readUInt16BE(offset);
      offset += 2;
    } else if (len === 127) {
      if (this.buffer.length < offset + 8) return null;
      const big = this.buffer.readBigUInt64BE(offset);
      if (big > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('websocket frame too large');
      len = Number(big);
      offset += 8;
    }
    let mask:Buffer | null = null;
    if (masked) {
      if (this.buffer.length < offset + 4) return null;
      mask = this.buffer.subarray(offset, offset + 4);
      offset += 4;
    }
    if (this.buffer.length < offset + len) return null;
    let payload = this.buffer.subarray(offset, offset + len);
    this.buffer = this.buffer.subarray(offset + len);
    if (mask) {
      const unmasked = Buffer.alloc(payload.length);
      for (let i = 0; i < payload.length; i++) unmasked[i] = payload[i] ^ mask[i % 4];
      payload = unmasked;
    }
    return { opcode, payload };
  }

  private sendFrame(payload:Buffer|string, opcode = 1) {
    if (!this.socket || this.socket.destroyed) return;
    const data = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
    const mask = crypto.randomBytes(4);
    let header:Buffer;
    if (data.length < 126) {
      header = Buffer.from([0x80 | opcode, 0x80 | data.length]);
    } else if (data.length < 65536) {
      header = Buffer.alloc(4);
      header[0] = 0x80 | opcode;
      header[1] = 0x80 | 126;
      header.writeUInt16BE(data.length, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x80 | opcode;
      header[1] = 0x80 | 127;
      header.writeBigUInt64BE(BigInt(data.length), 2);
    }
    const masked = Buffer.alloc(data.length);
    for (let i = 0; i < data.length; i++) masked[i] = data[i] ^ mask[i % 4];
    this.socket.write(Buffer.concat([header, mask, masked]));
  }
}
