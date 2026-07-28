import { Injectable, NgZone, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { Capacitor, PluginListenerHandle } from '@capacitor/core';
import { Browser } from '@capacitor/browser';
import { App, URLOpenListenerEvent } from '@capacitor/app';
import { apiErrorMessage, AuthService } from './auth.service';
import { APP_URL_SCHEME } from './apple-auth.config';
import { REDIRECT_URI } from './google-auth.config';

/**
 * Único punto de entrada de los deep links de la app.
 *
 * Vive en el root injector y se arranca desde `App` (el componente raíz), no
 * desde la pantalla de login: el SO puede reabrir la app en cualquier ruta —o
 * relanzarla desde cero— y el callback llegaría a un componente que ya no está
 * montado, dejando al usuario en la app sin sesión y sin ningún mensaje.
 *
 * Enruta dos schemes:
 *   - `com.googleusercontent.apps.…:/`  → callback OAuth de Google (iOS, PKCE).
 *   - `com.drkapps.pruebabiometria://`  → callback de Apple (Android).
 *
 * El estado (`loading` / `error` / `success`) se expone como signals para que la
 * pantalla de login lo muestre si está visible; el canje y la navegación ocurren
 * igual aunque no lo esté.
 */
@Injectable({ providedIn: 'root' })
export class DeepLinkService {
  private readonly zone = inject(NgZone);
  private readonly router = inject(Router);
  private readonly auth = inject(AuthService);

  private listener: PluginListenerHandle | null = null;
  private started = false;

  /**
   * URLs ya procesadas. `appUrlOpen` y `getLaunchUrl()` pueden entregar LA MISMA
   * URL en un arranque en frío, y el token del deep link es de un solo uso: el
   * segundo canje devuelve 401 y pisaría el login exitoso con un error.
   */
  private readonly handled = new Set<string>();

  readonly loading = signal(false);
  readonly error = signal<string | null>(null);
  readonly success = signal(false);

  /** Idempotente: se puede llamar en cada arranque sin duplicar el listener. */
  async init(): Promise<void> {
    if (this.started || !Capacitor.isNativePlatform()) {
      return;
    }
    this.started = true;

    this.listener = await App.addListener('appUrlOpen', (event: URLOpenListenerEvent) =>
      this.zone.run(() => this.routeIncomingUrl(event.url)),
    );

    // Arranque en frío: si el deep link levantó la app, `appUrlOpen` ya se
    // disparó antes de que existiera el listener.
    const launch = await App.getLaunchUrl();
    if (launch?.url) {
      this.zone.run(() => this.routeIncomingUrl(launch.url));
    }
  }

  async destroy(): Promise<void> {
    await this.listener?.remove();
    this.listener = null;
    this.started = false;
  }

  clearError(): void {
    this.error.set(null);
  }

  private routeIncomingUrl(url: string): void {
    if (this.handled.has(url)) {
      return;
    }
    this.handled.add(url);

    if (url.startsWith(REDIRECT_URI)) {
      this.handleGoogleOAuthCallback(url);
      return;
    }

    if (url.startsWith(APP_URL_SCHEME)) {
      this.handleAppleDeepLink(url);
    }
  }

  // ── Apple en Android ───────────────────────────────────────────────────────

  /**
   * El backend redirige al scheme de la app con `token` (referencia a la sesión
   * recién creada) o con `error`.
   *
   * El token del deep link NO es el accessToken: se canjea contra
   * GET /auth/me?token=… para obtener accessToken, refreshToken, sessionId y
   * perfil, porque en nativo no hay cookie HttpOnly que lleve la sesión.
   */
  private handleAppleDeepLink(url: string): void {
    // Cerramos el Custom Tab si seguía abierto (en web es un no-op).
    Browser.close().catch(() => {});

    const params = new URL(url).searchParams;
    const token = params.get('token');
    const error = params.get('error');

    if (error) {
      this.fail(this.appleErrorMessage(error));
      return;
    }

    if (!token) {
      this.fail('El callback de Apple no trajo el token de sesión.');
      return;
    }

    this.loading.set(true);
    this.error.set(null);

    this.auth.meWithToken(token).subscribe({
      next: () => this.succeed('/home'),
      error: err => this.fail(apiErrorMessage(err, 'No se pudo recuperar la sesión de Apple.')),
    });
  }

  /** Traduce los códigos de error que el backend manda en el deep link. */
  private appleErrorMessage(code: string): string {
    switch (code) {
      case 'ACCESS_DENIED':
      case 'user_cancelled_authorize':
        return 'El inicio de sesión con Apple fue cancelado.';
      case 'UNAUTHORIZED':
        return 'Apple no autorizó la sesión. Intenta de nuevo.';
      default:
        return `Error al iniciar sesión con Apple (${code}).`;
    }
  }

  // ── Google en iOS (PKCE) ───────────────────────────────────────────────────

  private handleGoogleOAuthCallback(url: string): void {
    const params = new URL(url).searchParams;
    const code = params.get('code');
    const state = params.get('state');
    const oauthError = params.get('error');

    const storedState = sessionStorage.getItem('oauth_state');
    const verifier = sessionStorage.getItem('pkce_verifier') ?? '';

    sessionStorage.removeItem('oauth_state');
    sessionStorage.removeItem('pkce_verifier');

    Browser.close().catch(() => {});

    if (oauthError) {
      this.fail('El usuario canceló el inicio de sesión.');
      return;
    }

    if (!code || state !== storedState) {
      this.fail('Error de seguridad en el flujo OAuth. Intenta de nuevo.');
      return;
    }

    this.loading.set(true);
    this.error.set(null);

    this.auth.exchangeGoogleCode(code, verifier, REDIRECT_URI).subscribe({
      next: () => this.succeed('/biometria'),
      error: err => this.fail(apiErrorMessage(err, 'Error al completar el inicio de sesión.')),
    });
  }

  // ── Helpers de estado ──────────────────────────────────────────────────────

  private succeed(path: string): void {
    this.loading.set(false);
    this.success.set(true);
    setTimeout(() => this.router.navigate([path]), 800);
  }

  private fail(message: string): void {
    this.loading.set(false);
    this.success.set(false);
    this.error.set(message);
  }
}
