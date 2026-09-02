import { Component, OnDestroy, OnInit, inject, signal } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { DatePipe } from '@angular/common';
import { firstValueFrom } from 'rxjs';
import { HttpErrorResponse } from '@angular/common/http';
import { apiErrorMessage, AuthService } from '../auth.service';
import { AcsChatService } from './acs-chat.service';
import { ChatService, TicketDetail, TICKET_STATUS_LABEL } from './chat.service';

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
  readonly closing = signal(false);
  /**
   * La ficha arranca desplegada: es lo primero que el médico necesita al abrir la
   * conversación. Se puede plegar porque en una pantalla estrecha desplaza los
   * mensajes fuera de la vista.
   */
  readonly showPatient = signal(true);

  private ticketId = '';

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
    const nombre = [p?.firstname, p?.lastname].filter((parte) => !!parte?.trim()).join(' ').trim();
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

  async close(): Promise<void> {
    this.closing.set(true);
    this.error.set(null);

    try {
      const cerrado = await firstValueFrom(this.chat.closeTicket(this.ticketId));
      this.ticket.set(cerrado);
    } catch (error) {
      this.error.set(this.describe(error));
    } finally {
      this.closing.set(false);
    }
  }

  /** Vuelve al home que corresponde a quien está en sesión. */
  back(): void {
    void this.router.navigate([this.auth.homeRoute()]);
  }

  private describe(error: unknown): string {
    if (error instanceof HttpErrorResponse && error.status === 404) {
      return 'Este requerimiento no existe o no participas en él.';
    }
    if (error instanceof HttpErrorResponse && error.status === 0) {
      return 'No hay respuesta del backend. ¿Está corriendo en localhost:8080?';
    }
    return apiErrorMessage(error, 'No fue posible abrir la conversación.');
  }
}
