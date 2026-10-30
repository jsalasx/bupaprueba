import { Injectable, NgZone, inject, signal } from '@angular/core';
import { Observable, mergeMap } from 'rxjs';
import { sseStream } from '../shared/sse-stream';
import { AuthService } from '../auth.service';
import { environment } from '../../environments/environment';

/**
 * Eventos del stream SSE de la cola (GET /chat/queue/stream).
 *
 *   - ready: la suscripción quedó abierta. `reconnected` indica que no es la
 *     primera conexión: lo ocurrido mientras estaba caída no llegó, así que hay
 *     que recargar la cola.
 *   - queue_updated: la cola cambió. Solo trae el motivo y el id; el contenido se
 *     vuelve a pedir con GET /chat/tickets/queue.
 */
export type QueueStreamEvent =
  | { type: 'ready'; reconnected: boolean }
  | {
      type: 'queue_updated';
      reason: 'created' | 'claimed' | 'released';
      ticketId: string;
      occurredAt: string;
    };

/** Cliente del stream en vivo de la cola del equipo médico. */
@Injectable({ providedIn: 'root' })
export class QueueStreamService {
  private readonly auth = inject(AuthService);
  private readonly zone = inject(NgZone);

  /** true mientras el stream está abierto; la pantalla lo muestra como "En vivo". */
  readonly connected = signal(false);

  /** Abre el stream al suscribirse y lo cierra al desuscribirse. */
  events(): Observable<QueueStreamEvent> {
    return sseStream({
      url: `${environment.apiBaseUrl}/chat/queue/stream`,
      token: () => this.auth.accessToken(),
      zone: this.zone,
      onConnected: (value) => this.connected.set(value),
    }).pipe(
      mergeMap((e): QueueStreamEvent[] => {
        if (e.event === 'ready') return [{ type: 'ready', reconnected: e.reconnected }];
        if (e.event !== 'queue_updated' || !e.data) return [];
        try {
          return [{ type: 'queue_updated', ...JSON.parse(e.data) }];
        } catch {
          // Un evento mal formado se ignora: el siguiente o la reconexión recargan igual.
          return [];
        }
      }),
    );
  }
}
