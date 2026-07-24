import { inject, Injectable, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { AccountInfo, RedirectRequest } from '@azure/msal-browser';

import { apiErrorMessage, AuthService } from '../auth.service';
import { AZURE_SCOPES, MSAL_INSTANCE, MSAL_REDIRECT_URI } from './auth.config';

/**
 * Login con Microsoft (Azure AD / Entra ID).
 *
 * MSAL se usa ÚNICAMENTE para obtener el `id_token`; toda la validación (firma,
 * issuer, audiencia, tenant) ocurre en POST /auth/azure. La sesión resultante es
 * la de Bupa y se guarda en el store común (AuthService), igual que en Google:
 * este servicio no mantiene tokens propios ni un modelo de sesión paralelo.
 */
@Injectable({
  providedIn: 'root',
})
export class AuthAzureService {
  private readonly auth = inject(AuthService);
  private readonly msal = inject(MSAL_INSTANCE);

  // Debe declararse después de `msal`: bootstrap() corre al inicializar el campo.
  private readonly initialization = this.bootstrap();

  /** Cuenta de Microsoft; solo informativa (la sesión real vive en AuthService). */
  readonly account = signal<AccountInfo | null>(null);
  readonly loading = signal(false);
  readonly error = signal<string | null>(null);

  private async bootstrap(): Promise<void> {
    try {
      await this.msal.initialize();

      // Necesario para el fallback a redirect: consume la respuesta y establece la cuenta.
      // navigateToLoginRequestUrl:false → nos quedamos en /auth-azure en vez de
      // saltar a la URL donde se inició el login, que no procesa la respuesta.
      const redirectResult = await this.msal.handleRedirectPromise({
        navigateToLoginRequestUrl: false,
      });

      const activeAccount =
        redirectResult?.account ??
        this.msal.getActiveAccount() ??
        this.msal.getAllAccounts()[0] ??
        null;

      if (activeAccount) {
        this.msal.setActiveAccount(activeAccount);
      }

      this.account.set(activeAccount);

      // El redirect trae un id_token recién emitido: hay que canjearlo por la
      // sesión de Bupa antes de que el guard evalúe la ruta protegida.
      if (redirectResult?.idToken) {
        await this.exchangeWithBackend(redirectResult.idToken);
      }
    } catch (error) {
      // Un bootstrap fallido no debe romper el guard ni los componentes que lo esperan.
      this.account.set(null);

      // Cancelar en la pantalla de Microsoft vuelve con error=access_denied:
      // no es un fallo, solo se regresa al estado inicial.
      if (this.isUserCancellation(error)) {
        return;
      }

      console.error('[MSAL] Error al inicializar:', error);
      this.error.set('No fue posible iniciar sesión con Microsoft.');
    }
  }

  async initialize(): Promise<void> {
    await this.initialization;
  }

  /**
   * Navega a Microsoft en la misma pestaña. No hay valor de retorno útil: la
   * página se descarga y el flujo continúa en /auth-azure, donde bootstrap()
   * canjea el id_token por la sesión de Bupa.
   *
   * Se usa redirect y no popup porque el navegador corta la relación opener
   * entre padre y popup al rebotar por login.microsoftonline.com, y sin ella la
   * ventana padre nunca alcanza a leer la respuesta.
   */
  async login(): Promise<void> {
    this.loading.set(true);
    this.error.set(null);

    try {
      await this.initialization;

      const request: RedirectRequest = {
        scopes: AZURE_SCOPES,
        prompt: 'select_account',
        redirectUri: MSAL_REDIRECT_URI,
      };

      await this.msal.loginRedirect(request);
      // A partir de aquí la navegación ya se llevó la página: no se apaga
      // `loading` a propósito, para que el botón no parpadee antes de salir.
    } catch (error) {
      console.error('Error al iniciar sesión con Microsoft:', error);
      this.error.set('No fue posible iniciar sesión con Microsoft.');
      this.loading.set(false);
    }
  }

  /**
   * Envía el id_token a POST /auth/azure. El backend responde con accessToken,
   * refreshToken y sessionId, que AuthService.saveSession persiste.
   */
  private async exchangeWithBackend(idToken: string): Promise<boolean> {
    try {
      await firstValueFrom(this.auth.azureLogin(idToken));
      return true;
    } catch (error) {
      this.error.set(
        apiErrorMessage(error, 'No fue posible iniciar sesión con Microsoft.'),
      );
      return false;
    }
  }

  async logout(): Promise<void> {
    this.loading.set(true);
    this.error.set(null);

    try {
      await this.initialization;

      const account = this.account();

      // La sesión de Bupa se limpia antes de navegar: la página no vuelve.
      this.auth.clearSession();
      this.account.set(null);

      await this.msal.logoutRedirect({
        account: account ?? undefined,
        postLogoutRedirectUri: MSAL_REDIRECT_URI,
      });
    } catch (error) {
      console.error('Error al cerrar sesión:', error);
      this.error.set('No fue posible cerrar la sesión.');
      this.loading.set(false);
    }
  }

  /** La sesión válida es la de Bupa, no la cuenta de Microsoft. */
  isAuthenticated(): boolean {
    return this.auth.accessToken() !== null;
  }

  private isUserCancellation(error: unknown): boolean {
    if (!error || typeof error !== 'object') return false;

    const code = (error as { errorCode?: string }).errorCode?.toLowerCase() ?? '';
    return (
      code === 'user_cancelled' ||
      code === 'access_denied' ||
      code === 'interaction_in_progress'
    );
  }
}
