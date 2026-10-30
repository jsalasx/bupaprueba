import { Injectable, inject } from '@angular/core';
import { AuthService } from '../auth.service';
import { environment } from '../../environments/environment';

/** Respuesta de PUT /chat/tickets/:id/presence/:sessionId. */
interface PresenceResponse {
  heartbeatSeconds: number;
  ttlSeconds: number;
}

/** Intervalo hasta conocer el del servidor. El valor real viene de la configuración del backend. */
const DEFAULT_HEARTBEAT_MS = 10_000;

/**
 * Latido de presencia en el chat.
 *
 * Mientras el usuario tiene la conversación abierta y visible, el backend no le
 * manda push por los mensajes de ese requerimiento: ya los está viendo. Para
 * eso este servicio repite PUT /presence cada `heartbeatSeconds` (lo dicta el
 * servidor) y hace DELETE al salir o al pasar la app/pestaña a segundo plano,
 * para que las push vuelvan de inmediato.
 *
 * Si el latido deja de llegar (app matada, sin red) la presencia vence sola en
 * el backend, así que un DELETE perdido solo retrasa las push unos segundos.
 */
@Injectable({ providedIn: 'root' })
export class ChatPresenceService {
  private readonly auth = inject(AuthService);

  private ticketId: string | null = null;
  /** Una sesión por pantalla abierta: dos pestañas o dispositivos no se pisan. */
  private sessionId = '';
  private heartbeatMs = DEFAULT_HEARTBEAT_MS;
  private timer: ReturnType<typeof setTimeout> | null = null;

  private readonly onVisibilityChange = () => {
    if (!this.ticketId) return;
    if (document.visibilityState === 'visible') {
      void this.beat();
    } else {
      this.clearTimer();
      this.leave();
    }
  };

  /** pagehide cubre el cierre de la pestaña, donde ngOnDestroy no corre. */
  private readonly onPageHide = () => this.leave();

  start(ticketId: string): void {
    this.stop();
    this.ticketId = ticketId;
    this.sessionId = crypto.randomUUID();
    document.addEventListener('visibilitychange', this.onVisibilityChange);
    window.addEventListener('pagehide', this.onPageHide);
    if (document.visibilityState === 'visible') void this.beat();
  }

  stop(): void {
    if (!this.ticketId) return;
    document.removeEventListener('visibilitychange', this.onVisibilityChange);
    window.removeEventListener('pagehide', this.onPageHide);
    this.clearTimer();
    this.leave();
    this.ticketId = null;
  }

  private async beat(): Promise<void> {
    this.clearTimer();
    const ticketId = this.ticketId;
    if (!ticketId) return;
    try {
      const response = await fetch(this.url(ticketId), { method: 'PUT', headers: this.headers() });
      if (response.ok) {
        const body = (await response.json()) as PresenceResponse;
        if (body.heartbeatSeconds > 0) this.heartbeatMs = body.heartbeatSeconds * 1000;
      } else if (response.status === 404 || response.status === 400) {
        // Sin acceso al requerimiento o sesión inválida: insistir no lo arregla.
        return;
      }
    } catch {
      // Un latido perdido no es grave: el siguiente renueva antes de que venza.
    }
    // La pantalla pudo cerrarse o cambiar de requerimiento mientras el PUT viajaba.
    if (this.ticketId === ticketId && document.visibilityState === 'visible') {
      this.timer = setTimeout(() => void this.beat(), this.heartbeatMs);
    }
  }

  /** keepalive deja terminar el DELETE aunque la página se esté descargando. */
  private leave(): void {
    if (!this.ticketId) return;
    fetch(this.url(this.ticketId), { method: 'DELETE', headers: this.headers(), keepalive: true }).catch(
      () => undefined,
    );
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private url(ticketId: string): string {
    return `${environment.apiBaseUrl}/chat/tickets/${ticketId}/presence/${this.sessionId}`;
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = {};
    const token = this.auth.accessToken();
    if (token) headers['Authorization'] = `Bearer ${token}`;
    return headers;
  }
}
