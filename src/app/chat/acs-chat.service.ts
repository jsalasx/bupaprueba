import { Injectable, inject, signal } from '@angular/core';
import { ChatClient, ChatThreadClient } from '@azure/communication-chat';
import { AzureCommunicationTokenCredential } from '@azure/communication-common';
import { firstValueFrom, Subscription } from 'rxjs';
import { AcsSessionService } from './acs-session.service';
import { ChatAttachmentLimits, ChatAttachmentMetadata, ChatService, messageAttachments } from './chat.service';
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
  attachments: ChatAttachmentView[];
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

  private readonly session = inject(AcsSessionService);
  private roomEvents?: Subscription;
  private thread: ChatThreadClient | null = null;

  /** Solo se arma cuando el tiempo real falla. Ver FALLBACK_POLL_MS. */
  private fallbackTimer: ReturnType<typeof setInterval> | null = null;

  /**
   * Mensajes por id. ACS entrega el envío propio también por notificación, así que
   * sin esta indexación el mensaje recién enviado aparecería dos veces.
   */
  private readonly byId = new Map<string, ChatMessage>();

  /** Identidad del usuario en el proveedor; distingue los mensajes propios. */
  private identity = '';
  private profileDisplayName = '';
  private threadId = '';

  readonly messages = signal<ChatMessage[]>([]);
  readonly connected = signal(false);
  readonly error = signal<string | null>(null);
  readonly sending = signal(false);
  readonly attachmentLimits = signal<ChatAttachmentLimits | undefined>(undefined);
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
      this.profileDisplayName = credential.displayName?.trim() ?? '';
      this.attachmentLimits.set(credential.attachmentLimits);

      // El endpoint viaja con la credencial: los dos describen el mismo recurso, y
      // configurarlo aparte permitiría que apuntaran a recursos distintos.
      const client = new ChatClient(
        credential.endpoint,
        new AzureCommunicationTokenCredential(credential.token),
      );
      this.thread = client.getChatThreadClient(threadId);
      this.threadId = threadId;

      // Suscribirse primero cubre mensajes que llegan durante la carga inicial.
      this.watchSession(threadId);
      await this.loadHistory();
      if (this.threadId === threadId) this.connected.set(true);
    } catch (error) {
      console.error('[ACS] No se pudo abrir la conversación:', error);
      this.error.set(this.describe(error));
      await this.disconnect();
    }
  }

  private watchSession(threadId: string): void {
    this.roomEvents = new Subscription();
    this.roomEvents.add(this.session.messages$.subscribe((event) => {
      if (event.threadId !== threadId || this.byId.has(event.id)) return;
      const senderId = (event.sender as { communicationUserId?: string })?.communicationUserId ?? '';
      const message: ChatMessage = {
        id: event.id,
        content: event.message ?? '',
        senderId,
        senderName: event.senderDisplayName || 'Participante',
        createdOn: event.createdOn ? new Date(event.createdOn) : new Date(),
        mine: senderId === this.identity,
        attachments: messageAttachments(event.metadata).map((file) => ({ ...file, loading: true })),
      };
      this.byId.set(event.id, message);
      this.publish();
      for (const file of message.attachments) void this.loadAttachment(message, file);
    }));

    this.roomEvents.add(this.session.connected$.subscribe((connected) => {
      this.live.set(connected);
      if (!connected) {
        this.startFallbackPolling();
      } else if (this.fallbackTimer) {
        clearInterval(this.fallbackTimer);
        this.fallbackTimer = null;
        void this.loadHistory().catch(() => undefined);
      }
    }));
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

    this.roomEvents?.unsubscribe();
    this.roomEvents = undefined;
    this.thread = null;
    this.threadId = '';
    this.profileDisplayName = '';
    this.byId.clear();
    for (const message of this.messages()) {
      for (const file of message.attachments) {
        if (file.url) URL.revokeObjectURL(file.url);
      }
    }
    this.messages.set([]);
    this.attachmentLimits.set(undefined);
    this.connected.set(false);
    this.live.set(false);
  }

  /**
   * Envía un mensaje y avisa al backend de la actividad.
   *
   * El mensaje propio aparece cuando ACS devuelve su ID. La notificación en tiempo
   * real y el historial se deduplican con ese mismo ID.
   *
   * El aviso al backend va DESPUÉS del envío y su fallo no se propaga: el mensaje ya
   * está en la conversación, y decirle al usuario que falló solo le haría reenviarlo.
   * Lo que se pierde es que el requerimiento suba en los listados, no el mensaje.
   */
  async send(ticketId: string, content: string): Promise<boolean> {
    const texto = content.trim();
    const thread = this.thread;
    if (!texto || !thread) return false;

    this.sending.set(true);
    try {
      const { id } = await thread.sendMessage(
        { content: texto },
        { senderDisplayName: this.senderDisplayName() },
      );
      if (this.thread === thread) this.recordSent(id, texto);

      this.chat.reportActivity(ticketId).subscribe({
        error: (err) => console.warn('[ACS] no se pudo reportar la actividad:', err),
      });
      return true;
    } catch (error) {
      console.error('[ACS] No se pudo enviar el mensaje:', error);
      this.error.set(this.describe(error));
      return false;
    } finally {
      this.sending.set(false);
    }
  }

  /** Publica en ACS una referencia segura al adjunto ya almacenado en Blob Storage. */
  async sendAttachments(ticketId: string, files: ChatAttachmentMetadata[], caption = ''): Promise<void> {
    const thread = this.thread;
    if (!thread) throw new Error('La conversación está desconectada.');
    const first = files[0];
    const metadata: Record<string, string> = files.length === 1 ? {
      attachmentId: first.id,
      attachmentName: first.filename,
      attachmentType: first.contentType,
      attachmentSize: String(first.sizeBytes),
    } : { attachments: JSON.stringify(files.map(({ id, filename, contentType, sizeBytes }) =>
      ({ id, filename, contentType, sizeBytes }))) };

    this.sending.set(true);
    try {
      const content = caption.trim() || (files.length === 1 ? `Adjunto: ${first.filename}` : 'Archivos adjuntos');
      const { id } = await thread.sendMessage({ content }, { senderDisplayName: this.senderDisplayName(), metadata });
      if (this.thread === thread) this.recordSent(id, content, files);
      this.chat.reportActivity(ticketId).subscribe({ error: () => undefined });
    } catch (error) {
      this.error.set(this.describe(error));
      throw error;
    } finally {
      this.sending.set(false);
    }
  }

  private recordSent(id: string, content: string, files: ChatAttachmentMetadata[] = []): void {
    if (this.byId.has(id)) return;
    const message: ChatMessage = {
      id, content, senderId: this.identity, senderName: this.senderDisplayName(),
      createdOn: new Date(), mine: true, attachments: files.map((file) => ({ ...file, loading: true })),
    };
    this.byId.set(id, message);
    this.publish();
    for (const file of message.attachments) void this.loadAttachment(message, file);
  }

  /**
   * Lee el hilo completo. Se llama al abrir la conversación y, si no hay tiempo
   * real, en cada ciclo del sondeo de respaldo.
   */
  private async loadHistory(): Promise<void> {
    if (!this.thread) {
      return;
    }

    const thread = this.thread;
    const threadId = this.threadId;
    const received: string[] = [];
    for await (const raw of thread.listMessages()) {
      if (this.thread !== thread) return;
      // ACS emite también eventos del hilo (altas y bajas de participantes, cambios
      // de tema). Solo interesa el texto: pintar los demás llenaría la conversación
      // de ruido que el usuario no escribió.
      if (raw.type !== 'text') {
        continue;
      }
      const existing = this.byId.get(raw.id);
      if (existing) {
        existing.content = raw.content?.message ?? '';
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
        attachments: messageAttachments(raw.metadata).map((file) => ({ ...file, loading: true })),
      };
      this.byId.set(raw.id, message);
      if (senderId && !message.mine) received.push(raw.id);
      for (const file of message.attachments) void this.loadAttachment(message, file);
    }

    this.publish();
    for (let offset = 0; offset < received.length; offset += 100) {
      this.session.confirmReceived(threadId, received.slice(offset, offset + 100));
    }
  }

  /** Deja la lista ordenada por hora, que es como la espera la plantilla. */
  private publish(): void {
    this.messages.set(
      [...this.byId.values()].sort((a, b) => a.createdOn.getTime() - b.createdOn.getTime()),
    );
  }

  private async loadAttachment(message: ChatMessage, file: ChatAttachmentView): Promise<void> {
    try {
      const blob = await firstValueFrom(this.chat.downloadAttachment(file.id));
      if (this.byId.get(message.id) !== message) return;
      file.url = URL.createObjectURL(blob);
    } catch {
      if (this.byId.get(message.id) !== message) return;
      file.error = 'No se pudo abrir el archivo';
    }
    file.loading = false;
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
      this.profileDisplayName ||
      this.auth.currentUser()?.name?.trim() ||
      this.auth.userEmail()?.trim() ||
      (this.auth.userType() === 'MEDICO' ? 'Equipo médico' : 'Paciente')
    );
  }
}
