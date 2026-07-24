import { inject } from '@angular/core';
import { CanActivateFn, Router, UrlTree } from '@angular/router';
import { firstValueFrom, of } from 'rxjs';
import { catchError, map } from 'rxjs/operators';
import { AuthService } from './auth.service';
import { AuthAzureService } from './auth/auth.service';

/**
 * Protege rutas autenticadas soportando los TRES flujos del proyecto:
 *   1. Google / biometría  → accessToken en localStorage (signal accessToken).
 *   2. Apple (form_post)   → cookie HttpOnly, verificada con GET /auth/me.
 *   3. Microsoft (MSAL)    → id_token canjeado en POST /auth/azure; termina en (1).
 *
 * Si hay token local, deja pasar de inmediato. Si no, intenta resolver la sesión
 * por MSAL y luego por cookie; ante 401/error redirige a /login.
 */
export const authGuard: CanActivateFn = async (): Promise<boolean | UrlTree> => {
  const auth = inject(AuthService);
  const authAzure = inject(AuthAzureService);
  const router = inject(Router);

  // Sesión ya resuelta en memoria: token de Google/biometría (localStorage) o
  // usuario de Apple ya cargado por /auth/apple/success. Evita un me() redundante.
  if (auth.accessToken() || auth.currentUser()) {
    return true;
  }

  // Microsoft por redirect: el bootstrap consume el hash y canjea el id_token por
  // la sesión de Bupa. Hay que esperarlo antes de decidir, o el guard rebotaría
  // a /login mientras el POST /auth/azure sigue en vuelo.
  await authAzure.initialize();
  if (auth.accessToken() || auth.currentUser()) {
    return true;
  }

  // Sesión de Apple: se valida contra la cookie HttpOnly.
  return firstValueFrom(
    auth.me().pipe(
      map((): boolean | UrlTree => true),
      catchError(() => of(router.createUrlTree(['/login']))),
    ),
  );
};
