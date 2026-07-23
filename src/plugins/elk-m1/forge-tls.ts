// TLS 1.0 + 3DES socket wrapper using node-forge.
// Node.js 22 / OpenSSL 3.x removed 3DES; the M1XEP only supports
// TLS_RSA_WITH_3DES_EDE_CBC_SHA (0x000A), so we must use forge.

import { createConnection, type Socket } from 'net';
import { EventEmitter } from 'events';
import * as forge from 'node-forge';
// Registers TLS_RSA_WITH_3DES_EDE_CBC_SHA into forge — must run before createConnection
require('./des-cipher-suites');

export class ForgeTLSSocket extends EventEmitter {
  private tcp: Socket;
  private conn: ReturnType<typeof forge.tls.createConnection>;
  private _timeoutMs = 0;
  private _timeoutTimer: NodeJS.Timeout | null = null;
  private _destroyed = false;

  constructor(host: string, port: number) {
    super();
    this.tcp = createConnection({ host, port });

    this.conn = forge.tls.createConnection({
      server: false,
      cipherSuites: [forge.tls.CipherSuites['TLS_RSA_WITH_3DES_EDE_CBC_SHA']],
      // no virtualHost — M1XEP (TLS 1.0 embedded device) rejects ClientHello with SNI extension
      verify: (_conn, _verified, _depth, _certs) => true,
      connected: (_conn) => {
        this._resetTimeout();
        this.emit('secureConnect');
      },
      tlsDataReady: (_conn) => {
        const bytes = (this.conn as any).tlsData.getBytes();
        if (!this._destroyed) this.tcp.write(bytes, 'binary');
      },
      dataReady: (_conn) => {
        const bytes = (this.conn as any).data.getBytes();
        this._resetTimeout();
        if (!this._destroyed) this.emit('data', Buffer.from(bytes, 'binary'));
      },
      closed: (_conn) => {
        this._clearTimeout();
        if (!this._destroyed) this.emit('close');
      },
      error: (_conn, err: { message?: string }) => {
        this._clearTimeout();
        if (!this._destroyed) this.emit('error', new Error(err.message ?? 'TLS error'));
      },
    } as Parameters<typeof forge.tls.createConnection>[0]);

    // forge defaults to TLS 1.1 in ClientHello; M1XEP only supports TLS 1.0.
    // Patching conn.version directly is the only reliable way since the global
    // forge.tls.Version assignment doesn't propagate to the connection's closure.
    (this.conn as any).version = (forge.tls as any).Versions.TLS_1_0;

    this.tcp.on('connect', () => {
      (this.conn as any).handshake();
    });

    this.tcp.on('data', (chunk: Buffer) => {
      try { (this.conn as any).process(chunk.toString('binary')); }
      catch (e) { this.emit('error', e); }
    });

    this.tcp.on('error', (err: Error) => {
      this._clearTimeout();
      if (!this._destroyed) this.emit('error', err);
    });

    this.tcp.on('close', () => {
      this._clearTimeout();
      if (!this._destroyed) this.emit('close');
    });
  }

  write(data: string, _encoding?: string): boolean {
    if (this._destroyed) return false;
    try { (this.conn as any).prepare(Buffer.from(data, 'ascii').toString('binary')); }
    catch (e) { this.emit('error', e); }
    return true;
  }

  destroy() {
    this._destroyed = true;
    this._clearTimeout();
    this.tcp.destroy();
  }

  setTimeout(ms: number) {
    this._timeoutMs = ms;
    this._resetTimeout();
  }

  private _resetTimeout() {
    if (!this._timeoutMs) return;
    this._clearTimeout();
    this._timeoutTimer = setTimeout(() => {
      if (!this._destroyed) this.emit('timeout');
    }, this._timeoutMs);
  }

  private _clearTimeout() {
    if (this._timeoutTimer) {
      clearTimeout(this._timeoutTimer);
      this._timeoutTimer = null;
    }
  }
}
