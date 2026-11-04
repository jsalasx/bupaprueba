import { Injectable, NgZone, inject } from '@angular/core';
import { Observable, mergeMap } from 'rxjs';
import { AuthService } from '../auth.service';
import { environment } from '../../environments/environment';
import { sseStream } from '../shared/sse-stream';

/**
 * Eventos del stream SSE de un requerimiento (GET /chat/tickets/:id/stream).
 *
 *   - ready: la suscripción quedó abierta. Si `reconnected`, el requerimiento
 *     pudo cambiar mientras estaba caída: hay que recargarlo.
 *   - closed: el médico cerró el requerimiento. El servidor termina el stream.
 */
export type TicketStreamEvent = { type: 'ready'; reconnected: boolean } | { type: 'closed' } | { type: 'delivered' };

/** Cliente del stream en vivo de un requerimiento, para quienes participan en él. */
@Injectable({ providedIn: 'root' })
export class TicketStreamService {
  private readonly auth = inject(AuthService);
  private readonly zone = inject(NgZone);

  /** Abre el stream al suscribirse y lo cierra al desuscribirse. */
  events(ticketId: string): Observable<TicketStreamEvent> {
    return sseStream({
      url: `${environment.apiBaseUrl}/chat/tickets/${ticketId}/stream`,
      token: () => this.auth.accessToken(),
      zone: this.zone,
    }).pipe(
      mergeMap((e): TicketStreamEvent[] => {
        if (e.event === 'ready') return [{ type: 'ready', reconnected: e.reconnected }];
        if (e.event === 'message_delivered') return [{ type: 'delivered' }];
        if (e.event === 'ticket_closed') return [{ type: 'closed' }];
        return [];
      }),
    );
  }
}
