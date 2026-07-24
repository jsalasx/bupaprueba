import { InjectionToken } from '@angular/core';
import {
  BrowserCacheLocation,
  Configuration,
  IPublicClientApplication,
  PublicClientApplication,
} from '@azure/msal-browser';

const origin = 'http://localhost:4200';

/**
 * Tenant de Entra ID contra el que se autentica el portal.
 * Debe ser el MISMO tenant/client que el backend tiene en `configuration.yaml`;
 * si la app móvil usa otro App Registration, ese client ID va en
 * `azure.allowedAudiences` del backend. Con un tenant distinto al configurado,
 * /auth/azure responde 401 INVALID_AZURE_TOKEN.
 */
export const AZURE_TENANT_ID = '1e4032ef-895c-458c-acaa-ca68f91eb191';

/** Application (client) ID del App Registration del portal web. */
export const AZURE_CLIENT_ID = 'ad7a9fd1-a7db-4251-832c-cdbebab2077f';

/** Scopes mínimos para obtener el id_token; el access_token de Microsoft no se usa. */
export const AZURE_SCOPES = ['openid', 'profile', 'email'];

/**
 * Ruta donde aterriza el flujo redirect, registrada en el App Registration.
 * Es puramente del front: el backend no participa en este redirect.
 */
export const MSAL_REDIRECT_URI = `${origin}/auth-azure`;

const msalConfig: Configuration = {
  auth: {
    clientId: AZURE_CLIENT_ID,

    // Tenant específico: solo cuentas de la organización.
    authority: `https://login.microsoftonline.com/${AZURE_TENANT_ID}`,

    redirectUri: MSAL_REDIRECT_URI,

    postLogoutRedirectUri: MSAL_REDIRECT_URI,
  },
  cache: {
    // localStorage y no sessionStorage: el flujo redirect sale del sitio y vuelve,
    // y la respuesta debe poder emparejarse con el request que la originó.
    cacheLocation: BrowserCacheLocation.LocalStorage,
  },
};

export const msalInstance = new PublicClientApplication(msalConfig);

/**
 * MSAL se inyecta en vez de importarse directo para poder sustituirlo en tests
 * (toca window.location y sessionStorage, que jsdom no puede ejecutar).
 */
export const MSAL_INSTANCE = new InjectionToken<IPublicClientApplication>(
  'MSAL_INSTANCE',
);
