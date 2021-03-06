import WebSocket from "ws";

import type { NodeStats } from "@lavaclient/types";
import type { Manager, ReconnectOptions } from "./Manager";

export enum Status {
  CONNECTED,
  CONNECTING,
  IDLE,
  DISCONNECTED,
  RECONNECTING
}

export class Socket {
  /**
   * The link manager instance.
   */
  public readonly manager: Manager;

  /**
   * This lavalink nodes identifier.
   */
  public readonly id: string;

  /**
   * Number of remaining reconnect tries.
   */
  public remainingTries: number;

  /**
   * The status of this lavalink node.
   */
  public status: Status;

  /**
   * Hostname of the lavalink node.
   */
  public host: string;

  /**
   * Port of the lavalink node.
   */
  public port?: number;

  /**
   * Password of the lavalink node.
   */
  public password!: string

  /**
   * The performance stats of this player.
   */
  public stats: NodeStats;

  /**
   * The resume key.
   */
  public resumeKey?: string;

  /**
   * Whether or not this lavalink node uses an ssl.
   */
  public secure: boolean;

  /**
   * The timeout for reconnecting.
   */
  private reconnectTimeout!: NodeJS.Timeout;

  /**
   * WebSocket instance for this socket.
   */
  private ws?: WebSocket;

  /**
   * Queue for outgoing messages.
   */
  private readonly queue: Payload[];

  /**
   * @param manager
   * @param data
   */
  public constructor(manager: Manager, data: SocketData) {
    this.manager = manager;
    this.id = data.id;

    this.host = data.host;
    this.port = data.port;
    this.secure = data.secure ?? false;
    Object.defineProperty(this, "password", { value: data.password ?? "youshallnotpass" });

    this.remainingTries = Number(manager.options.reconnect.maxTries ?? 5);
    this.status = Status.IDLE;
    this.queue = [];
    this.stats = {
      cpu: { cores: 0, lavalinkLoad: 0, systemLoad: 0 },
      frameStats: { deficit: 0, nulled: 0, sent: 0 },
      memory: { allocated: 0, free: 0, reservable: 0, used: 0 },
      players: 0,
      playingPlayers: 0,
      uptime: 0
    };
  }

  // @ts-ignore
  /**
   *
   */
  public get reconnection(): ReconnectOptions {
    return this.manager.options.reconnect;
  }

  /**
   * If this node is connected or not.
   */
  public get connected(): boolean {
    return this.ws !== undefined
      && this.ws.readyState === WebSocket.OPEN;
  }

  /**
   * The address of this lavalink node.
   */
  public get address(): string {
    return `${this.host}${this.port ? `:${this.port}` : ""}`;
  }

  /**
   * Get the total penalty count for this node.
   */
  public get penalties() {
    const cpu = Math.pow(1.05, 100 * this.stats.cpu.systemLoad) * 10 - 10;

    let deficit = 0, nulled = 0;
    if (this.stats.frameStats?.deficit != -1) {
      deficit = Math.pow(1.03, 500 * ((this.stats.frameStats?.deficit ?? 0) / 3000)) * 600 - 600;
      nulled = (Math.pow(1.03, 500 * ((this.stats.frameStats?.nulled ?? 0) / 3000)) * 600 - 600) * 2;
      nulled *= 2;
    }

    return cpu + deficit + nulled;
  }

  /**
   * Send a message to lavalink.
   * @param data The message data.
   * @param priority If this message should be prioritized.
   * @since 1.0.0
   */
  public async send(data: unknown, priority = false): Promise<void> {
    return new Promise((resolve, reject) => {
      data = JSON.stringify(data);
      this.queue[priority ? "unshift" : "push"]({ data: data, reject, resolve });
      if (this.connected) this._processQueue();
    });
  }

  /**
   * Connects to the lavalink node.
   * @since 1.0.0
   */
  public connect(): void {
    if (this.status !== Status.RECONNECTING)
      this.status = Status.CONNECTING;

    if (this.connected) {
      this._cleanup();
      this.ws?.close(1012);
      delete this.ws;
    }

    const headers: Record<string, string | number> = {
      authorization: this.password,
      "num-shards": this.manager.options.shards as number,
      "user-id": this.manager.userId as string,
    };
    if (this.resumeKey) headers["resume-key"] = this.resumeKey;

    this.ws = new WebSocket(`ws${this.secure ? "s" : ""}://${this.address}`, { headers });
    this.ws.onopen = this._open.bind(this);
    this.ws.onmessage = this._message.bind(this);
    this.ws.onclose = this._close.bind(this);
    this.ws.onerror = this._error.bind(this);
  }

  /**
   * Reconnect to the lavalink node.
   */
  public reconnect(): void {
    if (this.remainingTries !== 0) {
      this.remainingTries -= 1;
      this.status = Status.RECONNECTING;

      try {
        this.connect();
        clearTimeout(this.reconnectTimeout);
      } catch (e) {
        this.manager.emit("socketError", this, e);
        this.reconnectTimeout = setTimeout(() => {
          this.reconnect();
        }, this.reconnection.delay ?? 15000);
      }
    } else {
      this.status = Status.DISCONNECTED;
      this.manager.emit("socketDisconnect", this, "Ran out of reconnect tries.");
    }
  }

  /**
   * Configures lavalink resuming.
   * @since 1.0.0
   */
  private async configureResuming(): Promise<void> {
    if (this.reconnection !== null) {
      this.resumeKey = this.manager.resuming.key ?? Math.random().toString(32);

      return this.send({
        op: "configureResuming",
        timeout: this.manager.resuming.timeout ?? 60000,
        key: this.resumeKey
      }, true);
    }
  }

  /**
   * Handles the opening of the websocket.
   * @private
   */
  private async _open(): Promise<void> {
    this.manager.emit("socketReady", this);

    await this._processQueue()
      .then(() => this.configureResuming())
      .catch((e) => this.manager.emit("socketError", this, e));

    this.status = Status.CONNECTED;
  }

  /**
   * Handles incoming messages from lavalink.
   * @since 1.0.0
   * @private
   */
  private async _message({ data }: WebSocket.MessageEvent): Promise<void> {
    if (data instanceof ArrayBuffer) data = Buffer.from(data);
    else if (Array.isArray(data)) data = Buffer.concat(data);

    let pk: any;
    try {
      pk = JSON.parse(data.toString());
    } catch (e) {
      this.manager.emit("socketError", this, e);
      return;
    }

    const player = this.manager.players.get(pk.guildId as string);
    if (pk.guildId && player) await player.emit(pk.op, pk);
    else if (pk.op === "stats") this.stats = pk;
  }

  /**
   * Handles the close of the websocket.
   * @since 1.0.0
   * @private
   */
  private _close(event: WebSocket.CloseEvent): void {
    if (this.remainingTries === this.reconnection.maxTries)
      this.manager.emit("socketClose", event);

    if (event.code !== 1000 && event.reason !== "destroy") {
      if (this.reconnection.auto) this.reconnect();
    }
  }

  /**
   * Handles a websocket error.
   * @since 1.0.0
   * @private
   */
  private _error(event: WebSocket.ErrorEvent): void {
    const error = event.error ? event.error : event.message;
    this.manager.emit("socketError", this, error);
  }

  /**
   * @private
   */
  private async _processQueue(): Promise<void> {
    if (this.queue.length === 0) return;

    while (this.queue.length > 0) {
      const payload = this.queue.shift();
      if (!payload) return;
      await this._send(payload);
    }
  }

  /**
   * @private
   */
  private async _send(payload: Payload): Promise<void> {
    return this.ws!.send(payload.data, err => {
      if (err) payload.reject(err);
      else payload.resolve();
    });
  }

  /**
   * Cleans up the websocket listeners.
   * @since 1.0.0
   * @private
   */
  private _cleanup(): void {
    delete this.ws!.onclose;
    delete this.ws!.onopen;
    delete this.ws!.onmessage;
    delete this.ws!.onerror;
  }
}

export interface SocketData {
  /**
   * The ID of this lavalink node.
   */
  id: string;

  /**
   * The host of this lavalink node.
   */
  host: string;

  /**
   * Whether or not this node is secured via ssl.
   */
  secure?: boolean;

  /**
   * The port of this lavalink node.
   */
  port?: number;

  /**
   * The password of this lavalink node.
   */
  password?: string
}

export interface Payload {
  resolve: (...args: any[]) => unknown;
  reject: (...args: unknown[]) => unknown;
  data: unknown;
}
