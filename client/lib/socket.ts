// lib/socket.ts
// Singleton Socket.io client, import this everywhere instead of creating new instances

import { io, Socket } from "socket.io-client";

// An empty string is meaningful, not missing: the desktop build serves the page
// from the same origin as the server, so socket.io should connect to the page's
// own origin. Only fall back when the value is genuinely undefined.
const RAW_URL = process.env.NEXT_PUBLIC_SERVER_URL;
const SERVER_URL = RAW_URL === undefined ? "http://localhost:3001" : RAW_URL;

let socket: Socket | null = null;

export function getSocket(): Socket {
  if (!socket) {
    socket = io(SERVER_URL, {
      autoConnect: false,
      reconnection: true,
      reconnectionAttempts: 10,
      reconnectionDelay: 1000,
      transports: ["websocket", "polling"],
    });
  }
  return socket;
}

export function connectSocket(): Socket {
  const s = getSocket();
  if (!s.connected) {
    s.connect();
  }
  return s;
}

export function disconnectSocket() {
  if (socket?.connected) {
    socket.disconnect();
  }
}
