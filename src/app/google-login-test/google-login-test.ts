import { Component, AfterViewInit, OnDestroy, NgZone, computed, signal, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Router } from '@angular/router';
import { Capacitor } from '@capacitor/core';
import { Browser } from '@capacitor/browser';
import { NativeBiometric } from '@capgo/capacitor-native-biometric';
import { GoogleAuth } from '@codetrix-studio/capacitor-google-auth';
import { firstValueFrom } from 'rxjs';
import {
  SignInWithApple,
  SignInWithAppleOptions,
  SignInWithAppleResponse,
} from '@capacitor-community/apple-sign-in';
import { apiErrorMessage, AuthService } from '../auth.service';
import { AppleSignInButton } from '../apple-sign-in-button/apple-sign-in-button';
import { APPLE_SERVICES_ID, APPLE_WEB_REDIRECT_URI } from '../apple-auth.config';
import { GOOGLE_IOS_CLIENT_ID, GOOGLE_WEB_CLIENT_ID, REDIRECT_URI } from '../google-auth.config';
import { DeepLinkService } from '../deep-link.service';
import { generateCodeVerifier, generateCodeChallenge, generateState } from '../pkce.util';
import { AuthAzureService } from '../auth/auth.service';
import { PasskeyLoginForm } from '../webauthn/passkey-login-form/passkey-login-form';
import { WebAuthnAuthenticationStore } from '../webauthn/webauthn-authentication.store';
import { OtpLogin } from '../auth/otp-login/otp-login';
import { RouterLink } from '@angular/router';

declare const google: any;

@Component({
  selector: 'app-google-login-test',
  imports: [CommonModule, AppleSignInButton, PasskeyLoginForm, OtpLogin, RouterLink],
  templateUrl: './google-login-test.html',
  styleUrls: ['./google-login-test.css'],
  standalone: true,
})
export class GoogleLoginTest implements AfterViewInit, OnDestroy {
  private pollInterval: ReturnType<typeof setInterval> | null = null;

  public readonly authAzure = inject(AuthAzureService);
  private readonly deepLink = inject(DeepLinkService);

  /**
   * Login con passkey — método ADICIONAL. Si la plataforma no lo soporta el
   * formulario no se pinta y quedan disponibles Google, Apple, Microsoft y la
   * biometría de siempre.
   */
  public readonly passkey = inject(WebAuthnAuthenticationStore);

  isNative = signal(Capacitor.isNativePlatform());
  isAndroid = signal(Capacitor.getPlatform() === 'android');

  // Web GSI state
  googleReady = signal(false);
  googleFailed = signal(false);

  // Estado de los logins que arrancan y terminan en esta pantalla.
  private readonly busy = signal(false);
  private readonly localError = signal<string | null>(null);
  private readonly localSuccess = signal(false);

  /**
   * Estado visible = el de esta pantalla + el del servicio de deep links, que es
   * quien resuelve los callbacks de Apple (Android) y Google (iOS PKCE).
   */
  readonly loading = computed(() => this.busy() || this.deepLink.loading());
  readonly error = computed(() => this.localError() ?? this.deepLink.error());
  readonly loginSuccess = computed(() => this.localSuccess() || this.deepLink.success());

  // Biometric state
  biometricLoading = signal(false);
  biometricError = signal<string | null>(null);

  // Apple native state — token para verificar en device antes de que backend tenga el endpoint
  appleNativeToken = signal<string | null>(null);

  constructor(
    private zone: NgZone,
    private router: Router,
    private auth: AuthService,
  ) {}

  async ngOnInit(): Promise<void> {
    await this.authAzure.initialize();

    // GoogleAuth debe inicializarse antes de cualquier signIn(). En nativo lee
    // la config de capacitor.config.ts (scopes + serverClientId).
    if (this.isNative()) {
      GoogleAuth.initialize();
    }

    // Feature detection antes de mostrar el formulario de passkey.
    await this.passkey.checkSupport();
  }

  /**
   * Login con passkey. Los tokens que devuelve `finish` son equivalentes a los
   * de Google/Apple/Azure, así que el store ya los guardó con `saveSession` y
   * aquí solo queda navegar como en el resto de los flujos.
   */
  async loginWithPasskey(email: string): Promise<void> {
    if (await this.passkey.login(email)) {
      this.router.navigate(['/home']);
    }
  }

  /**
   * Login con Microsoft: navega a Entra ID en esta misma pestaña. El post-login
   * (canje del id_token y salto a /biometria) ocurre al volver a /auth-azure,
   * igual que el flujo de Apple.
   */
  async loginAzure(): Promise<void> {
    await this.authAzure.login();
  }

  async logoutAzure(): Promise<void> {
    await this.authAzure.logout();
  }

  async ngAfterViewInit(): Promise<void> {
    // Los callbacks por URL scheme los escucha DeepLinkService desde el
    // componente raíz; aquí solo queda el botón web de Google.
    if (!this.isNative()) {
      this.waitForGoogle();
    }
  }

  ngOnDestroy(): void {
    this.stopPolling();
  }

  // ── Google nativo: elige flujo según plataforma ───────────────────────────

  /** Android usa el plugin nativo (Google Play Services); iOS sigue con PKCE. */
  onGoogleNativeClick(): void {
    if (this.isAndroid()) {
      this.loginWithGoogleAndroid();
    } else {
      this.loginWithGoogleNative();
    }
  }

  // ── Flujo nativo Android (@codetrix-studio/capacitor-google-auth) ─────────

  /**
   * Abre el selector de cuentas nativo de Android y canjea el `idToken` contra
   * el backend con el mismo endpoint que el flujo web (`/auth/google`).
   */
  async loginWithGoogleAndroid(): Promise<void> {
    this.busy.set(true);
    this.localError.set(null);
    this.localSuccess.set(false);

    try {
      const user = await GoogleAuth.signIn();
      console.log('Usuario de Google:', user);

      const idToken = user.authentication?.idToken;
      if (!idToken) {
        throw new Error('Google no devolvió un idToken.');
      }

      this.onGoogleIdToken(idToken);
    } catch (err: any) {
      console.error('Error en login con Google:', err);
      this.busy.set(false);

      // El usuario cerró el selector de cuentas (status 12501 de Play Services).
      const msg = String(err?.message ?? err?.error ?? '');
      if (/12501|cancel/i.test(msg)) {
        this.localError.set('El inicio de sesión con Google fue cancelado.');
        return;
      }

      this.localError.set(msg || 'No se pudo iniciar sesión con Google.');
    }
  }

  // ── Flujo nativo iOS (SFSafariViewController + PKCE) ──────────────────────

  /** Abre el consentimiento de Google; el `code` vuelve por deep link a DeepLinkService. */
  async loginWithGoogleNative(): Promise<void> {
    this.busy.set(true);
    this.localError.set(null);

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

      // A partir de aquí manda el deep link: el spinner lo lleva DeepLinkService.
      this.busy.set(false);
    } catch (err: any) {
      this.busy.set(false);
      this.localError.set(err?.message ?? 'No se pudo abrir el navegador.');
    }
  }

  // ── Sign in with Apple ────────────────────────────────────────────────────

  /**
   * El botón elige el flujo según plataforma: hoja nativa en iOS, y flujo de
   * servidor en Android (Custom Tab + deep link) y en web (navegación real).
   */
  onAppleClick(): void {
    if (this.isNative() && !this.isAndroid()) {
      this.loginWithAppleNative();
    } else {
      this.loginWithApple();
    }
  }

  /**
   * Flujo de SERVIDOR. En web es una navegación real que no vuelve por aquí;
   * en Android abre un Custom Tab y el resultado lo resuelve DeepLinkService.
   */
  async loginWithApple(): Promise<void> {
    this.busy.set(true);
    this.localError.set(null);

    try {
      await this.auth.loginWithApple();

      // En Android el Custom Tab ya está arriba: el estado pasa a manos del
      // deep link, así que soltamos el spinner local.
      this.busy.set(false);
    } catch (err: any) {
      this.busy.set(false);
      this.localError.set(err?.message ?? 'No se pudo abrir el inicio de sesión con Apple.');
    }
  }

  /** Flujo NATIVO iOS: hoja nativa de Apple (Face ID) + exchange contra backend. */
  async loginWithAppleNative(): Promise<void> {
    this.busy.set(true);
    this.localError.set(null);
    this.appleNativeToken.set(null);

    try {
      // nonce en claro: iOS envía su SHA-256 a Apple; el backend valida contra este.
      const nonce = generateState();

      const options: SignInWithAppleOptions = {
        clientId: APPLE_SERVICES_ID,
        redirectURI: APPLE_WEB_REDIRECT_URI,
        scopes: 'email name',
        nonce,
      };

      const result: SignInWithAppleResponse = await SignInWithApple.authorize(options);
      const r = result.response;

      if (!r?.identityToken) {
        throw new Error('Apple no devolvió un identityToken.');
      }

      this.auth
        .exchangeAppleCode({
          identityToken: r.identityToken,
          authorizationCode: r.authorizationCode,
          nonce,
          email: r.email ?? undefined,
          givenName: r.givenName ?? undefined,
          familyName: r.familyName ?? undefined,
        })
        .subscribe({
          next: () => {
            this.busy.set(false);
            this.localSuccess.set(true);
            setTimeout(() => this.router.navigate(['/home']), 800);
          },
          error: (err) => {
            this.busy.set(false);
            // Backend aún sin /auth/apple/exchange → mostramos que Apple sí funcionó.
            if (err?.status === 404 || err?.status === 0) {
              this.appleNativeToken.set(r.identityToken);
              this.localError.set(
                'Apple te identificó correctamente. Falta que el backend implemente /auth/apple/exchange.',
              );
            } else {
              const body = err.error ?? {};
              this.localError.set(body.message ?? body.code ?? 'Error al iniciar sesión con Apple.');
            }
          },
        });
    } catch (err: any) {
      this.busy.set(false);
      // El usuario canceló la hoja nativa de Apple (ASAuthorizationError.canceled = 1001).
      if (err?.code === '1001' || /cancel/i.test(err?.message ?? '')) {
        this.localError.set('El inicio de sesión con Apple fue cancelado.');
        return;
      }
      this.localError.set(err?.message ?? 'No se pudo iniciar sesión con Apple.');
    }
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
    this.busy.set(true);
    this.localError.set(null);
    this.localSuccess.set(false);

    this.auth.googleLogin(idToken).subscribe({
      next: () => {
        this.busy.set(false);
        this.localSuccess.set(true);
        setTimeout(() => this.router.navigate(['/biometria']), 800);
      },
      error: (err) => {
        this.busy.set(false);
        const body = err.error ?? {};
        this.localError.set(body.message ?? body.code ?? 'Error al iniciar sesión con Google.');
      },
    });
  }

  // ── Login biométrico ───────────────────────────────────────────────────────

  clearError(): void {
    this.localError.set(null);
    this.deepLink.clearError();
    this.biometricError.set(null);
    this.authAzure.error.set(null);
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
      this.biometricError.set(
        apiErrorMessage(err, 'Error al autenticar con biometría.'),
      );
    } finally {
      this.biometricLoading.set(false);
    }
  }

  private async authenticateWithCredential(biometricToken: string, deviceId: string): Promise<void> {
    const res = await firstValueFrom(this.auth.biometricLogin(biometricToken, deviceId));

    // El backend revoca el token en cada uso y devuelve el siguiente en
    // `refreshToken`: si no se guarda aquí, el próximo login biométrico falla.
    try {
      await NativeBiometric.setCredentials({
        username: deviceId,
        password: res.refreshToken,
        server: this.auth.BIOMETRIC_SERVER,
      });
    } catch (err) {
      // La sesión ya es válida; solo se pierde el acceso biométrico futuro.
      console.error('[Login] No se pudo rotar el token biométrico:', err);
    }

    this.router.navigate(['/home']);
  }
}
