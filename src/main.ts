import { bootstrapApplication } from '@angular/platform-browser';
import { appConfig } from './app/app.config';
import { App } from './app/app';
import { isMsalPopupCallback } from './app/auth/msal-popup-callback';

// El callback del popup de MSAL no debe arrancar la app: ver msal-popup-callback.ts.
if (!isMsalPopupCallback(window.location, window)) {
  bootstrapApplication(App, appConfig).catch((err) => console.error(err));
}
