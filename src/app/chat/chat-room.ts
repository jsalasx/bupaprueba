import { Component, OnDestroy, OnInit, inject, signal } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { DatePipe } from '@angular/common';
import { firstValueFrom } from 'rxjs';
import { HttpErrorResponse } from '@angular/common/http';
import { apiErrorMessage, AuthService } from '../auth.service';
import { AcsChatService } from './acs-chat.service';
import {
  ChatService,
  CLOSURE_MAX_ORDER_TYPES,
  CLOSURE_TEXT_MAX_LENGTH,
  normalizeOrderTypes,
  TicketDetail,
  TICKET_STATUS_LABEL,
} from './chat.service';

/**
 * Conversación de un requerimiento.
 *
 * Junta las dos mitades del sistema: los METADATOS vienen del backend de Bupa
 * (GET /chat/tickets/:id) y los MENSAJES del proveedor, directamente desde el
 * navegador. Por eso hacen falta dos servicios y no uno.
 *
 * Sirve igual a paciente y médico; lo único que cambia son las acciones
 * disponibles, que se deciden con el rol que el propio backend devuelve en
 * `callerRole`. No se deduce del tipo de usuario guardado en el cliente: ese es
 * una pista de enrutado, no una autorización.
 *
 * La ficha del paciente sigue el mismo criterio: se pinta si el detalle trae
 * `patient`, y el backend solo se lo manda al equipo médico. La pantalla no
 * comprueba perfiles por su cuenta — si lo hiciera, tendría dos fuentes de verdad
 * sobre quién puede ver datos clínicos y acabarían discrepando.
 */
@Component({
  selector: 'app-chat-room',
  standalone: true,
  imports: [FormsModule, DatePipe],
  templateUrl: './chat-room.html',
  styleUrls: ['./chat-room.css'],
})
export class ChatRoom implements OnInit, OnDestroy {
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly chat = inject(ChatService);
  readonly acs = inject(AcsChatService);
  readonly auth = inject(AuthService);

  readonly statusLabel = TICKET_STATUS_LABEL;

  readonly ticket = signal<TicketDetail | null>(null);
  readonly loading = signal(true);
  readonly error = signal<string | null>(null);
  readonly draft = signal('');
  readonly uploading = signal(false);
  readonly recording = signal(false);
  readonly attachmentError = signal<string | null>(null);
  readonly closing = signal(false);
  /**
   * La ficha arranca desplegada: es lo primero que el médico necesita al abrir la
   * conversación. Se puede plegar porque en una pantalla estrecha desplaza los
   * mensajes fuera de la vista.
   */
  readonly showPatient = signal(true);

  /**
   * ── Formulario de cierre ──
   *
   * El backend EXIGE la información clínica (400 si falta), así que el botón de
   * la cabecera ya no cierra: abre este formulario. Cerrar es irreversible
   * —CLOSED es terminal—, y un clic accidental que además pedía datos no debería
   * poder consumarse de un solo toque.
   */
  readonly closeForm = signal(false);
  readonly closureType = signal('');
  readonly prescriptionIssued = signal(false);
  readonly ordersIssued = signal(false);
  readonly orderTypes = signal<string[]>([]);
  readonly referralIssued = signal(false);
  /** Lo que falla en el formulario, separado de `error` para no tapar el del chat. */
  readonly closeError = signal<string | null>(null);

  readonly maxOrderTypes = CLOSURE_MAX_ORDER_TYPES;
  readonly maxTextLength = CLOSURE_TEXT_MAX_LENGTH;

  /**
   * Tipos de consulta que se ofrecen al cerrar. El backend NO valida contra un
   * catálogo a propósito —lo define el equipo clínico y validarlo allí obligaría
   * a desplegar cada vez que añaden uno—, así que esta lista es del cliente.
   * Coincide con la que se ofrece al abrir para que los recuentos sean
   * comparables.
   */
  readonly consultationTypes = [
    'GENERAL',
    'RESULTADOS_EXAMEN',
    'MEDICAMENTOS',
    'DERIVACION',
    'OTRO',
  ];

  /** Tipos de órdenes ofrecidos. Misma razón que arriba: catálogo del cliente. */
  readonly orderTypeOptions = [
    'LABORATORIO',
    'IMAGENOLOGIA',
    'PROCEDIMIENTO',
    'INTERCONSULTA',
    'OTRO',
  ];

  private ticketId = '';
  private mediaRecorder: MediaRecorder | null = null;
  private recordingStream: MediaStream | null = null;
  private recordingChunks: Blob[] = [];

  async ngOnInit(): Promise<void> {
    this.ticketId = this.route.snapshot.paramMap.get('ticketId') ?? '';
    if (!this.ticketId) {
      await this.router.navigate(['/home']);
      return;
    }

    try {
      const detalle = await firstValueFrom(this.chat.getTicket(this.ticketId));
      this.ticket.set(detalle);

      // El hilo solo llega a quien participa. Sin él no hay conversación que abrir,
      // y es un caso legítimo: un requerimiento que todavía no se ha tomado.
      if (detalle.threadId) {
        await this.acs.connect(detalle.threadId);
      }

      // La marca de lectura se avanza al abrir, no al recibir: es el momento en que
      // el usuario realmente vio los mensajes.
      this.chat.markRead(this.ticketId).subscribe({ error: () => undefined });
    } catch (error) {
      this.error.set(this.describe(error));
    } finally {
      this.loading.set(false);
    }
  }

  /**
   * Suelta el canal de notificaciones al salir. Sin esto, cada visita dejaría una
   * suscripción viva escribiendo sobre la lista de una conversación que ya nadie mira.
   *
   * `disconnect` es asíncrono —cerrar el canal del proveedor lo es— pero no se espera:
   * ngOnDestroy no admite promesas y la pantalla ya se está destruyendo. Lo que
   * importa, retirar los listeners, ocurre antes del primer await.
   */
  ngOnDestroy(): void {
    this.stopRecordingTracks();
    void this.acs.disconnect();
  }

  /**
   * Nombre completo para la cabecera de la ficha.
   *
   * Cae al nombre para mostrar del requerimiento y luego al identificador: la ficha
   * puede venir entera vacía —un paciente que nunca completó su perfil— y una
   * cabecera en blanco haría dudar de si la pantalla se rompió.
   */
  patientFullName(): string {
    const t = this.ticket();
    const p = t?.patient;
    const nombre = [p?.firstname, p?.lastname]
      .filter((parte) => !!parte?.trim())
      .join(' ')
      .trim();
    return nombre || t?.patientName?.trim() || t?.patientId || '—';
  }

  /** Texto de un campo de la ficha; un guion deja claro que el dato no está. */
  fieldOrDash(value: string | number | null | undefined): string {
    if (value === null || value === undefined) {
      return '—';
    }
    const texto = String(value).trim();
    return texto === '' ? '—' : texto;
  }

  /** Quién escribió lo último, en palabras. */
  lastMessageLabel(side: string): string {
    if (side === 'PATIENT') {
      return 'Paciente';
    }
    if (side === 'DOCTOR') {
      return 'Equipo médico';
    }
    return '—';
  }

  /** ¿Puede escribir quien mira? Un requerimiento cerrado queda de solo lectura. */
  canWrite(): boolean {
    const t = this.ticket();
    return !!t && t.status !== 'CLOSED' && this.acs.connected();
  }

  /** Solo el médico responsable cierra, y el cierre es definitivo. */
  canClose(): boolean {
    const t = this.ticket();
    return !!t && t.status === 'IN_PROGRESS' && t.callerRole === 'ASSIGNEE';
  }

  async send(): Promise<void> {
    const texto = this.draft().trim();
    if (!texto) {
      return;
    }
    this.draft.set('');
    await this.acs.send(this.ticketId, texto);
  }

  async onFileSelected(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (file) await this.sendFile(file);
  }

  async toggleRecording(): Promise<void> {
    if (this.recording()) {
      this.mediaRecorder?.stop();
      return;
    }
    this.attachmentError.set(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const preferred = [
        'audio/webm;codecs=opus',
        'audio/webm',
        'audio/mp4',
        'audio/ogg;codecs=opus',
      ].find((type) => MediaRecorder.isTypeSupported(type));
      const recorder = preferred
        ? new MediaRecorder(stream, { mimeType: preferred })
        : new MediaRecorder(stream);
      this.recordingStream = stream;
      this.recordingChunks = [];
      this.mediaRecorder = recorder;
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) this.recordingChunks.push(event.data);
      };
      recorder.onstop = () => {
        void this.finishVoiceRecording(recorder.mimeType);
      };
      recorder.start();
      this.recording.set(true);
    } catch (error) {
      this.stopRecordingTracks();
      this.attachmentError.set(this.describe(error));
    }
  }

  private async finishVoiceRecording(mimeType: string): Promise<void> {
    this.recording.set(false);
    this.stopRecordingTracks();
    const normalizedType = mimeType.split(';')[0] || 'audio/webm';
    const extension =
      normalizedType === 'audio/mp4'
        ? 'm4a'
        : normalizedType === 'audio/ogg'
          ? 'ogg'
          : normalizedType === 'audio/mpeg'
            ? 'mp3'
            : normalizedType === 'audio/wav'
              ? 'wav'
              : 'webm';
    const blob = new Blob(this.recordingChunks, { type: normalizedType });
    this.recordingChunks = [];
    if (!blob.size) return;
    await this.sendFile(
      new File([blob], `nota-de-voz-${Date.now()}.${extension}`, { type: normalizedType }),
    );
  }

  private async sendFile(file: File): Promise<void> {
    if (!this.canWrite() || this.uploading()) return;
    this.uploading.set(true);
    this.attachmentError.set(null);
    try {
      const attachment = await this.chat.uploadAttachment(this.ticketId, file);
      await this.acs.sendAttachment(this.ticketId, attachment);
    } catch (error) {
      this.attachmentError.set(this.describe(error));
    } finally {
      this.uploading.set(false);
    }
  }

  private stopRecordingTracks(): void {
    for (const track of this.recordingStream?.getTracks() ?? []) track.stop();
    this.recordingStream = null;
    this.mediaRecorder = null;
  }

  /** Abre el formulario de cierre en blanco. */
  openCloseForm(): void {
    this.closureType.set('');
    this.prescriptionIssued.set(false);
    this.ordersIssued.set(false);
    this.orderTypes.set([]);
    this.referralIssued.set(false);
    this.closeError.set(null);
    this.closeForm.set(true);
  }

  cancelClose(): void {
    this.closeForm.set(false);
    this.closeError.set(null);
  }

  /**
   * Marca o desmarca un tipo de orden.
   *
   * Marcar uno implica que HUBO órdenes, y quedarse sin ninguno implica que no:
   * el backend rechaza las dos incoherencias por separado, así que la casilla y
   * la lista se mueven juntas en lugar de dejar al médico cuadrarlas a mano.
   */
  toggleOrderType(tipo: string): void {
    const actuales = this.orderTypes();
    const siguientes = actuales.includes(tipo)
      ? actuales.filter((t) => t !== tipo)
      : [...actuales, tipo];
    this.orderTypes.set(siguientes);
    this.ordersIssued.set(siguientes.length > 0);
  }

  hasOrderType(tipo: string): boolean {
    return this.orderTypes().includes(tipo);
  }

  /**
   * Al desmarcar "se entregaron órdenes" se VACÍA la lista.
   *
   * Conservarla oculta sería el 400 más difícil de entender de este formulario:
   * el médico ve la casilla desmarcada y el backend ve tipos sin órdenes.
   */
  setOrdersIssued(valor: boolean): void {
    this.ordersIssued.set(valor);
    if (!valor) {
      this.orderTypes.set([]);
    }
  }

  /**
   * Comprueba lo mismo que valida el backend, para decirlo antes de gastar la
   * única oportunidad: el cierre es terminal y un 400 aquí no se puede corregir
   * sobre un requerimiento ya cerrado, pero tampoco tiene por qué llegar a
   * ocurrir. Devuelve el motivo, o null si el cierre es posible.
   */
  closureProblem(): string | null {
    const tipo = this.closureType().trim();
    if (!tipo) {
      return 'El tipo de consulta es obligatorio para cerrar.';
    }
    if (tipo.length > this.maxTextLength) {
      return `El tipo de consulta supera los ${this.maxTextLength} caracteres.`;
    }

    const tipos = normalizeOrderTypes(this.orderTypes());
    if (this.ordersIssued() && tipos.length === 0) {
      return 'Indicaste órdenes: elige al menos un tipo.';
    }
    if (!this.ordersIssued() && tipos.length > 0) {
      return 'Hay tipos de órdenes elegidos pero la casilla de órdenes está desmarcada.';
    }
    if (tipos.length > this.maxOrderTypes) {
      return `No se admiten más de ${this.maxOrderTypes} tipos de órdenes.`;
    }
    return null;
  }

  async close(): Promise<void> {
    const problema = this.closureProblem();
    if (problema) {
      this.closeError.set(problema);
      return;
    }

    this.closing.set(true);
    this.closeError.set(null);
    this.error.set(null);

    try {
      const cerrado = await firstValueFrom(
        this.chat.closeTicket(this.ticketId, {
          consultationType: this.closureType().trim(),
          prescriptionIssued: this.prescriptionIssued(),
          ordersIssued: this.ordersIssued(),
          orderTypes: this.orderTypes(),
          referralIssued: this.referralIssued(),
        }),
      );
      this.ticket.set(cerrado);
      this.closeForm.set(false);
    } catch (error) {
      this.closeError.set(this.describeClosure(error));
    } finally {
      this.closing.set(false);
    }
  }

  /** Vuelve al home que corresponde a quien está en sesión. */
  back(): void {
    void this.router.navigate([this.auth.homeRoute()]);
  }

  /**
   * Traduce el fallo del cierre. Se separa de `describe` porque aquí 403 y 409
   * significan algo concreto —dejaste de ser el responsable, o alguien ya lo
   * cerró— y el mensaje genérico de la conversación no lo diría.
   */
  private describeClosure(error: unknown): string {
    if (error instanceof HttpErrorResponse) {
      if (error.status === 403) {
        return 'Solo el médico responsable puede cerrar este requerimiento.';
      }
      if (error.status === 409) {
        return 'Este requerimiento ya estaba cerrado.';
      }
    }
    return apiErrorMessage(error, 'No fue posible cerrar el requerimiento.');
  }

  private describe(error: unknown): string {
    if (error instanceof HttpErrorResponse && error.status === 404) {
      return 'Este requerimiento no existe o no participas en él.';
    }
    if (error instanceof HttpErrorResponse && error.status === 0) {
      return 'No hay respuesta del backend publicado mediante ngrok.';
    }
    return apiErrorMessage(error, 'No fue posible abrir la conversación.');
  }
}
