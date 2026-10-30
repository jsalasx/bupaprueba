import { NgZone } from '@angular/core';
import { Observable } from 'rxjs';

/** Un evento SSE con nombre. `reconnected` acompaña a `ready`. */
export interface SseEvent {
  event: string;
  data?: string;
  /** Solo en `ready`: no es la primera conexión, lo ocurrido mientras estaba caída no llegó. */
  reconnected: boolean;
}

export interface SseStreamOptions {
  url: string;
  /** Se lee en cada conexión, así una reconexión usa el token vigente. */
  token: () => string | null;
  zone: NgZone;
  /** true al recibir `ready`, false al cortarse. */
  onConnected?: (connected: boolean) => void;
}

/**
 * Stream SSE autenticado que reconecta solo.
 *
 * Usa fetch y no EventSource porque EventSource no permite enviar el header
 * Authorization, y el backend (y Kong) autentican con el bearer del usuario.
 * Poner el token en la URL lo dejaría en los logs de la puerta de enlace.
 *
 * El servidor cierra la conexión cada 15 minutos para exigir un token vigente;
 * se reconecta con el token que tenga la sesión en ese momento. Un 403 o 404 no
 * se reintenta: la cuenta no tiene acceso y reintentar no lo cambia.
 */
export function sseStream(options: SseStreamOptions): Observable<SseEvent> {
  const { url, token, zone, onConnected } = options;
  return new Observable<SseEvent>((subscriber) => {
    let stopped = false;
    let abort: AbortController | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let retryMs = 5000;
    let connections = 0;

    const setConnected = (value: boolean) => zone.run(() => onConnected?.(value));
    const emit = (event: SseEvent) => zone.run(() => subscriber.next(event));

    const scheduleReconnect = () => {
      setConnected(false);
      if (stopped) return;
      retryTimer = setTimeout(() => void connect(), retryMs);
    };

    const connect = async () => {
      if (stopped) return;
      const accessToken = token();
      if (!accessToken) {
        scheduleReconnect();
        return;
      }

      abort = new AbortController();
      try {
        const response = await fetch(url, {
          headers: { Accept: 'text/event-stream', Authorization: `Bearer ${accessToken}` },
          signal: abort.signal,
          cache: 'no-store',
        });
        if (response.status === 403 || response.status === 404) {
          setConnected(false);
          return;
        }
        if (!response.ok || !response.body) {
          scheduleReconnect();
          return;
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        while (!stopped) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const frames = buffer.split(/\r?\n\r?\n/);
          buffer = frames.pop() ?? '';
          for (const frame of frames) {
            const parsed = parseFrame(frame);
            if (parsed.retry) retryMs = parsed.retry;
            if (!parsed.event) continue;
            if (parsed.event === 'ready') {
              setConnected(true);
              emit({ event: 'ready', reconnected: connections++ > 0 });
            } else {
              emit({ event: parsed.event, data: parsed.data, reconnected: false });
            }
          }
        }
      } catch {
        // Corte de red o abort. Si fue abort, `stopped` impide reconectar.
      }
      scheduleReconnect();
    };

    void connect();

    return () => {
      stopped = true;
      if (retryTimer) clearTimeout(retryTimer);
      abort?.abort();
      onConnected?.(false);
    };
  });
}

/** Interpreta un frame SSE: `event:`, `data:` (puede repetirse), `retry:`; ignora comentarios `:`. */
function parseFrame(frame: string): { event?: string; data?: string; retry?: number } {
  const result: { event?: string; data?: string; retry?: number } = {};
  const data: string[] = [];
  for (const line of frame.split(/\r?\n/)) {
    if (!line || line.startsWith(':')) continue;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    const value = colon === -1 ? '' : line.slice(colon + 1).replace(/^ /, '');
    if (field === 'event') result.event = value;
    else if (field === 'data') data.push(value);
    else if (field === 'retry' && /^\d+$/.test(value)) result.retry = Number(value);
  }
  if (data.length) result.data = data.join('\n');
  return result;
}
