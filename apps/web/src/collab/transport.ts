import { createActor } from 'xstate';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import type { ClientMessage, ServerMessage } from '@vizli/shared';
import { connectionMachine } from '../lib/machines';

/** Binary frame channels on `/api/session`: one varuint channel prefix, then the payload. */
export const CHANNEL_SYNC = 0;
export const CHANNEL_AWARENESS = 1;
export const CHANNEL_AUDIO = 2;
/** Audio frames are dropped (never queued) while the socket has this much unsent data. */
export const AUDIO_BACKPRESSURE_BYTES = 128_000;

type Listener<T> = (value: T) => void;

/**
 * Owns the `/api/session` WebSocket: exponential reconnect backoff (1 s doubling to 10 s),
 * the connection state machine (READY on the server's `ready`, LOST on close), JSON session
 * messages and channel-prefixed binary frames. One instance per open project.
 */
export class SessionTransport {
  readonly connection = createActor(connectionMachine).start();
  private socket: WebSocket | null = null;
  private retries = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private disposed = false;
  private readonly json = new Set<Listener<ServerMessage>>();
  private readonly binary = new Map<number, Set<Listener<Uint8Array>>>();
  private readonly opens = new Set<() => void>();
  private readonly closes = new Set<() => void>();

  constructor(private readonly url = SessionTransport.defaultUrl()) {
    this.connect();
  }

  static defaultUrl() {
    return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/session`;
  }

  get open() {
    return this.socket?.readyState === WebSocket.OPEN;
  }

  private connect() {
    if (this.disposed) return;
    const ws = new WebSocket(this.url);
    ws.binaryType = 'arraybuffer';
    this.socket = ws;
    ws.onopen = () => {
      if (this.socket !== ws) return;
      this.retries = 0;
      for (const listener of [...this.opens]) listener();
    };
    ws.onmessage = (event) => {
      if (this.socket !== ws) return;
      if (typeof event.data === 'string') {
        let message: ServerMessage;
        try {
          message = JSON.parse(event.data) as ServerMessage;
        } catch {
          return;
        }
        if (message.type === 'ready') this.connection.send({ type: 'READY' });
        for (const listener of [...this.json]) listener(message);
        return;
      }
      if (!(event.data instanceof ArrayBuffer)) return;
      const data = new Uint8Array(event.data);
      let channel: number;
      let body: Uint8Array;
      try {
        const decoder = decoding.createDecoder(data);
        channel = decoding.readVarUint(decoder);
        body = data.subarray(decoder.pos);
      } catch {
        return;
      }
      for (const listener of [...(this.binary.get(channel) ?? [])]) listener(body);
    };
    ws.onclose = () => {
      if (this.socket !== ws) return;
      this.socket = null;
      if (this.disposed) return;
      this.connection.send({ type: 'LOST' });
      for (const listener of [...this.closes]) listener();
      this.timer = setTimeout(() => this.connect(), Math.min(1000 * 2 ** this.retries++, 10_000));
    };
    ws.onerror = () => ws.close();
  }

  sendJson(message: ClientMessage): boolean {
    if (!this.open) return false;
    this.socket!.send(JSON.stringify(message));
    return true;
  }

  /** Sends `varuint(channel) + bytes`. Audio is dropped under backpressure instead of queueing. */
  sendBinary(channel: number, bytes: Uint8Array): boolean {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) return false;
    if (channel === CHANNEL_AUDIO && socket.bufferedAmount >= AUDIO_BACKPRESSURE_BYTES) return false;
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, channel);
    encoding.writeUint8Array(encoder, bytes);
    socket.send(encoding.toUint8Array(encoder));
    return true;
  }

  onJson(listener: Listener<ServerMessage>) {
    this.json.add(listener);
    return () => void this.json.delete(listener);
  }
  onBinary(channel: number, listener: Listener<Uint8Array>) {
    const set = this.binary.get(channel) ?? new Set();
    set.add(listener);
    this.binary.set(channel, set);
    return () => void set.delete(listener);
  }
  onOpen(listener: () => void) {
    this.opens.add(listener);
    return () => void this.opens.delete(listener);
  }
  onClose(listener: () => void) {
    this.closes.add(listener);
    return () => void this.closes.delete(listener);
  }

  dispose() {
    this.disposed = true;
    clearTimeout(this.timer);
    const socket = this.socket;
    this.socket = null;
    socket?.close();
    this.json.clear();
    this.binary.clear();
    this.opens.clear();
    this.closes.clear();
    this.connection.stop();
  }
}
