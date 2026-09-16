import { Injectable, inject, signal } from '@angular/core';
import { ChatClient, ChatThreadClient, ChatMessageReceivedEvent } from '@azure/communication-chat';
import { AzureCommunicationTokenCredential } from '@azure/communication-common';
import { firstValueFrom } from 'rxjs';
import { ChatAttachmentMetadata, ChatService } from './chat.service';
import { AuthService } from '../auth.service';

export interface ChatAttachmentView extends ChatAttachmentMetadata {
  url?: string;
  loading: boolean;
  error?: string;
}

/** Mensaje ya normalizado para pintar. */
export interface ChatMessage {
  id: string;
  content: string;
  senderId: string;
  senderName: string;
  createdOn: Date;
  /** True si lo envió quien está mirando la pantalla. */
  mine: boolean;
  attachment?: ChatAttachmentView;
}

/**
 * Cada cuánto relee el hilo el sondeo de RESPALDO. Solo se usa si la señalización
 * en tiempo real no llegó a arrancar; en el camino normal no hay ningún temporizador.
 */
const FALLBACK_POLL_MS = 10_000;

/**
 * Conversación en vivo contra Azure Communication Services.
 *
 * El contenido de los mensajes NO pasa por el backend de Bupa: el navegador habla
 * directamente con el proveedor usando la credencial que emite POST /chat/token.
 * El backend solo sabe QUE hubo actividad, porque el cliente se lo dice
 * (ChatService.reportActivity).
 *
 * La recepción es por NOTIFICACIONES en tiempo real (`startRealtimeNotifications`),
 * no por sondeo. La versión anterior releía el hilo entero cada 3 segundos, y eso
 * tenía dos problemas que no se ven en una conversación de tres mensajes:
 *
 *   - El coste crecía con la conversación: `listMessages()` recorre el hilo COMPLETO,
 *     así que un caso largo se repaginaba entero veinte veces por minuto.
 *   - Aun así los mensajes llegaban tarde, hasta 3 segundos, que en un chat se nota.
 *
 * Queda un sondeo de respaldo, pero solo se enciende si la señalización no arranca:
 * ahí la alternativa sería una pantalla muda, que es peor que una lenta.
 */
@Injectable({ providedIn: 'root' })
export class AcsChatService {
  private readonly chat = inject(ChatService);
  private readonly auth = inject(AuthService);

  private client: ChatClient | null = null;
  private thread: ChatThreadClient | null = null;

  /** Listeners registrados, para poder retirarlos exactamente igual al desconectar. */
  private onMessage: ((event: ChatMessageReceivedEvent) => void) | null = null;
  private onConnected: (() => void) | null = null;
  private onDisconnected: (() => void) | null = null;

  /** Solo se arma cuando el tiempo real falla. Ver FALLBACK_POLL_MS. */
  private fallbackTimer: ReturnType<typeof setInterval> | null = null;

  /**
   * Mensajes por id. ACS entrega el envío propio también por notificación, así que
   * sin esta indexación el mensaje recién enviado aparecería dos veces.
   */
  private readonly byId = new Map<string, ChatMessage>();

  /** Identidad del usuario en el proveedor; distingue los mensajes propios. */
  private identity = '';

  readonly messages = signal<ChatMessage[]>([]);
  readonly connected = signal(false);
  readonly error = signal<string | null>(null);
  readonly sending = signal(false);
  /**
   * Si la conversación recibe por notificaciones. En false con `connected` en true
   * significa que se cayó al sondeo de respaldo: la pantalla lo dice, porque un
   * retraso de diez segundos sin explicación parece que el chat está roto.
   */
  readonly live = signal(false);

  /**
   * Abre la conversación de un requerimiento.
   *
   * Es idempotente respecto de la conversación anterior: siempre desconecta antes,
   * porque navegar de un requerimiento a otro sin hacerlo dejaría los listeners del
   * hilo anterior escribiendo sobre la misma lista de mensajes.
   */
  async connect(threadId: string): Promise<void> {
    await this.disconnect();
    this.error.set(null);

    try {
      const credential = await this.chat.chatToken();
      this.identity = credential.identity;

      // El endpoint viaja con la credencial: los dos describen el mismo recurso, y
      // configurarlo aparte permitiría que apuntaran a recursos distintos.
      this.client = new ChatClient(
        credential.endpoint,
        new AzureCommunicationTokenCredential(credential.token),
      );
      this.thread = this.client.getChatThreadClient(threadId);

      // El historial se lee UNA vez. A partir de aquí, lo nuevo llega solo.
      await this.loadHistory();
      this.connected.set(true);

      await this.startRealtime(this.client);
    } catch (error) {
      console.error('[ACS] No se pudo abrir la conversación:', error);
      this.error.set(this.describe(error));
      this.connected.set(false);
      this.live.set(false);
    }
  }

  /**
   * Suscribe la pantalla a los mensajes del hilo.
   *
   * Si la señalización no arranca —red que bloquea el WebSocket del proveedor, por
   * ejemplo— NO se propaga el error: la conversación ya está cargada y es mejor
   * seguir con el sondeo de respaldo que dejar al usuario sin poder escribir.
   */
  private async startRealtime(client: ChatClient): Promise<void> {
    try {
      // Hay que arrancar las notificaciones ANTES de suscribirse a ningún evento.
      await client.startRealtimeNotifications();

      this.onMessage = (event: ChatMessageReceivedEvent) => {
        const senderId =
          (event.sender as { communicationUserId?: string })?.communicationUserId ?? '';
        const message: ChatMessage = {
          id: event.id,
          content: event.message ?? '',
          senderId,
          senderName: event.senderDisplayName || 'Participante',
          createdOn: event.createdOn ? new Date(event.createdOn) : new Date(),
          mine: senderId === this.identity,
          attachment: this.attachmentFrom(event.metadata),
        };
        this.byId.set(event.id, message);
        this.publish();
        void this.loadAttachment(event.id, message.attachment);
      };

      this.onConnected = () => {
        this.live.set(true);
        this.error.set(null);
      };

      this.onDisconnected = () => {
        // El SDK reintenta por su cuenta. Se avisa en la pantalla para que un corte
        // no se lea como "nadie me ha respondido".
        this.live.set(false);
      };

      client.on('chatMessageReceived', this.onMessage);
      client.on('realTimeNotificationConnected', this.onConnected);
      client.on('realTimeNotificationDisconnected', this.onDisconnected);

      this.live.set(true);
    } catch (error) {
      console.warn('[ACS] Sin notificaciones en tiempo real; se usa el sondeo de respaldo:', error);
      this.live.set(false);
      this.startFallbackPolling();
    }
  }

  /** Sondeo de respaldo. Solo se llama cuando el tiempo real no está disponible. */
  private startFallbackPolling(): void {
    if (this.fallbackTimer) {
      return;
    }
    this.fallbackTimer = setInterval(() => {
      // Los fallos de una lectura no se propagan: se recupera en la siguiente, y
      // cortar la conversación por ella sería peor.
      void this.loadHistory().catch(() => undefined);
    }, FALLBACK_POLL_MS);
  }

  /** Suelta listeners, canal y cliente. Debe llamarse al salir de la pantalla. */
  async disconnect(): Promise<void> {
    if (this.fallbackTimer) {
      clearInterval(this.fallbackTimer);
      this.fallbackTimer = null;
    }

    const client = this.client;
    if (client) {
      // `off` del SDK no declara en su tipado los eventos de conexión del canal, aunque
      // `on` sí los acepta y en tiempo de ejecución funcionan: es un hueco de sus tipos.
      // El puente se limita a esta llamada — castear el cliente entero perdería el
      // tipado del resto de la API.
      const emitter = client as unknown as {
        off(event: string, listener: (...args: never[]) => void): void;
      };

      // Se retiran los listeners ANTES de parar el canal: al revés, un evento en
      // vuelo podría escribir sobre la lista de una conversación ya abandonada.
      if (this.onMessage) {
        client.off('chatMessageReceived', this.onMessage);
      }
      if (this.onConnected) {
        emitter.off('realTimeNotificationConnected', this.onConnected as never);
      }
      if (this.onDisconnected) {
        emitter.off('realTimeNotificationDisconnected', this.onDisconnected as never);
      }
      try {
        await client.stopRealtimeNotifications();
      } catch {
        // Cerrar un canal ya caído falla y no cambia nada: se ignora a propósito.
      }
    }

    this.onMessage = null;
    this.onConnected = null;
    this.onDisconnected = null;
    this.client = null;
    this.thread = null;
    this.byId.clear();
    for (const message of this.messages()) {
      if (message.attachment?.url) URL.revokeObjectURL(message.attachment.url);
    }
    this.messages.set([]);
    this.connected.set(false);
    this.live.set(false);
  }

  /**
   * Envía un mensaje y avisa al backend de la actividad.
   *
   * No relee el hilo después de enviar: el propio mensaje vuelve por la notificación,
   * igual que los ajenos. Releer aquí era lo que hacía la versión con sondeo, y
   * significaba pagar el historial completo en cada envío.
   *
   * El aviso al backend va DESPUÉS del envío y su fallo no se propaga: el mensaje ya
   * está en la conversación, y decirle al usuario que falló solo le haría reenviarlo.
   * Lo que se pierde es que el requerimiento suba en los listados, no el mensaje.
   */
  async send(ticketId: string, content: string): Promise<void> {
    const texto = content.trim();
    if (!texto || !this.thread) {
      return;
    }

    this.sending.set(true);
    try {
      await this.thread.sendMessage(
        { content: texto },
        { senderDisplayName: this.senderDisplayName() },
      );

      // Sin notificaciones nadie va a traer el propio mensaje: se relee una vez.
      if (!this.live()) {
        await this.loadHistory();
      }

      this.chat.reportActivity(ticketId).subscribe({
        error: (err) => console.warn('[ACS] no se pudo reportar la actividad:', err),
      });
    } catch (error) {
      console.error('[ACS] No se pudo enviar el mensaje:', error);
      this.error.set(this.describe(error));
    } finally {
      this.sending.set(false);
    }
  }

  /** Publica en ACS una referencia segura al adjunto ya almacenado en Blob Storage. */
  async sendAttachment(ticketId: string, attachment: ChatAttachmentMetadata): Promise<void> {
    if (!this.thread) return;

    this.sending.set(true);
    try {
      await this.thread.sendMessage(
        { content: `Adjunto: ${attachment.filename}` },
        {
          senderDisplayName: this.senderDisplayName(),
          metadata: {
            attachmentId: attachment.id,
            attachmentName: attachment.filename,
            attachmentType: attachment.contentType,
            attachmentSize: String(attachment.sizeBytes),
          },
        },
      );
      if (!this.live()) await this.loadHistory();
      this.chat.reportActivity(ticketId).subscribe({ error: () => undefined });
    } catch (error) {
      this.error.set(this.describe(error));
      throw error;
    } finally {
      this.sending.set(false);
    }
  }

  /**
   * Lee el hilo completo. Se llama al abrir la conversación y, si no hay tiempo
   * real, en cada ciclo del sondeo de respaldo.
   */
  private async loadHistory(): Promise<void> {
    if (!this.thread) {
      return;
    }

    for await (const raw of this.thread.listMessages()) {
      // ACS emite también eventos del hilo (altas y bajas de participantes, cambios
      // de tema). Solo interesa el texto: pintar los demás llenaría la conversación
      // de ruido que el usuario no escribió.
      if (raw.type !== 'text') {
        continue;
      }
      const senderId = (raw.sender as { communicationUserId?: string })?.communicationUserId ?? '';
      const message: ChatMessage = {
        id: raw.id,
        content: raw.content?.message ?? '',
        senderId,
        senderName: raw.senderDisplayName || 'Participante',
        createdOn: raw.createdOn ? new Date(raw.createdOn) : new Date(),
        mine: senderId === this.identity,
        attachment: this.attachmentFrom(raw.metadata),
      };
      this.byId.set(raw.id, message);
      void this.loadAttachment(raw.id, message.attachment);
    }

    this.publish();
  }

  /** Deja la lista ordenada por hora, que es como la espera la plantilla. */
  private publish(): void {
    this.messages.set(
      [...this.byId.values()].sort((a, b) => a.createdOn.getTime() - b.createdOn.getTime()),
    );
  }

  private attachmentFrom(metadata?: Record<string, string>): ChatAttachmentView | undefined {
    const id = metadata?.['attachmentId'];
    const filename = metadata?.['attachmentName'];
    const contentType = metadata?.['attachmentType'];
    if (!id || !filename || !contentType) return undefined;
    return {
      id,
      filename,
      contentType,
      sizeBytes: Number(metadata?.['attachmentSize'] ?? 0),
      loading: true,
    };
  }

  private async loadAttachment(messageId: string, attachment?: ChatAttachmentView): Promise<void> {
    if (!attachment || attachment.url || attachment.error) return;
    try {
      const blob = await firstValueFrom(this.chat.downloadAttachment(attachment.id));
      const current = this.byId.get(messageId);
      if (!current?.attachment || current.attachment.id !== attachment.id) return;
      current.attachment = {
        ...current.attachment,
        url: URL.createObjectURL(blob),
        loading: false,
      };
      this.byId.set(messageId, { ...current });
    } catch {
      const current = this.byId.get(messageId);
      if (!current?.attachment) return;
      current.attachment = {
        ...current.attachment,
        loading: false,
        error: 'No se pudo abrir el archivo',
      };
      this.byId.set(messageId, { ...current });
    }
    this.publish();
  }

  private describe(error: unknown): string {
    if (error instanceof Error && error.message) {
      return error.message;
    }
    return 'No fue posible conectar con el servicio de conversación.';
  }

  private senderDisplayName(): string {
    return (
      this.auth.currentUser()?.name?.trim() ||
      this.auth.userEmail()?.trim() ||
      (this.auth.userType() === 'MEDICO' ? 'Equipo médico' : 'Paciente')
    );
  }
}
