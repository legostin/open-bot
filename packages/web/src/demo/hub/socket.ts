// The demo's stand-in for the hub's realtime socket (/api/ws): the app's HubSocket opens it as a WebSocket, the demo
// hub pushes UiEvents into every open one, and what the app sends (plugin messages) goes to the hub.

export interface SocketPeer {
  /** A new socket opened: the hub keeps it until it closes. */
  connect(socket: DemoSocket): void;
  disconnect(socket: DemoSocket): void;
  received(socket: DemoSocket, data: string): void;
}

export class DemoSocket extends EventTarget {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  readonly CONNECTING = 0;
  readonly OPEN = 1;
  readonly CLOSING = 2;
  readonly CLOSED = 3;

  readyState = 0;
  readonly url: string;
  readonly protocol = "";
  readonly extensions = "";
  binaryType: BinaryType = "blob";
  bufferedAmount = 0;
  onopen: ((ev: Event) => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onclose: ((ev: CloseEvent) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;
  private peer: SocketPeer;

  constructor(url: string, peer: SocketPeer) {
    super();
    this.url = url;
    this.peer = peer;
    // Open on the next tick, as a real socket would.
    setTimeout(() => {
      if (this.readyState !== 0) return;
      this.readyState = 1;
      this.peer.connect(this);
      this.fire(new Event("open"), this.onopen);
    }, 0);
  }

  send(data: string): void {
    if (this.readyState !== 1) throw new DOMException("not open", "InvalidStateError");
    this.peer.received(this, String(data));
  }

  close(code = 1000, reason = ""): void {
    if (this.readyState >= 2) return;
    this.readyState = 3;
    this.peer.disconnect(this);
    this.fire(new CloseEvent("close", { code, reason, wasClean: true }), this.onclose);
  }

  /** The hub's side: one frame to the app. */
  deliver(data: string): void {
    if (this.readyState !== 1) return;
    this.fire(new MessageEvent("message", { data }), this.onmessage);
  }

  private fire<E extends Event>(ev: E, handler: ((ev: E) => void) | null): void {
    handler?.call(this as unknown as WebSocket, ev);
    this.dispatchEvent(ev);
  }
}
