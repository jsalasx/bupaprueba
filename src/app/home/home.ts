import { Component, OnInit, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { DatePipe } from '@angular/common';
import { firstValueFrom } from 'rxjs';
import { HttpErrorResponse } from '@angular/common/http';
import { apiErrorMessage, AuthService } from '../auth.service';
import { ChatService, Ticket, TICKET_STATUS_LABEL } from '../chat/chat.service';

/**
 * Home del paciente: abre requerimientos y entra a conversar en los que ya tiene.
 *
 * Solo muestra los suyos — el backend lo garantiza en GET /chat/tickets y en
 * /chat/tickets/active, que se bifurcan por perfil. Esta pantalla no filtra nada por
 * su cuenta: hacerlo aquí daría la falsa impresión de que la restricción es del
 * cliente.
 *
 * Tiene DOS listas y no una, porque responden a preguntas distintas:
 *
 *   - "En curso": lo que está vivo —abierto en la cola o ya con un médico atendiendo—.
 *     Es lo que el paciente viene a mirar, y sale de un endpoint que devuelve los dos
 *     estados en una sola página ordenada.
 *   - "Historial": todo, cerrados incluidos. Es consulta, no acción.
 */
@Component({
  selector: 'app-home',
  templateUrl: './home.html',
  styleUrls: ['./home.css'],
  standalone: true,
  imports: [FormsModule, DatePipe],
})
export class Home implements OnInit {
  private readonly chat = inject(ChatService);
  private readonly router = inject(Router);

  readonly statusLabel = TICKET_STATUS_LABEL;

  /** Requerimientos vigentes: abiertos y en atención (GET /chat/tickets/active). */
  readonly activeTickets = signal<Ticket[]>([]);
  readonly loadingActive = signal(false);
  readonly activeError = signal<string | null>(null);

  /** Historial completo, cerrados incluidos (GET /chat/tickets). */
  readonly tickets = signal<Ticket[]>([]);
  readonly loadingTickets = signal(false);
  readonly ticketsError = signal<string | null>(null);
  readonly showHistory = signal(false);

  readonly subject = signal('');
  readonly consultationType = signal('');
  readonly creating = signal(false);
  readonly createError = signal<string | null>(null);
  /**
   * Aviso de que la consulta se sumó a una que ya estaba abierta, en vez de crear
   * otra. No es un error y por eso no va en `createError`: el usuario tiene que
   * entender por qué no ve una consulta nueva en la lista.
   */
  readonly reusedNotice = signal<string | null>(null);

  /** Tipos de consulta ofrecidos. El backend no impone catálogo: esto es del cliente. */
  readonly consultationTypes = [
    'GENERAL',
    'RESULTADOS_EXAMEN',
    'MEDICAMENTOS',
    'DERIVACION',
    'OTRO',
  ];

  readonly loading = signal(false);
  readonly error = signal<string | null>(null);

  constructor(public auth: AuthService) {}

  ngOnInit(): void {
    void this.loadActive();
  }

  /**
   * Trae lo que el paciente tiene en curso: abiertos y en atención, en una sola
   * página ya ordenada por última actividad.
   */
  async loadActive(): Promise<void> {
    this.loadingActive.set(true);
    this.activeError.set(null);

    try {
      const page = await firstValueFrom(this.chat.listActiveTickets());
      this.activeTickets.set(page.items ?? []);
    } catch (error) {
      this.activeError.set(this.describeChat(error));
    } finally {
      this.loadingActive.set(false);
    }
  }

  /** Trae el historial completo del paciente, cerrados incluidos. */
  async loadTickets(): Promise<void> {
    this.loadingTickets.set(true);
    this.ticketsError.set(null);

    try {
      const page = await firstValueFrom(this.chat.listMyTickets());
      this.tickets.set(page.items ?? []);
    } catch (error) {
      this.ticketsError.set(this.describeChat(error));
    } finally {
      this.loadingTickets.set(false);
    }
  }

  /** Despliega el historial y lo carga la primera vez que se abre. */
  async toggleHistory(): Promise<void> {
    const abierto = !this.showHistory();
    this.showHistory.set(abierto);
    if (abierto && this.tickets().length === 0) {
      await this.loadTickets();
    }
  }

  /**
   * Quién atiende la consulta, como se lo dice el paciente.
   *
   * Prefiere el nombre y solo cae al identificador si el backend no lo trae —un
   * requerimiento tomado antes de que el nombre se guardara—. Mostrar el correo de un
   * médico a un paciente no está bien, pero dejar la fila en blanco cuando SÍ hay
   * alguien atendiendo es peor: parecería que nadie la ha visto.
   */
  attendedBy(t: Ticket): string {
    return t.assigneeName?.trim() || t.assigneeId || '';
  }

  /**
   * Texto de la fila: qué está pasando con esta consulta.
   *
   * Se apoya en `awaitingReply`, que calcula el backend con el autor del último
   * mensaje. Deducirlo aquí no sería posible: el cliente no ve quién escribió lo
   * último sin abrir la conversación en el proveedor.
   */
  activityHint(t: Ticket): string {
    if (t.status === 'OPEN') {
      return 'Esperando que un médico la tome';
    }
    if (t.awaitingReply) {
      return 'Esperando respuesta del médico';
    }
    if (t.lastMessageBy === 'DOCTOR') {
      return 'El médico respondió';
    }
    return 'En atención';
  }

  /**
   * Abre un requerimiento y entra directo a su conversación.
   *
   * Navegar al chat en vez de volver a la lista es lo que corresponde: quien acaba
   * de escribir un asunto quiere seguir contando, no ver una fila más.
   */
  async createTicket(): Promise<void> {
    const asunto = this.subject().trim();
    if (!asunto) {
      this.createError.set('Escribe de qué se trata tu consulta.');
      return;
    }

    this.creating.set(true);
    this.createError.set(null);
    this.reusedNotice.set(null);

    try {
      const creado = await firstValueFrom(this.chat.createTicket(asunto, this.consultationType()));
      this.subject.set('');

      // El backend agrupa las aperturas seguidas del mismo paciente en el
      // requerimiento que ya tenía: se entra a ESE hilo, que es el que devuelve la
      // respuesta. Se avisa antes de navegar para que el aviso siga en pie al volver.
      if (creado.reused) {
        this.reusedNotice.set(
          `Tu mensaje se sumó a la consulta que ya tenías abierta ("${creado.subject}"), ` +
            'para que el médico lo vea todo junto.',
        );
      }

      await this.router.navigate(['/chat', creado.id]);
    } catch (error) {
      this.createError.set(this.describeChat(error));
    } finally {
      this.creating.set(false);
    }
  }

  openChat(ticket: Ticket): void {
    void this.router.navigate(['/chat', ticket.id]);
  }

  async logout(): Promise<void> {
    this.loading.set(true);
    this.error.set(null);

    try {
      await firstValueFrom(this.auth.logout());
      this.auth.clearSession();
      this.chat.clearToken();
      await this.router.navigate(['/login']);
    } catch (error) {
      console.error('[logout] Error al cerrar sesión:', error);
      this.error.set(this.describe(error));
    } finally {
      this.loading.set(false);
    }
  }

  /** Cierra la sesión solo en el cliente, sin pasar por el backend. */
  forceLocalLogout(): void {
    this.auth.clearSession();
    this.chat.clearToken();
    this.router.navigate(['/login']);
  }

  /**
   * Un 403 aquí casi siempre significa lo mismo: la cuenta no quedó marcada como
   * paciente. Decirlo explícitamente ahorra la búsqueda a ciegas, porque el mensaje
   * genérico del backend es deliberadamente opaco sobre los perfiles.
   */
  private describeChat(error: unknown): string {
    if (error instanceof HttpErrorResponse && error.status === 403) {
      return (
        'Tu cuenta no está habilitada para el chat. Debe tener user_type = "PACIENTE" ' +
        'en la colección users; se asigna sola al entrar por OTP, Google o Apple.'
      );
    }
    if (error instanceof HttpErrorResponse && error.status === 0) {
      return 'No hay respuesta del backend. ¿Está corriendo en localhost:8080?';
    }
    return apiErrorMessage(error, 'No fue posible completar la operación.');
  }

  private describe(error: unknown): string {
    if (error instanceof HttpErrorResponse && error.status === 0) {
      return (
        'Status 0: la respuesta no llegó al navegador. Suele ser CORS ' +
        '(preflight OPTIONS rechazado o falta Access-Control-Allow-Origin ' +
        'para http://localhost:4200). Revisa la pestaña Network.'
      );
    }

    const detalle = apiErrorMessage(error, 'No fue posible cerrar la sesión.');
    return error instanceof HttpErrorResponse
      ? `HTTP ${error.status}: ${detalle}`
      : detalle;
  }
}
