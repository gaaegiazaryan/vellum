'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { io, type Socket } from 'socket.io-client';

/**
 * Listens for a status change on the given extraction id over a
 * Socket.IO connection (ADR-0012) and re-runs the server component as
 * soon as the worker pushes a non-pending status. The socket connects
 * on the same origin under namespace /extractions, joins room ext:<id>,
 * and forwards onto the existing router.refresh() refetch path so the
 * page rendering stays driven by the server fetch.
 *
 * Falls back to a 10-second polling interval whenever the socket is
 * disconnected, so a user behind a proxy that ate the WebSocket
 * upgrade still leaves the pending screen on their own.
 */
export function StatusListener({ id }: { id: string }) {
  const router = useRouter();
  const [connected, setConnected] = useState(false);
  const socketRef = useRef<Socket | null>(null);

  useEffect(() => {
    // NEXT_PUBLIC_API_URL points at the api when web and api are on
    // different origins (dev: :3000 vs :3001, separate-domain deploys).
    // When unset, the socket goes same-origin and a reverse proxy in
    // front is expected to route /socket.io to the api service.
    const base = process.env.NEXT_PUBLIC_API_URL ?? '';
    const socket = io(`${base}/extractions`, {
      withCredentials: true,
      transports: ['websocket', 'polling'],
      reconnectionAttempts: Infinity,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000,
    });
    socketRef.current = socket;

    socket.on('connect', () => {
      setConnected(true);
      socket.emit('subscribe-extraction', { id });
    });
    socket.on('disconnect', () => setConnected(false));
    socket.on('extraction-status', (event: { extractionId: string; status: string }) => {
      if (event.extractionId !== id) return;
      if (event.status !== 'pending') router.refresh();
    });

    return () => {
      socket.emit('unsubscribe-extraction', { id });
      socket.disconnect();
      socketRef.current = null;
    };
  }, [id, router]);

  useEffect(() => {
    if (connected) return;
    const t = setInterval(() => router.refresh(), 10_000);
    return () => clearInterval(t);
  }, [connected, router]);

  return null;
}
