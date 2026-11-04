import { Component, DestroyRef, OnInit, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { DatePipe } from '@angular/common';
import { debounceTime, firstValueFrom } from 'rxjs';
import { HttpErrorResponse } from '@angular/common/http';
import { apiErrorMessage, AuthService } from '../auth.service';
import { NotificationService } from '../notifications/notification.service';
import { ChatRoom } from '../chat/chat-room';
import { QueueStreamService } from './queue-stream.service';
import {
  ChatConversation,
  ChatService,
  PanelItem,
  Ticket,
  TicketStatus,
  TICKET_STATUS_LABEL,
} from '../chat/chat.service';

@Component({
  selector: 'app-home-medicos',
  standalone: true,
  imports: [FormsModule, DatePipe, ChatRoom],
  templateUrl: './home-medicos.html',
  styleUrls: ['./home-medicos.css'],
})
export class HomeMedicos implements OnInit {
  private readonly chat = inject(ChatService);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly notifications = inject(NotificationService);
  readonly queueStream = inject(QueueStreamService);
  private readonly destroyRef = inject(DestroyRef);
  readonly auth = inject(AuthService);

  readonly statusLabel = TICKET_STATUS_LABEL;

  readonly tab = signal<'cola' | 'mios' | 'panel' | 'todos'>('cola');

  readonly queue = signal<Ticket[]>([]);
  readonly mine = signal<Ticket[]>([]);
  readonly selectedTicket = signal<string | null>(null);
  readonly panel = signal<PanelItem[]>([]);
  readonly conversations = signal<ChatConversation[]>([]);
  readonly conversationCursor = signal<string | undefined>(undefined);
  readonly conversationsLoading = signal(false);
  readonly conversationsError = signal<string | null>(null);

  readonly loading = signal(false);
  readonly error = signal<string | null>(null);
  /** Identificador del requerimiento que se está tomando; deshabilita solo esa fila. */
  readonly claiming = signal<string | null>(null);

  // Filtros del panel.
  readonly fStatus = signal<TicketStatus | ''>('');
  readonly fAssignee = signal('');
  readonly fFrom = signal('');
  readonly fTo = signal('');

  ngOnInit(): void {
    this.chat.inboxChanges.pipe(debounceTime(500), takeUntilDestroyed(this.destroyRef))
      .subscribe(() => {
        if (this.tab() === 'mios' || this.tab() === 'todos') void this.refresh();
      });
    const initialTab = this.route.snapshot.queryParamMap.get('tab');
    if (initialTab === 'todos' || initialTab === 'mios') this.tab.set(initialTab);
    this.notifications.queueEvents.pipe(takeUntilDestroyed(this.destroyRef)).subscribe((event) => {
      if (event === 'open') this.tab.set('cola');
      if (this.tab() === 'cola') void this.refresh();
    });
    // Stream SSE: mantiene la cola al día aunque el médico no haya habilitado push.
    // El primer `ready` no recarga porque coincide con la carga inicial de abajo.
    this.queueStream
      .events()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((event) => {
        if (event.type === 'ready' && !event.reconnected) return;
        if (this.tab() === 'cola') void this.refresh();
      });
    void this.refresh();
  }

  async switchTab(tab: 'cola' | 'mios' | 'panel' | 'todos'): Promise<void> {
    this.tab.set(tab);
    await this.refresh();
  }

  /** Recarga la vista activa. */
  async refresh(): Promise<void> {
    if (this.tab() === 'todos') {
      await this.loadConversations();
      return;
    }
    this.loading.set(true);
    this.error.set(null);

    try {
      switch (this.tab()) {
        case 'cola': {
          const page = await firstValueFrom(this.chat.listQueue());
          this.queue.set(page.items ?? []);
          break;
        }
        case 'mios': {
          const page = await firstValueFrom(this.chat.listMyTickets());
          this.mine.set(page.items ?? []);
          break;
        }
        case 'panel': {
          await this.search();
          break;
        }
      }
    } catch (error) {
      this.error.set(this.describe(error));
    } finally {
      this.loading.set(false);
    }
  }

  /**
   * Ejecuta la búsqueda del panel con los filtros actuales.
   *
   * Las fechas del formulario son `YYYY-MM-DD` y el backend exige RFC 3339 con
   * zona: se completan a inicio y fin del día en UTC. Sin ese ajuste, un rango de
   * un solo día no encontraría nada, porque el instante `00:00` no cubre lo creado
   * más tarde ese mismo día.
   */
  async search(): Promise<void> {
    this.loading.set(true);
    this.error.set(null);

    try {
      const page = await firstValueFrom(
        this.chat.searchPanel({
          status: this.fStatus(),
          assigneeIds: this.fAssignee().trim() ? [this.fAssignee().trim()] : [],
          createdFrom: this.fFrom() ? `${this.fFrom()}T00:00:00Z` : undefined,
          createdTo: this.fTo() ? `${this.fTo()}T23:59:59Z` : undefined,
        }),
      );
      this.panel.set(page.items ?? []);
    } catch (error) {
      this.error.set(this.describe(error));
    } finally {
      this.loading.set(false);
    }
  }

  async loadConversations(cursor?: string): Promise<void> {
    if (this.conversationsLoading()) return;
    this.conversationsLoading.set(true);
    this.conversationsError.set(null);
    try {
      const page = await firstValueFrom(this.chat.listConversations(cursor));
      this.conversations.update((rows) => cursor ? [...rows, ...page.items] : page.items);
      this.conversationCursor.set(page.nextCursor);
    } catch (error) {
      this.conversationsError.set(this.describe(error));
    } finally {
      this.conversationsLoading.set(false);
    }
  }

  openHistory(ticketId: string, conversation?: ChatConversation): void {
    void this.router.navigate(['/chat', ticketId, 'history'], { info: { conversation } });
  }

  clearFilters(): void {
    this.fStatus.set('');
    this.fAssignee.set('');
    this.fFrom.set('');
    this.fTo.set('');
    void this.search();
  }

  /**
   * Toma un requerimiento de la cola y entra a conversar.
   *
   * Un 409 aquí no es un fallo: significa que otro médico se adelantó, que es el
   * resultado correcto de la exclusividad. Se refresca la cola en vez de mostrar
   * un error, porque lo que el médico necesita es ver qué queda disponible.
   */
  async claim(ticketId: string): Promise<void> {
    this.claiming.set(ticketId);
    this.error.set(null);

    try {
      await firstValueFrom(this.chat.claimTicket(ticketId));
      await this.router.navigate(['/chat', ticketId]);
    } catch (error) {
      if (error instanceof HttpErrorResponse && error.status === 409) {
        this.error.set('Otro médico tomó este requerimiento primero.');
        await this.refresh();
      } else {
        this.error.set(this.describe(error));
      }
    } finally {
      this.claiming.set(null);
    }
  }

  /** Devuelve a la cola un requerimiento asignado. Cualquier médico puede. */
  async release(ticketId: string): Promise<void> {
    this.error.set(null);
    try {
      await firstValueFrom(this.chat.releaseTicket(ticketId));
      if (this.selectedTicket() === ticketId) this.selectedTicket.set(null);
      await this.refresh();
    } catch (error) {
      this.error.set(this.describe(error));
    }
  }

  openChat(ticketId: string): void {
    this.selectedTicket.set(ticketId);
  }

  async logout(): Promise<void> {
    try {
      await firstValueFrom(this.auth.logout());
    } catch {
      // Un logout que el backend no confirma no debe dejar al usuario atrapado en
      // la pantalla: la sesión local se limpia igual y se sale.
    }
    this.auth.clearSession();
    this.chat.clearToken();
    await this.router.navigate(['/login/medicos']);
  }

  private describe(error: unknown): string {
    if (error instanceof HttpErrorResponse && error.status === 403) {
      return (
        'Tu cuenta no está habilitada como médico. Debe tener user_type = "MEDICO" ' +
        'en la colección users; se asigna sola al entrar con Bupa (Microsoft).'
      );
    }
    if (error instanceof HttpErrorResponse && error.status === 0) {
      return 'No hay respuesta del backend publicado mediante ngrok.';
    }
    return apiErrorMessage(error, 'No fue posible completar la operación.');
  }
}
