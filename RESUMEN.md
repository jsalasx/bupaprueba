# Resumen del proyecto — bupaprueba

POC de autenticación con Google Sign-In y biometría nativa (Face ID / Touch ID) en una app Angular + Capacitor para iOS.

---

## Stack

| Capa | Tecnología |
|---|---|
| Framework web | Angular 22 (standalone components, signals) |
| Runtime nativo | Capacitor 8 |
| Plataforma objetivo | iOS (iPad / iPhone) |
| Biometría | `@capgo/capacitor-native-biometric` v8 |
| OAuth navegador seguro | `@capacitor/browser` (SFSafariViewController) |
| Deep links | `@capacitor/app` (appUrlOpen) |
| Backend | Spring Boot en `192.168.100.211:8080` |

---

## Flujo de autenticación implementado

```
┌─────────────────────────────────────────────────────────────┐
│ PRIMER LOGIN                                                │
│                                                             │
│  /login ──[Google]──► SFSafariViewController               │
│                              │                              │
│                    OAuth PKCE + code                        │
│                              │                              │
│         deep link: com.googleusercontent.apps.xxx:/         │
│                              │                              │
│     POST /auth/google/exchange { code, codeVerifier }       │
│                              │                              │
│                   { accessToken, refreshToken }             │
│                              │                              │
│  /biometria ──[Activar]──► verifyIdentity (Face ID)        │
│                              │                              │
│     POST /auth/biometric/register { deviceId }              │
│                              │                              │
│              { biometricToken }  ──► Keychain iOS           │
│                              │                              │
│  /home                                                      │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│ LOGINS SIGUIENTES                                           │
│                                                             │
│  /login ──[Biometría]──► verifyIdentity (Face ID)          │
│                              │                              │
│           getCredentials ◄── Keychain iOS                   │
│           { biometricToken, deviceId }                      │
│                              │                              │
│     POST /auth/biometric/token { biometricToken, deviceId } │
│                              │                              │
│                   { accessToken, refreshToken }             │
│                              │                              │
│  /home                                                      │
└─────────────────────────────────────────────────────────────┘
```

---

## Archivos creados / modificados

### Nuevos
| Archivo | Propósito |
|---|---|
| `src/app/auth.service.ts` | Servicio central: tokens, deviceId, llamadas HTTP a los 4 endpoints de auth |
| `src/app/pkce.util.ts` | Utilidades PKCE: `generateCodeVerifier`, `generateCodeChallenge`, `generateState` |
| `src/app/biometria/biometria.ts/html/css` | Página de activación biométrica |
| `src/app/home/home.ts/html/css` | Página de inicio post-login |

### Modificados
| Archivo | Qué cambió |
|---|---|
| `src/index.html` | `async` → `defer` en el script de Google GSI |
| `src/app/app.html` | Botón flotante "Recargar" + solo `<router-outlet>` |
| `src/app/app.ts` | Eliminado import directo de `GoogleLoginTest`, agregado `reload()` |
| `src/app/app.routes.ts` | Rutas: `/login`, `/biometria`, `/home` |
| `src/app/google-login-test/google-login-test.ts` | Flujo nativo PKCE + web GSI + login biométrico |
| `ios/App/App/Info.plist` | URL scheme para deep link OAuth de Google |
| `ios/App/App/capacitor.config.json` | `appId` actualizado |
| `capacitor.config.ts` | `appId` actualizado |

---

## Endpoints de backend requeridos

Servidor base: `http://192.168.100.211:8080/portal-blua/ms-controller`

### `POST /auth/google`
Login con Google Identity Services (flujo web).
```json
// Request
{ "idToken": "eyJ..." }

// Response
{ "accessToken": "...", "refreshToken": "...", "expiresIn": 3600 }
```

### `POST /auth/google/exchange`
Intercambio de authorization code PKCE (flujo nativo iOS).
```json
// Request
{ "code": "4/0Adkv...", "codeVerifier": "abc123...", "redirectUri": "com.googleusercontent.apps.xxx:/" }

// Response
{ "accessToken": "...", "refreshToken": "...", "expiresIn": 3600 }
```

### `POST /auth/biometric/register`
Genera un `biometricToken` de larga duración (90 días) para el dispositivo.
Requiere `Authorization: Bearer <accessToken>`.
```json
// Request
{ "deviceId": "uuid-generado-en-app" }

// Response
{ "biometricToken": "hex64chars...", "deviceId": "...", "expiresIn": 7776000 }
```
> Backend almacena solo `SHA256(biometricToken)`, nunca en claro.

### `POST /auth/biometric/token`
Login biométrico: intercambia `biometricToken` por nuevos tokens de sesión.
```json
// Request
{ "biometricToken": "hex64chars...", "deviceId": "uuid..." }

// Response
{ "accessToken": "...", "refreshToken": "...", "expiresIn": 3600 }
```

---

## Configuración Google Cloud Console

| Tipo de cliente | Uso |
|---|---|
| **Web** — `537881986178-23dhaeonqr38trcrmj76ke6hs64j8qpk` | Botón GSI en el navegador |
| **iOS** — `537881986178-eugpuu3m6hsh5i94lfmieljjqs4lngvu` | Flujo PKCE nativo en iPad/iPhone |

El cliente iOS tiene como Bundle ID registrado: `com.drkapps.pruebabiometria`.
No necesita redirect URI manual — Google lo infiere del reverse client ID:
`com.googleusercontent.apps.537881986178-eugpuu3m6hsh5i94lfmieljjqs4lngvu`

---

## Problemas encontrados y soluciones

### 1. Botón de Google no aparecía en la primera carga (web y iPad)

**Causa:** El script de Google tenía `async` en `index.html`. Angular arrancaba antes de que el script terminara de cargar. Al recargar el navegador, el script ya estaba en caché y llegaba primero.

**Solución:**
- Cambiar `async` → `defer` en `index.html` para garantizar que el script ejecute antes de que Angular arranque.
- Añadir polling defensivo en el componente (`setInterval` cada 200ms, máximo 15s) como red de seguridad para iOS WebView (WKWebView tiene timing diferente al navegador).
- Cambiar `ngOnInit` → `AfterViewInit` para garantizar que `#google-btn` existe en el DOM antes de llamar `renderButton`.
- Mostrar spinner mientras carga y botón de reintento si falla.

---

### 2. Pop-up de OAuth pequeño en iPad

**Causa:** `Browser.open()` se llamaba con `presentationStyle: 'popover'`, que en iPad muestra una ventana flotante pequeña.

**Solución:** Cambiar a `presentationStyle: 'fullscreen'`.

---

### 3. Error al añadir redirect URI en Google Cloud Console

**Causa:** Se intentó añadir `com.drkapps.pruebabiometria://auth/callback` como redirect URI en un cliente OAuth de tipo **Web**. Google no permite esquemas personalizados (`com.xxx://`) en clientes web, solo `http://` y `https://`.

**Solución:** Crear un cliente OAuth de tipo **iOS** en Google Cloud Console con el Bundle ID de la app. Google genera automáticamente el reverse client ID como URL scheme permitido (`com.googleusercontent.apps.CLIENT_ID:/`). No requiere registrar redirect URIs manualmente.

---

### 4. `KeychainError error 1` al hacer login biométrico

**Causa raíz identificada en logs de Xcode:**

```
setCredentials ✓   ← credencial guardada correctamente
deleteCredentials  ← borraba lo que se acababa de guardar
App addListener    ← login se volvía a montar
getCredentials → KeychainError  ← no encontraba nada
```

Dos bugs combinados:

**Bug A — `biometria.ts` mezclaba `async/await` con `.subscribe()`:**
`setCredentials` estaba dentro de un callback `next: async (res) => {}` sin `try/catch`. Si lanzaba error, se perdía silenciosamente. Si el backend fallaba, el usuario podía tocar "Ahora no, ir al inicio" y llegar al home sin credenciales guardadas.

**Bug B — `home.ts logout()` borraba el Keychain:**
El método `logout()` llamaba `NativeBiometric.deleteCredentials()`. Esto es incorrecto: cerrar sesión debe limpiar solo los tokens de acceso (localStorage), nunca las credenciales biométricas del Keychain. Con el `delay(1200)` que había en biometria antes de navegar, había una ventana de 1.2 segundos donde el botón rojo "Cerrar sesión" en home podía tocarse accidentalmente, desencadenando el borrado.

**Soluciones:**
- Reescribir `biometria.ts` con `firstValueFrom` para convertir todo a `async/await` con un único `try/catch/finally`.
- Si el backend `/auth/biometric/register` aún no está implementado, guardar el `accessToken` como fallback en lugar de fallar.
- Eliminar `deleteCredentials` de `logout()` — las credenciales biométricas deben sobrevivir entre sesiones.
- Eliminar el `delay(1200)` antes de navegar a home — navegar inmediatamente tras guardar.
- En el login biométrico, llamar `getCredentials` **antes** de mostrar Face ID. Si no hay credenciales, mostrar mensaje claro sin activar el sensor biométrico.

---

## Notas para producción

- El `biometricToken` del backend debe almacenarse solo como `SHA256(token)` en base de datos.
- El `accessToken` (fallback de desarrollo) tiene vida corta (~1h). Para producción el backend debe implementar `/auth/biometric/register` y `/auth/biometric/token`.
- Agregar botón "Desactivar biometría" en perfil de usuario (ese sí debe llamar `deleteCredentials`, con confirmación explícita).
- Considerar route guards en Angular para proteger `/home` y `/biometria` contra acceso sin sesión activa.
- El `deviceId` se genera con `crypto.randomUUID()` y persiste en `localStorage`. Si el usuario desinstala la app, se pierde y debe re-registrar biometría.
