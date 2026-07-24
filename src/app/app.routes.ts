import { Routes } from '@angular/router';
import { GoogleLoginTest } from './google-login-test/google-login-test';
import { Biometria } from './biometria/biometria';
import { Home } from './home/home';
import { AppleSuccess } from './auth/apple-success/apple-success';
import { AppleError } from './auth/apple-error/apple-error';
import { AzureSuccess } from './auth/azure-success/azure-success';
import { authGuard } from './auth.guard';

export const routes: Routes = [
  { path: '', redirectTo: 'login', pathMatch: 'full' },
  { path: 'login', component: GoogleLoginTest },
  { path: 'biometria', component: Biometria, canActivate: [authGuard] },
  { path: 'home', component: Home, canActivate: [authGuard] },
  // Rutas del callback de Apple (deben coincidir con las URLs registradas en el backend).
  { path: 'auth/apple/success', component: AppleSuccess },
  { path: 'auth/apple/error', component: AppleError },
  // Ruta de callback de Microsoft/Azure AD (debe coincidir con el redirectUri de auth.config.ts).
  { path: 'auth-azure', component: AzureSuccess },
];
