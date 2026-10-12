import * as Y from 'yjs';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import { messageYjsSyncStep2, readSyncMessage, writeSyncStep1, writeUpdate } from 'y-protocols/sync';
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate, removeAwarenessStates } from 'y-protocols/awareness';
import type { ClientMessage, CollabRole, ServerMessage } from '@vizli/shared';
import { CHANNEL_AWARENESS, CHANNEL_SYNC, type SessionTransport } from './transport';

const HEARTBEAT_MS = 15_000;

export type ProviderOptions = {
  /** Builds the `join` message for each (re)connection. */
  join: () => Extract<ClientMessage, { type: 'join' }>;
  /**
   * Called once per connection when `joined` arrives, before any sync frame is processed.
   * May return a replacement doc/awareness (the cached doc belonged to another document ID);
   * the provider rebinds to it before handling the buffered server step 1.
   */
  onJoined?: (docId: string, role: CollabRole) => Promise<{ doc: Y.Doc; awareness: Awareness } | void> | { doc: Y.Doc; awareness: Awareness } | void;
  onSynced?: (synced: boolean) => void;
  /** The room is joined and buffered frames were processed; session messages may now be sent. */
  onReady?: () => void;
  /** A `join` attempt was refused (`error` with a code while joining). */
  onJoinError?: (message: string, code?: string) => void;
};

type Phase = 'closed' | 'joining' | 'resolving' | 'ready';

/**
 * Binds a Y.Doc and Awareness to the session transport.
 * Per connection: send `join` → buffer channel 0/1 frames → `joined{docId}` → `onJoined` (may swap the doc)
 * → process buffered frames (the server's step 1 is answered with step 2) → send our step 1 and local awareness.
 * `synced` becomes true when the server's step 2 arrives.
 */
export class YSocketProvider {
  synced = false;
  docId: string | undefined;
  private phase: Phase = 'closed';
  private buffered: { channel: number; body: Uint8Array }[] = [];
  private heartbeat: ReturnType<typeof setInterval> | undefined;
  private readonly cleanup: (() => void)[] = [];
  private unbindDoc: () => void = () => {};
  private destroyed = false;
  private connection = 0;

  constructor(
    public doc: Y.Doc,
    public awareness: Awareness,
    private readonly transport: SessionTransport,
    private readonly options: ProviderOptions,
  ) {
    this.bind(doc, awareness);
    this.cleanup.push(
      transport.onOpen(() => this.handleOpen()),
      transport.onClose(() => this.handleClose()),
      transport.onJson((message) => this.handleJson(message)),
      transport.onBinary(CHANNEL_SYNC, (body) => this.handleFrame(CHANNEL_SYNC, body)),
      transport.onBinary(CHANNEL_AWARENESS, (body) => this.handleFrame(CHANNEL_AWARENESS, body)),
    );
    const unload = () => removeAwarenessStates(this.awareness, [this.doc.clientID], 'window unload');
    window.addEventListener('beforeunload', unload);
    this.cleanup.push(() => window.removeEventListener('beforeunload', unload));
    this.heartbeat = setInterval(() => {
      // Re-setting the local state renews it for peers (awareness entries time out after 30 s).
      if (this.phase === 'ready' && this.awareness.getLocalState() !== null) this.awareness.setLocalState(this.awareness.getLocalState());
    }, HEARTBEAT_MS);
    if (transport.open) this.handleOpen();
  }

  get joined() {
    return this.phase === 'ready';
  }

  private bind(doc: Y.Doc, awareness: Awareness) {
    this.unbindDoc();
    this.doc = doc;
    this.awareness = awareness;
    const onUpdate = (update: Uint8Array, origin: unknown) => {
      if (origin === this || this.phase !== 'ready') return;
      const encoder = encoding.createEncoder();
      writeUpdate(encoder, update);
      this.transport.sendBinary(CHANNEL_SYNC, encoding.toUint8Array(encoder));
    };
    const onAwareness = ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }, origin: unknown) => {
      if (origin === this || this.phase !== 'ready') return;
      const changed = [...added, ...updated, ...removed];
      if (changed.length) this.sendAwareness(changed);
    };
    doc.on('update', onUpdate);
    awareness.on('update', onAwareness);
    this.unbindDoc = () => {
      doc.off('update', onUpdate);
      awareness.off('update', onAwareness);
    };
  }

  private sendAwareness(clients: number[]) {
    const encoder = encoding.createEncoder();
    encoding.writeVarUint8Array(encoder, encodeAwarenessUpdate(this.awareness, clients));
    this.transport.sendBinary(CHANNEL_AWARENESS, encoding.toUint8Array(encoder));
  }

  private handleOpen() {
    if (this.destroyed) return;
    this.connection++;
    this.phase = 'joining';
    this.buffered = [];
    this.transport.sendJson(this.options.join());
  }

  /** Re-sends `join` on an open socket whose previous join was refused. */
  rejoin() {
    if (this.destroyed || !this.transport.open || this.phase !== 'closed') return;
    this.handleOpen();
  }

  private handleClose() {
    const others = [...this.awareness.getStates().keys()].filter((id) => id !== this.doc.clientID);
    if (others.length) removeAwarenessStates(this.awareness, others, this);
    this.phase = 'closed';
    this.buffered = [];
    this.setSynced(false);
    this.options.onReady?.();
  }

  private async handleJson(message: ServerMessage) {
    if (message.type === 'error' && this.phase === 'joining' && message.code && message.code !== 'not-joined') {
      this.phase = 'closed';
      this.buffered = [];
      this.options.onJoinError?.(message.message, message.code);
      return;
    }
    if (message.type !== 'joined' || this.phase !== 'joining') return;
    const connection = this.connection;
    this.phase = 'resolving';
    this.docId = message.docId;
    let replacement: { doc: Y.Doc; awareness: Awareness } | void = undefined;
    try {
      replacement = await this.options.onJoined?.(message.docId, message.role);
    } catch (error) {
      console.warn('Could not prepare the local document copy', error);
    }
    if (this.destroyed || connection !== this.connection || this.phase !== 'resolving') return;
    if (replacement) this.bind(replacement.doc, replacement.awareness);
    this.phase = 'ready';
    const pending = this.buffered;
    this.buffered = [];
    for (const frame of pending) this.process(frame.channel, frame.body);
    const step1 = encoding.createEncoder();
    writeSyncStep1(step1, this.doc);
    this.transport.sendBinary(CHANNEL_SYNC, encoding.toUint8Array(step1));
    if (this.awareness.getLocalState() !== null) this.sendAwareness([this.doc.clientID]);
    this.options.onReady?.();
  }

  private handleFrame(channel: number, body: Uint8Array) {
    if (this.phase === 'joining' || this.phase === 'resolving') {
      this.buffered.push({ channel, body: body.slice() });
      return;
    }
    if (this.phase === 'ready') this.process(channel, body);
  }

  private process(channel: number, body: Uint8Array) {
    try {
      if (channel === CHANNEL_SYNC) {
        const decoder = decoding.createDecoder(body);
        const encoder = encoding.createEncoder();
        const type = readSyncMessage(decoder, encoder, this.doc, this);
        if (encoding.length(encoder) > 0) this.transport.sendBinary(CHANNEL_SYNC, encoding.toUint8Array(encoder));
        if (type === messageYjsSyncStep2) this.setSynced(true);
      } else if (channel === CHANNEL_AWARENESS) {
        applyAwarenessUpdate(this.awareness, decoding.readVarUint8Array(decoding.createDecoder(body)), this);
      }
    } catch (error) {
      console.warn('Ignored an unreadable collaboration frame', error);
    }
  }

  private setSynced(synced: boolean) {
    if (this.synced === synced) return;
    this.synced = synced;
    this.options.onSynced?.(synced);
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    clearInterval(this.heartbeat);
    removeAwarenessStates(this.awareness, [this.doc.clientID], 'provider destroyed');
    this.unbindDoc();
    for (const dispose of this.cleanup) dispose();
    this.phase = 'closed';
  }
}
