import { Injectable, inject, signal } from '@angular/core';
import { HttpClient, HttpHeaders, HttpParams } from '@angular/common/http';
import { Observable } from 'rxjs';
import { environment } from '../../environments/environment';
import { AuthService } from '../auth.service';

/** Estados del requerimiento. Coinciden con los valores que persiste el backend. */
export type TicketStatus = 'OPEN' | 'IN_PROGRESS' | 'CLOSED';

/** Etiquetas en español de cada estado, para no repetirlas en cada plantilla. */
export const TICKET_STATUS_LABEL: Record<TicketStatus, string> = {
  OPEN: 'Abierto',
  IN_PROGRESS: 'Asignado',
  CLOSED: 'Cerrado',
};

/** Lado de la conversación que escribió el último mensaje. */
export type MessageSide = 'PATIENT' | 'DOCTOR';

/** Requerimiento tal como lo devuelven POST /chat/tickets y GET /chat/tickets. */
export interface Ticket {
  id: string;
  patientId: string;
  patientName?: string;
  subject: string;
  /** Tipo de consulta declarado al abrir. Opcional: el backend no impone catálogo. */
  consultationType?: string;
  status: TicketStatus;
  assigneeId?: string;
  /**
   * Nombre para mostrar del médico responsable. Es lo único presentable al paciente:
   * `assigneeId` es un correo interno. Ausente mientras nadie atiende.
   */
  assigneeName?: string;
  /** Identificador de la sala en el proveedor. Solo llega a quien participa. */
  threadId: string;
  hasUnread: boolean;
  lastReadAt?: string;
  createdAt: string;
  lastActivityAt: string;
  /** Lado que escribió lo último. Ausente si todavía no hubo actividad registrada. */
  lastMessageBy?: MessageSide;
  /** El último mensaje es del paciente y sigue sin respuesta. Nunca en un cerrado. */
  awaitingReply: boolean;
  closedAt?: string;
  closedBy?: string;
  releasedAt?: string;
  releasedBy?: string;
  callerRole?: string;
}

/**
 * Ficha del paciente que acompaña al detalle del requerimiento.
 *
 * El backend la envía SOLO al equipo médico; al paciente le llega ausente. Ningún
 * campo se omite: lo que no se sabe viaja vacío, y `age` viaja `null` —nunca 0—
 * cuando no hay fecha de nacimiento o no se puede interpretar. Por eso los campos
 * no son opcionales aquí: si el objeto existe, todas sus claves están.
 */
export interface PatientContext {
  userId: string;
  ticketId: string;
  threadId: string;
  firstname: string;
  lastname: string;
  rut: string;
  birthdate: string;
  age: number | null;
  region: string;
  consultationType: string;
  lastMessageAt: string | null;
  lastMessageBy: MessageSide | '';
  awaitingReply: boolean;
  assigneeId: string;
  assigneeName: string;
}

export interface TicketDetail extends Ticket {
  participants: {
    userId: string;
    name?: string;
    role: string;
    joinedAt: string;
    addedBy?: string;
  }[];
  /** Presente solo cuando quien consulta es del equipo médico. */
  patient?: PatientContext;
  /**
   * Solo en la respuesta de createTicket: la apertura se agrupó en el requerimiento
   * que el paciente ya tenía abierto, en vez de crear uno nuevo.
   */
  reused?: boolean;
}

export interface TicketPage {
  items: Ticket[];
  nextCursor?: string;
}

/**
 * Fila del panel médico. NO extiende Ticket a propósito: el backend omite aquí
 * `threadId` y todo lo que dependa de participar en la conversación, porque el
 * panel alcanza requerimientos de otros médicos. Tiparlo como Ticket haría creer
 * que se puede abrir el chat desde cualquier fila.
 */
export interface PanelItem {
  id: string;
  subject: string;
  consultationType?: string;
  status: TicketStatus;
  assigneeId?: string;
  assigneeName?: string;
  patientId: string;
  patientName?: string;
  createdAt: string;
  lastActivityAt: string;
  lastMessageBy?: MessageSide;
  awaitingReply: boolean;
  releasedAt?: string;
  releasedBy?: string;
}

export interface PanelPage {
  items: PanelItem[];
  nextCursor?: string;
}

export interface TicketTransition {
  fromStatus?: TicketStatus;
  toStatus: TicketStatus;
  actorId: string;
  actorName?: string;
  occurredAt: string;
}

export interface TicketHistory {
  ticketId: string;
  transitions: TicketTransition[];
}

/** Credencial con la que el navegador habla directamente con el proveedor. */
export interface ChatToken {
  token: string;
  identity: string;
  /** URL del recurso del proveedor. Viaja con la credencial, no se configura aparte. */
  endpoint: string;
  expiresOn: string;
}

/** Criterios del panel. Todos opcionales y combinables de forma restrictiva. */
export interface PanelQuery {
  status?: TicketStatus | '';
  assigneeIds?: string[];
  createdFrom?: string;
  createdTo?: string;
  cursor?: string;
  limit?: number;
}

/**
 * Cliente HTTP del chat clínico.
 *
 * Cubre SOLO el índice de requerimientos: crear, listar, tomar, devolver a la cola,
 * cerrar y consultar el historial. El contenido de los mensajes NO pasa por aquí —
 * viaja directo entre el navegador y Azure Communication Services con la credencial
 * de `chatToken()`. Ver AcsChatService.
 */
@Injectable({ providedIn: 'root' })
export class ChatService {
  private readonly http = inject(HttpClient);
  private readonly auth = inject(AuthService);
  private readonly base = environment.apiBaseUrl;

  /**
   * Credencial del proveedor, cacheada en memoria mientras siga vigente.
   *
   * Se guarda porque cada pantalla de chat la necesita y pedirla de nuevo en cada
   * navegación gastaría una llamada por vista sin ganar nada: el token es del
   * usuario, no de la conversación.
   */
  private readonly cachedToken = signal<ChatToken | null>(null);

  /**
   * Headers de sesión de TODOS los endpoints de chat.
   *
   * El `Authorization` con el accessToken del usuario se pone explícito para que
   * el interceptor no lo pise con el bearer público (ver `http.interceptor.ts`):
   * ese token es anónimo y contra Kong dejaría la petición sin usuario, así que
   * el chat respondería 401 fuera de local. Mismo criterio que `webauthn.service.ts`.
   *
   * Sin sesión no se añade nada: la petición sale con el bearer público y el
   * backend la rechaza, que es la respuesta correcta para un no autenticado.
   */
  private get authHeaders(): HttpHeaders {
    const accessToken = this.auth.accessToken();
    if (!accessToken) {
      return new HttpHeaders();
    }

    let headers = new HttpHeaders({ Authorization: `Bearer ${accessToken}` });

    const sessionId = this.auth.sessionId();
    if (sessionId) {
      headers = headers.set('session-id', sessionId);
    }

    return headers;
  }

  // ─── Requerimientos ───────────────────────────────────────────────────────

  /**
   * POST /chat/tickets — el paciente abre un requerimiento.
   *
   * OJO con la ventana de agrupación: si el paciente ya abrió uno hace poco y sigue
   * vigente, el backend NO crea otro — responde 200 con `reused: true` y devuelve el
   * que ya tenía. La respuesta es un TicketDetail en los dos casos y su `threadId`
   * siempre es el correcto, así que la única diferencia para el cliente es qué
   * decirle al usuario. Ver `reused` en TicketDetail.
   */
  createTicket(subject: string, consultationType?: string): Observable<TicketDetail> {
    const body: { subject: string; consultationType?: string } = { subject };
    const tipo = consultationType?.trim();
    if (tipo) {
      body.consultationType = tipo;
    }
    return this.http.post<TicketDetail>(`${this.base}/chat/tickets`, body, { headers: this.authHeaders });
  }

  /**
   * GET /chat/tickets/active — los requerimientos VIGENTES del paciente.
   *
   * Devuelve en una sola página los que están en la cola (OPEN) y los que ya atiende
   * un médico (IN_PROGRESS), ordenados por última actividad. Es un endpoint aparte y
   * no `listMyTickets('OPEN')` porque el filtro por estado admite un solo valor:
   * pedir los dos estados por separado obligaría a mezclar en el cliente dos páginas
   * ordenadas de forma independiente, y el orden dejaría de significar nada.
   *
   * Solo para pacientes: a un médico le responde 403.
   */
  listActiveTickets(): Observable<TicketPage> {
    return this.http.get<TicketPage>(`${this.base}/chat/tickets/active`, {
      headers: this.authHeaders,
    });
  }

  /**
   * GET /chat/tickets — listado propio, bifurcado por perfil en el backend.
   * El paciente ve los suyos; el médico, aquellos en los que participa.
   */
  listMyTickets(status?: TicketStatus | ''): Observable<TicketPage> {
    let params = new HttpParams();
    if (status) {
      params = params.set('status', status);
    }
    return this.http.get<TicketPage>(`${this.base}/chat/tickets`, {
      params,
      headers: this.authHeaders,
    });
  }

  /** GET /chat/tickets/queue — cola compartida: los requerimientos sin responsable. */
  listQueue(): Observable<TicketPage> {
    return this.http.get<TicketPage>(`${this.base}/chat/tickets/queue`, {
      headers: this.authHeaders,
    });
  }

  /**
   * GET /chat/tickets/panel — buscador del equipo médico (015).
   *
   * Alcanza los requerimientos de TODO el equipo, a diferencia de listMyTickets.
   * Devuelve solo metadatos: para conversar hay que tomar el requerimiento.
   */
  searchPanel(query: PanelQuery): Observable<PanelPage> {
    let params = new HttpParams();
    if (query.status) {
      params = params.set('status', query.status);
    }
    // El backend espera el parámetro REPETIDO, no una lista separada por comas.
    for (const id of query.assigneeIds ?? []) {
      if (id.trim()) {
        params = params.append('assigneeId', id.trim());
      }
    }
    if (query.createdFrom) {
      params = params.set('createdFrom', query.createdFrom);
    }
    if (query.createdTo) {
      params = params.set('createdTo', query.createdTo);
    }
    if (query.cursor) {
      params = params.set('cursor', query.cursor);
    }
    if (query.limit) {
      params = params.set('limit', String(query.limit));
    }
    return this.http.get<PanelPage>(`${this.base}/chat/tickets/panel`, {
      params,
      headers: this.authHeaders,
    });
  }

  /** GET /chat/tickets/:id — detalle con participantes. Exige participar. */
  getTicket(ticketId: string): Observable<TicketDetail> {
    return this.http.get<TicketDetail>(`${this.base}/chat/tickets/${ticketId}`, {
      headers: this.authHeaders,
    });
  }

  /** POST /chat/tickets/:id/claim — el médico se auto-asigna un requerimiento abierto. */
  claimTicket(ticketId: string): Observable<TicketDetail> {
    return this.http.post<TicketDetail>(`${this.base}/chat/tickets/${ticketId}/claim`, {}, {
      headers: this.authHeaders,
    });
  }

  /** POST /chat/tickets/:id/release — devolver a la cola. Cualquier médico puede. */
  releaseTicket(ticketId: string): Observable<TicketDetail> {
    return this.http.post<TicketDetail>(`${this.base}/chat/tickets/${ticketId}/release`, {}, {
      headers: this.authHeaders,
    });
  }

  /** POST /chat/tickets/:id/close — cerrar. Solo el responsable, y es terminal. */
  closeTicket(ticketId: string): Observable<TicketDetail> {
    return this.http.post<TicketDetail>(`${this.base}/chat/tickets/${ticketId}/close`, {}, {
      headers: this.authHeaders,
    });
  }

  /** GET /chat/tickets/:id/history — recorrido de estados. Solo equipo médico. */
  getHistory(ticketId: string): Observable<TicketHistory> {
    return this.http.get<TicketHistory>(`${this.base}/chat/tickets/${ticketId}/history`, {
      headers: this.authHeaders,
    });
  }

  /** PUT /chat/tickets/:id/subject — el titular corrige el asunto mientras esté abierto. */
  updateSubject(ticketId: string, subject: string): Observable<TicketDetail> {
    return this.http.put<TicketDetail>(`${this.base}/chat/tickets/${ticketId}/subject`, { subject }, {
      headers: this.authHeaders,
    });
  }

  /**
   * POST /chat/tickets/:id/activity — avisa de que hubo actividad.
   *
   * Hace falta porque el backend no ve los mensajes: sin esta llamada, la marca de
   * última actividad no avanzaría y el requerimiento se hundiría en los listados
   * pese a estar vivo.
   */
  reportActivity(ticketId: string): Observable<void> {
    return this.http.post<void>(`${this.base}/chat/tickets/${ticketId}/activity`, {}, {
      headers: this.authHeaders,
    });
  }

  /** POST /chat/tickets/:id/read — marca de lectura, base del indicador de no leídos. */
  markRead(ticketId: string): Observable<void> {
    return this.http.post<void>(`${this.base}/chat/tickets/${ticketId}/read`, {}, {
      headers: this.authHeaders,
    });
  }

  // ─── Credencial del proveedor ─────────────────────────────────────────────

  /**
   * POST /chat/token — credencial de ACS del usuario autenticado.
   *
   * Se pide una vez y se reutiliza mientras quede margen de vigencia. El margen de
   * un minuto evita el caso molesto: un token que caduca justo mientras se abre la
   * conversación, que fallaría con un error del proveedor sin relación aparente
   * con la sesión.
   */
  async chatToken(): Promise<ChatToken> {
    const cached = this.cachedToken();
    if (cached && new Date(cached.expiresOn).getTime() - Date.now() > 60_000) {
      return cached;
    }

    const fresh = await new Promise<ChatToken>((resolve, reject) => {
      this.http
        .post<ChatToken>(`${this.base}/chat/token`, {}, { headers: this.authHeaders })
        .subscribe({
          next: resolve,
          error: reject,
        });
    });
    this.cachedToken.set(fresh);
    return fresh;
  }

  /** Olvida la credencial cacheada. Se llama al cerrar sesión. */
  clearToken(): void {
    this.cachedToken.set(null);
  }
}
