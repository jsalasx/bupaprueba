import { HttpClient, HttpHeaders } from '@angular/common/http';
import { Injectable, NgZone, computed, effect, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { App } from '@capacitor/app';
import { Capacitor } from '@capacitor/core';
import { PushNotifications, Token } from '@capacitor/push-notifications';
import { initializeApp } from 'firebase/app';
import { getMessaging, getToken, Messaging, onMessage } from 'firebase/messaging';
import { firstValueFrom, Subject } from 'rxjs';
import { AuthService } from '../auth.service';
import { environment } from '../../environments/environment';

@Injectable({ providedIn: 'root' })
export class NotificationService {
  private readonly http = inject(HttpClient);
  private readonly auth = inject(AuthService);
  private readonly zone = inject(NgZone);
  private readonly router = inject(Router);
  readonly status = signal('Push sin configurar');
  readonly lastMessage = signal<string | null>(null);
  readonly history = signal<AppNotification[]>([]);
  readonly unreadCount = computed(() => this.history().filter((item) => !item.isRead).length);
  readonly historyOpen = signal(false);
  readonly fcmToken = signal<string | null>(localStorage.getItem('fcm-token'));
  /** Señal en primer plano para que la pantalla médica refresque la cola sin sondeo. */
  readonly queueEvents = new Subject<'received' | 'open'>();
  private nativeListenersReady = false;
  private audioContext: AudioContext | null = null;
  private toastTimer: ReturnType<typeof setTimeout> | null = null;
  private activeHistoryKey = '';
  private webMessaging: Messaging | null = null;
  private webListenerReady = false;
  private registrationCheckStarted = false;
  private pendingNotificationId: string | null = null;

  constructor() {
    effect(() => {
      const key = this.historyKey();
      if (key === this.activeHistoryKey) return;
      this.activeHistoryKey = key;
      this.history.set(this.loadHistory(key));
    });
    effect(() => {
      if (!this.auth.accessToken()) return;
      void this.loadHistoryFromBackend();
      void this.verifyRegistration();
      if (this.pendingNotificationId) {
        const id = this.pendingNotificationId;
        this.pendingNotificationId = null;
        void this.markRead(id);
      }
    });
  }

  /**
   * Registra los callbacks al arrancar la app. No solicita permisos aquí para
   * evitar que Android muestre el diálogo sin una acción explícita del usuario.
   */
  async init(): Promise<void> {
    this.startRegistrationChecks();
    this.captureBackgroundNotificationClick();
    if (!Capacitor.isNativePlatform()) {
      if (Notification.permission === 'granted') void this.enableWeb().catch(() => undefined);
      return;
    }
    if (this.nativeListenersReady) return;

    await PushNotifications.addListener('registration', (token) => {
      void this.registerNativeToken(token);
    });
    await PushNotifications.addListener('registrationError', (error) => {
      this.zone.run(() => this.status.set(`Error al registrar FCM: ${error.error}`));
    });
    await PushNotifications.addListener('pushNotificationReceived', (notification) => {
      this.zone.run(() => {
        this.receiveNotification(
          notification.title || 'Nueva notificación',
          notification.body || 'Tienes una nueva notificación',
          notification.data?.['ticketId'],
          notification.data?.['destination'],
          notification.data?.['notificationId'],
        );
        this.playSound();
      });
    });
    await PushNotifications.addListener('pushNotificationActionPerformed', (action) => {
      this.zone.run(() => {
        const ticketId = action.notification.data?.['ticketId'];
        const destination = action.notification.data?.['destination'];
        const item = this.receiveNotification(
          action.notification.title || 'Nueva notificación',
          action.notification.body || 'Tienes una nueva notificación',
          ticketId,
          destination,
          action.notification.data?.['notificationId'],
        );
        void this.openHistoryItem(item);
      });
    });

    this.nativeListenersReady = true;
    const permission = await PushNotifications.checkPermissions();
    if (permission.receive === 'granted') await PushNotifications.register();
  }

  async enable(): Promise<void> {
    try {
      if (Capacitor.isNativePlatform()) await this.enableNative();
      else await this.enableWeb();
    } catch (error) {
      this.status.set(error instanceof Error ? error.message : 'No se pudo activar push');
    }
  }

  private async enableWeb(): Promise<void> {
    if (!environment.firebase.apiKey || !environment.firebase.vapidKey)
      throw new Error('Completa firebase y vapidKey en environment.ts');
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') throw new Error('Permiso de notificaciones denegado');
    await this.prepareSound();
    this.webMessaging ??= getMessaging(initializeApp(environment.firebase));
    const token = await getToken(this.webMessaging, { vapidKey: environment.firebase.vapidKey });
    this.saveFCMToken(token);
    if (this.auth.accessToken()) await this.register(token, 'web');
    else this.status.set('Token FCM recibido; inicia sesión para asociarlo a tu cuenta');
    if (!this.webListenerReady) {
      onMessage(this.webMessaging, (payload) =>
        this.zone.run(() => {
          const title =
            payload.notification?.title || payload.data?.['senderName'] || 'Nuevo mensaje';
          const body =
            payload.notification?.body || payload.data?.['message'] || 'Tienes un nuevo mensaje';
          const ticketId = payload.data?.['ticketId'];
          const destination = payload.data?.['destination'];
          if (payload.data?.['type'] === 'queueCreated') this.queueEvents.next('received');
          const item = this.receiveNotification(
            title,
            body,
            ticketId,
            destination,
            payload.data?.['notificationId'],
          );
          this.playSound();

          const notification = new Notification(title, { body, data: { ticketId, destination } });
          setTimeout(() => notification.close(), 30_000);
          notification.onclick = () => {
            window.focus();
            notification.close();
            this.zone.run(() => void this.openHistoryItem(item));
          };
        }),
      );
      this.webListenerReady = true;
    }
    if (this.auth.accessToken()) this.status.set('Push web registrado');
  }

  private async enableNative(): Promise<void> {
    await this.init();
    const permission = await PushNotifications.requestPermissions();
    if (permission.receive !== 'granted') throw new Error('Permiso de notificaciones denegado');
    await PushNotifications.register();
    this.status.set('Esperando token del dispositivo');
  }

  private async registerNativeToken(token: Token): Promise<void> {
    this.saveFCMToken(token.value);
    if (!this.auth.accessToken()) {
      this.zone.run(() =>
        this.status.set('Token FCM recibido; inicia sesión para asociarlo a tu cuenta'),
      );
      return;
    }
    try {
      await this.register(token.value, Capacitor.getPlatform() as 'android' | 'ios');
    } catch (error) {
      this.zone.run(() =>
        this.status.set(error instanceof Error ? error.message : 'No se pudo guardar el token FCM'),
      );
    }
  }

  private async register(token: string, platform: 'web' | 'android' | 'ios'): Promise<void> {
    const installationId = this.installationId();
    await firstValueFrom(
      this.http.post(
        `${environment.apiBaseUrl}/notifications/installations`,
        { installationId, platform, token },
        { headers: this.authHeaders },
      ),
    );
    this.status.set(`Push ${platform} registrado`);
  }

  private async openNotification(ticketId?: string, destination?: string): Promise<void> {
    if (destination?.startsWith('/home/medicos')) {
      this.queueEvents.next('open');
      await this.router.navigate(['/home/medicos'], { queryParams: { tab: 'cola' } });
      return;
    }
    if (ticketId) {
      await this.router.navigate(['/chat', ticketId]);
      return;
    }
    const match = destination?.match(/^\/chat\/([^/?#]+)$/);
    if (match?.[1]) await this.router.navigate(['/chat', decodeURIComponent(match[1])]);
  }

  toggleHistory(): void {
    this.historyOpen.update((open) => !open);
  }

  closeHistory(): void {
    this.historyOpen.set(false);
  }

  closeToast(): void {
    if (this.toastTimer) clearTimeout(this.toastTimer);
    this.toastTimer = null;
    this.lastMessage.set(null);
  }

  async openHistoryItem(item: AppNotification): Promise<void> {
    this.closeHistory();
    this.closeToast();
    if (!item.isRead) {
      this.history.update((items) =>
        items.map((row) =>
          row.id === item.id ? { ...row, isRead: true, readAt: new Date().toISOString() } : row,
        ),
      );
      this.persistLocalHistory();
      await this.markRead(item.id);
    }
    await this.openNotification(item.ticketId, item.destination);
  }

  async openLatest(): Promise<void> {
    const latest = this.history()[0];
    if (latest) await this.openHistoryItem(latest);
  }

  private receiveNotification(
    title: string,
    body: string,
    ticketId?: string,
    destination?: string,
    notificationId?: string,
  ): AppNotification {
    const item: AppNotification = {
      id: notificationId || crypto.randomUUID(),
      title,
      body,
      ticketId,
      destination,
      receivedAt: new Date().toISOString(),
      isRead: false,
    };
    const history = [item, ...this.history().filter((row) => row.id !== item.id)].slice(0, 10);
    this.history.set(history);
    this.persistLocalHistory();
    this.lastMessage.set(this.messageLabel(title, body));
    if (this.toastTimer) clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => this.zone.run(() => this.closeToast()), 30_000);
    return item;
  }

  private loadHistory(key: string): AppNotification[] {
    try {
      const value = JSON.parse(localStorage.getItem(key) || '[]');
      return Array.isArray(value) ? value.slice(0, 10) : [];
    } catch {
      return [];
    }
  }

  private historyKey(): string {
    return `notification-history:${this.auth.userEmail() || 'device'}`;
  }

  private persistLocalHistory(): void {
    localStorage.setItem(
      this.activeHistoryKey || this.historyKey(),
      JSON.stringify(this.history().slice(0, 10)),
    );
  }

  private async loadHistoryFromBackend(): Promise<void> {
    if (!this.auth.accessToken()) return;
    try {
      const response = await firstValueFrom(
        this.http.get<{ items: BackendNotification[] }>(`${environment.apiBaseUrl}/notifications`, {
          headers: this.authHeaders,
        }),
      );
      const history = (response.items ?? []).slice(0, 10).map((item) => ({
        id: item.id,
        title:
          item.title ||
          (item.type === 'queue_created' ? 'Nuevo paciente en cola' : 'Nuevo mensaje'),
        body: item.body || 'Tienes una nueva notificación',
        ticketId: item.ticketId,
        destination:
          item.destination?.type === 'queue'
            ? '/home/medicos?tab=cola'
            : item.ticketId
              ? `/chat/${item.ticketId}`
              : undefined,
        receivedAt: item.createdAt,
        isRead: item.isRead,
        readAt: item.readAt,
      }));
      this.history.set(history);
      this.persistLocalHistory();
    } catch {
      // Mantiene el cache local si el backend está temporalmente inaccesible.
    }
  }

  private async markRead(notificationId: string): Promise<void> {
    try {
      await firstValueFrom(
        this.http.patch(
          `${environment.apiBaseUrl}/notifications/${encodeURIComponent(notificationId)}/read`,
          {},
          { headers: this.authHeaders },
        ),
      );
    } catch {
      // La navegación no se bloquea por una caída temporal; una próxima apertura permite
      // reintentar y el listado del backend sigue siendo la fuente autoritativa.
    }
  }

  private captureBackgroundNotificationClick(): void {
    const url = new URL(window.location.href);
    const notificationId = url.searchParams.get('notificationId');
    if (!notificationId) return;
    this.pendingNotificationId = notificationId;
    url.searchParams.delete('notificationId');
    window.history.replaceState(window.history.state, '', url.pathname + url.search + url.hash);
  }

  private startRegistrationChecks(): void {
    if (this.registrationCheckStarted) return;
    this.registrationCheckStarted = true;
    window.setInterval(() => void this.verifyRegistration(), 15 * 60 * 1000);
    if (Capacitor.isNativePlatform()) {
      void App.addListener('appStateChange', ({ isActive }) => {
        if (isActive) void this.verifyRegistration();
      });
    }
  }

  private async verifyRegistration(): Promise<void> {
    if (!this.auth.accessToken() || !this.fcmToken()) return;
    try {
      if (Capacitor.isNativePlatform()) {
        await PushNotifications.register();
        return;
      }
      if (!this.webMessaging || Notification.permission !== 'granted') return;
      const token = await getToken(this.webMessaging, { vapidKey: environment.firebase.vapidKey });
      this.saveFCMToken(token);
      await this.register(token, 'web');
    } catch (error) {
      this.zone.run(() =>
        this.status.set(error instanceof Error ? error.message : 'No se pudo verificar FCM'),
      );
    }
  }

  private messageLabel(title?: string, body?: string): string {
    return [title, body].filter((value) => !!value?.trim()).join(': ') || 'Nueva notificación';
  }

  private async prepareSound(): Promise<void> {
    this.audioContext ??= new AudioContext();
    if (this.audioContext.state === 'suspended') await this.audioContext.resume();
  }

  private playSound(): void {
    const context = this.audioContext;
    if (!context || context.state !== 'running') return;
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.type = 'sine';
    oscillator.frequency.setValueAtTime(880, context.currentTime);
    gain.gain.setValueAtTime(0.0001, context.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.18, context.currentTime + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + 0.28);
    oscillator.connect(gain).connect(context.destination);
    oscillator.start();
    oscillator.stop(context.currentTime + 0.3);
  }
  private installationId(): string {
    const key = 'notification-installation-id';
    let id = localStorage.getItem(key);
    if (!id) {
      id = crypto.randomUUID();
      localStorage.setItem(key, id);
    }
    return id;
  }
  private saveFCMToken(token: string): void {
    this.fcmToken.set(token);
    localStorage.setItem('fcm-token', token);
  }
  private get authHeaders(): HttpHeaders {
    const token = this.auth.accessToken();
    return token ? new HttpHeaders({ Authorization: `Bearer ${token}` }) : new HttpHeaders();
  }
}

export interface AppNotification {
  id: string;
  title: string;
  body: string;
  ticketId?: string;
  destination?: string;
  receivedAt: string;
  isRead: boolean;
  readAt?: string;
}

interface BackendNotification {
  id: string;
  title: string;
  body: string;
  type: string;
  ticketId?: string;
  destination?: { type: 'chat' | 'queue'; ticketId?: string };
  isRead: boolean;
  readAt?: string;
  createdAt: string;
}
