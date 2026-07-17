import { Component, AfterViewInit, OnDestroy, NgZone, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Router } from '@angular/router';
import { Capacitor } from '@capacitor/core';
import { Browser } from '@capacitor/browser';
import { App, URLOpenListenerEvent } from '@capacitor/app';
import { NativeBiometric } from '@capgo/capacitor-native-biometric';
import { firstValueFrom } from 'rxjs';
import { AuthService } from '../auth.service';
import { AppleSignInButton } from '../apple-sign-in-button/apple-sign-in-button';
import { generateCodeVerifier, generateCodeChallenge, generateState } from '../pkce.util';

declare const google: any;

// Cliente Web — usado solo en el navegador con Google Identity Services
const GOOGLE_WEB_CLIENT_ID = '537881986178-23dhaeonqr38trcrmj76ke6hs64j8qpk.apps.googleusercontent.com';

// Cliente iOS — crearlo en Google Cloud Console → Credenciales → Tipo: iOS → Bundle ID: com.drkapps.pruebabiometria
// El redirect URI es siempre: com.googleusercontent.apps.TU_CLIENT_ID_IOS:/
const GOOGLE_IOS_CLIENT_ID = '537881986178-eugpuu3m6hsh5i94lfmieljjqs4lngvu.apps.googleusercontent.com';
const REDIRECT_URI = `com.googleusercontent.apps.${GOOGLE_IOS_CLIENT_ID.split('.')[0]}:/`;

@Component({
  selector: 'app-google-login-test',
  imports: [CommonModule, AppleSignInButton],
  templateUrl: './google-login-test.html',
  styleUrls: ['./google-login-test.css'],
  standalone: true,
})
export class GoogleLoginTest implements AfterViewInit, OnDestroy {
  private pollInterval: ReturnType<typeof setInterval> | null = null;
  private urlOpenListener: { remove: () => Promise<void> } | null = null;

  isNative = signal(Capacitor.isNativePlatform());

  // Web GSI state
  googleReady = signal(false);
  googleFailed = signal(false);

  // Shared login state
  loading = signal(false);
  loginSuccess = signal(false);
  error = signal<string | null>(null);

  // Biometric state
  biometricLoading = signal(false);
  biometricError = signal<string | null>(null);

  constructor(
    private zone: NgZone,
    private router: Router,
    private auth: AuthService,
  ) {}

  async ngAfterViewInit(): Promise<void> {
    if (this.isNative()) {
      // iOS: escuchar el callback de OAuth (URL scheme)
      this.urlOpenListener = await App.addListener(
        'appUrlOpen',
        (event: URLOpenListenerEvent) => this.zone.run(() => this.handleOAuthCallback(event.url)),
      );
    } else {
      // Web: inicializar el botón de Google Identity Services
      this.waitForGoogle();
    }
  }

  ngOnDestroy(): void {
    this.stopPolling();
    this.urlOpenListener?.remove();
  }

  // ── Flujo nativo iOS (SFSafariViewController + PKCE) ──────────────────────

  async loginWithGoogleNative(): Promise<void> {
    this.loading.set(true);
    this.error.set(null);

    try {
      const verifier = await generateCodeVerifier();
      const challenge = await generateCodeChallenge(verifier);
      const state = generateState();

      sessionStorage.setItem('pkce_verifier', verifier);
      sessionStorage.setItem('oauth_state', state);

      const params = new URLSearchParams({
        client_id: GOOGLE_IOS_CLIENT_ID,
        redirect_uri: REDIRECT_URI,
        response_type: 'code',
        scope: 'openid email profile',
        state,
        code_challenge: challenge,
        code_challenge_method: 'S256',
      });

      // Abre SFSafariViewController — el usuario ve Safari dentro de la app
      await Browser.open({
        url: `https://accounts.google.com/o/oauth2/v2/auth?${params}`,
        presentationStyle: 'fullscreen',
      });
    } catch (err: any) {
      this.loading.set(false);
      this.error.set(err?.message ?? 'No se pudo abrir el navegador.');
    }
  }

  private handleOAuthCallback(url: string): void {
    if (!url.startsWith(REDIRECT_URI)) return;

    const params = new URL(url).searchParams;
    const code = params.get('code');
    const state = params.get('state');
    const oauthError = params.get('error');

    const storedState = sessionStorage.getItem('oauth_state');
    const verifier = sessionStorage.getItem('pkce_verifier') ?? '';

    sessionStorage.removeItem('oauth_state');
    sessionStorage.removeItem('pkce_verifier');

    Browser.close();

    if (oauthError) {
      this.loading.set(false);
      this.error.set('El usuario canceló el inicio de sesión.');
      return;
    }

    if (!code || state !== storedState) {
      this.loading.set(false);
      this.error.set('Error de seguridad en el flujo OAuth. Intenta de nuevo.');
      return;
    }

    this.auth.exchangeGoogleCode(code, verifier, REDIRECT_URI).subscribe({
      next: () => {
        this.loading.set(false);
        this.loginSuccess.set(true);
        setTimeout(() => this.router.navigate(['/biometria']), 800);
      },
      error: (err) => {
        this.loading.set(false);
        const body = err.error ?? {};
        this.error.set(body.message ?? 'Error al completar el inicio de sesión.');
      },
    });
  }

  // ── Sign in with Apple (redirección de servidor) ─────────────────────────

  /** Navegación real del navegador hacia el backend; no vuelve por aquí. */
  loginWithApple(): void {
    this.loading.set(true);
    this.error.set(null);
    this.auth.loginWithApple();
  }

  // ── Flujo web (Google Identity Services) ──────────────────────────────────

  retryGoogle(): void {
    this.googleFailed.set(false);
    this.waitForGoogle();
  }

  private waitForGoogle(): void {
    if (typeof (window as any).google !== 'undefined') {
      this.setupGoogleButton();
      return;
    }

    let attempts = 0;
    this.pollInterval = setInterval(() => {
      attempts++;
      if (typeof (window as any).google !== 'undefined') {
        this.stopPolling();
        this.zone.run(() => this.setupGoogleButton());
      } else if (attempts >= 75) {
        this.stopPolling();
        this.zone.run(() => this.googleFailed.set(true));
      }
    }, 200);
  }

  private setupGoogleButton(): void {
    google.accounts.id.initialize({
      client_id: GOOGLE_WEB_CLIENT_ID,
      callback: (resp: any) => this.zone.run(() => this.onGoogleIdToken(resp.credential)),
    });

    google.accounts.id.renderButton(document.getElementById('google-btn'), {
      theme: 'outline',
      size: 'large',
      text: 'signin_with',
    });

    this.googleReady.set(true);
  }

  private stopPolling(): void {
    if (this.pollInterval !== null) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
  }

  private onGoogleIdToken(idToken: string): void {
    this.loading.set(true);
    this.error.set(null);
    this.loginSuccess.set(false);

    this.auth.googleLogin(idToken).subscribe({
      next: () => {
        this.loading.set(false);
        this.loginSuccess.set(true);
        setTimeout(() => this.router.navigate(['/biometria']), 800);
      },
      error: (err) => {
        this.loading.set(false);
        const body = err.error ?? {};
        this.error.set(body.message ?? body.code ?? 'Error al iniciar sesión con Google.');
      },
    });
  }

  // ── Login biométrico ───────────────────────────────────────────────────────

  clearError(): void {
    this.error.set(null);
    this.biometricError.set(null);
  }

  async loginWithBiometrics(): Promise<void> {
    this.biometricLoading.set(true);
    this.biometricError.set(null);

    try {
      const available = await NativeBiometric.isAvailable();
      if (!available.isAvailable) {
        this.biometricError.set('Biometría no disponible en este dispositivo.');
        return;
      }

      // Verificar primero que hay credenciales guardadas antes de mostrar Face ID
      let credentials: { username: string; password: string };
      try {
        credentials = await NativeBiometric.getCredentials({ server: this.auth.BIOMETRIC_SERVER });
      } catch {
        this.biometricError.set('No hay biometría registrada. Por favor inicia sesión con Google primero.');
        return;
      }

      // Solo pedimos Face ID / Touch ID si hay credenciales guardadas
      await NativeBiometric.verifyIdentity({
        reason: 'Inicia sesión con tu biometría',
        title: 'Autenticación biométrica',
        subtitle: 'Usa Face ID o Touch ID',
        description: '',
      });

      await this.authenticateWithCredential(credentials.password, credentials.username);

    } catch (err: any) {
      if (err?.code === 10) return; // usuario canceló Face ID / Touch ID
      console.error('[Login] Error biométrico:', err);
      this.biometricError.set(err?.message ?? 'Error al autenticar con biometría.');
    } finally {
      this.biometricLoading.set(false);
    }
  }

  private async authenticateWithCredential(credential: string, deviceId: string): Promise<void> {
    try {
      // Intenta login biométrico con backend
      await firstValueFrom(this.auth.biometricLogin(credential, deviceId));
      this.router.navigate(['/home']);
    } catch {
      // Fallback: el credential guardado es un accessToken (backend no implementado aún)
      console.warn('[Login] Backend biometric/token no disponible, restaurando sesión con accessToken');
      this.auth.saveSession({ accessToken: credential, refreshToken: '', expiresIn: 3600 });
      this.router.navigate(['/home']);
    }
  }
}
