import { HttpClient, HttpHeaders } from '@angular/common/http';
import { Injectable, NgZone, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { Capacitor } from '@capacitor/core';
import { PushNotifications, Token } from '@capacitor/push-notifications';
import { initializeApp } from 'firebase/app';
import { getMessaging, getToken, onMessage } from 'firebase/messaging';
import { firstValueFrom } from 'rxjs';
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
  readonly fcmToken = signal<string | null>(null);
  private nativeListenersReady = false;
  private audioContext: AudioContext | null = null;

  /**
   * Registra los callbacks al arrancar la app. No solicita permisos aquí para
   * evitar que Android muestre el diálogo sin una acción explícita del usuario.
   */
  async init(): Promise<void> {
    if (!Capacitor.isNativePlatform() || this.nativeListenersReady) return;

    await PushNotifications.addListener('registration', (token) => {
      void this.registerNativeToken(token);
    });
    await PushNotifications.addListener('registrationError', (error) => {
      this.zone.run(() => this.status.set(`Error al registrar FCM: ${error.error}`));
    });
    await PushNotifications.addListener('pushNotificationReceived', (notification) => {
      this.zone.run(() => {
        this.lastMessage.set(this.messageLabel(notification.title, notification.body));
        this.playSound();
      });
    });
    await PushNotifications.addListener('pushNotificationActionPerformed', (action) => {
      this.zone.run(
        () =>
          void this.openNotification(
            action.notification.data?.['ticketId'],
            action.notification.data?.['destination'],
          ),
      );
    });

    this.nativeListenersReady = true;
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
    const messaging = getMessaging(initializeApp(environment.firebase));
    const token = await getToken(messaging, { vapidKey: environment.firebase.vapidKey });
    this.fcmToken.set(token);
    if (this.auth.accessToken()) await this.register(token, 'web');
    else this.status.set('Token FCM recibido; inicia sesión para asociarlo a tu cuenta');
    onMessage(messaging, (payload) =>
      this.zone.run(() => {
        const title =
          payload.notification?.title || payload.data?.['senderName'] || 'Nuevo mensaje';
        const body =
          payload.notification?.body || payload.data?.['message'] || 'Tienes un nuevo mensaje';
        const ticketId = payload.data?.['ticketId'];
        const destination = payload.data?.['destination'];
        this.lastMessage.set(this.messageLabel(title, body));
        this.playSound();

        const notification = new Notification(title, { body, data: { ticketId, destination } });
        notification.onclick = () => {
          window.focus();
          notification.close();
          this.zone.run(() => void this.openNotification(ticketId, destination));
        };
      }),
    );
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
    this.fcmToken.set(token.value);
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
    if (ticketId) {
      await this.router.navigate(['/chat', ticketId]);
      return;
    }
    const match = destination?.match(/^\/chat\/([^/?#]+)$/);
    if (match?.[1]) await this.router.navigate(['/chat', decodeURIComponent(match[1])]);
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
  private get authHeaders(): HttpHeaders {
    const token = this.auth.accessToken();
    return token ? new HttpHeaders({ Authorization: `Bearer ${token}` }) : new HttpHeaders();
  }
}
