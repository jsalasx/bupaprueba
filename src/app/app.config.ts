import { ApplicationConfig, provideBrowserGlobalErrorListeners } from '@angular/core';
import { provideRouter } from '@angular/router';
import { HTTP_INTERCEPTORS, provideHttpClient } from '@angular/common/http';

import { routes } from './app.routes';
import { BearerTokenInterceptor } from './http.interceptor';
import { MSAL_INSTANCE, msalInstance } from './auth/auth.config';

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideRouter(routes),
    provideHttpClient(),
    { provide: HTTP_INTERCEPTORS, useClass: BearerTokenInterceptor, multi: true },
    { provide: MSAL_INSTANCE, useValue: msalInstance },
  ]
};
