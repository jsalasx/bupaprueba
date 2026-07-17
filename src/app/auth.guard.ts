import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { of } from 'rxjs';
import { catchError, map } from 'rxjs/operators';
import { AuthService } from './auth.service';

/**
 * Protege rutas autenticadas soportando los DOS flujos del proyecto:
 *   1. Google / biometría → accessToken en localStorage (signal accessToken).
 *   2. Apple (form_post)   → cookie HttpOnly, verificada con GET /auth/me.
 *
 * Si hay token local, deja pasar de inmediato. Si no, intenta resolver la sesión
 * por cookie; ante 401/error redirige a /login.
 */
export const authGuard: CanActivateFn = () => {
  const auth = inject(AuthService);
  const router = inject(Router);

  // Sesión ya resuelta en memoria: token de Google/biometría (localStorage) o
  // usuario de Apple ya cargado por /auth/apple/success. Evita un me() redundante.
  if (auth.accessToken() || auth.currentUser()) {
    return true;
  }

  // Sesión de Apple: se valida contra la cookie HttpOnly.
  return auth.me().pipe(
    map(() => true),
    catchError(() => of(router.createUrlTree(['/login']))),
  );
};
