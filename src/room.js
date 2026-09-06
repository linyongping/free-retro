// BoardRoom: one Durable Object per board, acting as a broadcast bell.
// D1 remains the source of truth — mutations write there first, then ping
// this room, which wakes up and fans a "changed" event out to every open
// board. Uses the WebSocket Hibernation API so idle connections cost nothing.
export class BoardRoom {
  constructor(state, env) {
    this.state = state;
  }

  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === "/notify" && request.method === "POST") {
      const event = await request.json().catch(() => ({ type: "changed" }));
      this.broadcast(event);
      return new Response(null, { status: 204 });
    }

    if (request.headers.get("upgrade")?.toLowerCase() === "websocket") {
      const pair = new WebSocketPair();
      this.state.acceptWebSocket(pair[1]); // hibernation: idle sockets sleep for free
      return new Response(null, { status: 101, webSocket: pair[0] });
    }

    return new Response("expected websocket upgrade or notify", { status: 400 });
  }

  broadcast(event) {
    const msg = JSON.stringify(event);
    for (const ws of this.state.getWebSockets()) {
      try { ws.send(msg); } catch {}
    }
  }

  webSocketMessage(ws) {
    // clients only send keepalives — D1 is the source of truth
    try { ws.send(JSON.stringify({ type: "pong" })); } catch {}
  }

  webSocketClose() {}
}
