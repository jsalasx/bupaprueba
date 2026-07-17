import { Injectable } from '@angular/core';
import {
  HttpInterceptor,
  HttpRequest,
  HttpHandler,
  HttpEvent,
} from '@angular/common/http';
import { Observable } from 'rxjs';
import { AUTH_ME_URL } from './apple-auth.config';

@Injectable()
export class BearerTokenInterceptor implements HttpInterceptor {
  private readonly PUBLIC_TOKEN =
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJhdWQiOiJwdWJsaWMiLCJleHAiOjE3ODM1MzQ2NzQsImlhdCI6MTc4MzUyNTY3NCwiaXNzIjoicHVibGljIiwianRpIjoiNGY5Y2UyMGEtZWQxMy00YyIsInB1YmxpY0tleSI6IjRmOWNlMjBhLWVkMTMtNGMiLCJyb2xlcyI6IldfcmtoWlA3dG84Mk5mcGlaVExhSGc9PSIsInNpdGUiOiJwdWJsaWMiLCJzdWIiOiIwMDAwMDAwMDAwMDAwMDAwYzZkMTliNTQxMzliNGE1NGUzNzkxMjg4ZmYxNTYzYTEiLCJ1c2VybmFtZSI6IjJENnpjYzcxTnZBT1dvVlVKMkZpVTBTcTR0TT0ifQ.NjhyKDMuwUXz7trjnbIHk33Kv7Vnj9VwdqoufJ2hFq8';

  intercept(
    req: HttpRequest<any>,
    next: HttpHandler,
  ): Observable<HttpEvent<any>> {
    // Flujo Apple (form_post): la sesión viaja en una cookie HttpOnly cross-site.
    // /auth/me comparte base con los endpoints de Google/biometría, así que se
    // discrimina por la URL exacta: se apoya en la cookie (withCredentials) y
    // NO lleva el bearer público de Bupa (nada de headers manuales de sesión).
    if (req.url.startsWith(AUTH_ME_URL)) {
      return next.handle(req.clone({ withCredentials: true }));
    }

    const clonedReq = req.clone({
      setHeaders: {
        Authorization: `Bearer ${this.PUBLIC_TOKEN}`,
      },
    });

    return next.handle(clonedReq);
  }
}
