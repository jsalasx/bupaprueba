import { Routes } from '@angular/router';
import { GoogleLoginTest } from './google-login-test/google-login-test';
import { Biometria } from './biometria/biometria';
import { Home } from './home/home';
import { AppleSuccess } from './auth/apple-success/apple-success';
import { AppleError } from './auth/apple-error/apple-error';
import { AzureSuccess } from './auth/azure-success/azure-success';
import { MedicoLogin } from './auth/medico-login/medico-login';
import { HomeMedicos } from './medicos/home-medicos';
import { ChatRoom } from './chat/chat-room';
import { ChatHistory } from './chat/chat-history';
import { authGuard } from './auth.guard';

export const routes: Routes = [
  { path: '', redirectTo: 'login', pathMatch: 'full' },

  // Ingreso de PACIENTES: Google, Apple, Microsoft, biometría, passkey y OTP.
  { path: 'login', component: GoogleLoginTest },

  // Ingreso del EQUIPO MÉDICO con la cuenta corporativa de Bupa. Pantalla aparte
  // porque la vía de entrada determina el tipo de usuario en el backend.
  { path: 'login/medicos', component: MedicoLogin },

  { path: 'biometria', component: Biometria, canActivate: [authGuard] },

  // Home del paciente: abre consultas y entra a las suyas.
  { path: 'home', component: Home, canActivate: [authGuard] },

  // Home del equipo médico: cola, propios y panel con filtros.
  { path: 'home/medicos', component: HomeMedicos, canActivate: [authGuard] },

  // Conversación de un requerimiento. Sirve a paciente y médico: quién puede hacer
  // qué lo decide el rol que devuelve el backend, no la ruta.
  { path: 'chat/:ticketId/history', component: ChatHistory, canActivate: [authGuard] },
  { path: 'chat/:ticketId', component: ChatRoom, canActivate: [authGuard] },

  // Rutas del callback de Apple (deben coincidir con las URLs registradas en el backend).
  { path: 'auth/apple/success', component: AppleSuccess },
  { path: 'auth/apple/error', component: AppleError },
  // Ruta de callback de Microsoft/Azure AD (debe coincidir con el redirectUri de auth.config.ts).
  { path: 'auth-azure', component: AzureSuccess },
];
