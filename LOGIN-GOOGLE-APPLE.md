# Login con Google y con Apple — Web, iOS y Android

Guía de implementación de los flujos de autenticación social de la POC, pensada
para replicarlos en la app de Bupa. Cubre qué hace cada plataforma, qué hay que
configurar en cada consola, qué debe exponer el backend y los errores con los que
uno se topa de verdad al integrarlo.

Stack: **Angular 22 (standalone + signals) + Capacitor 8**.
`appId` / package / bundle ID: `com.drkapps.pruebabiometria`.

---

## 1. Resumen: un flujo distinto por plataforma

Ni Google ni Apple permiten autenticar dentro de un WebView embebido (que es lo
que la app *es*, en Capacitor). Por eso cada plataforma usa el mecanismo que su
SO considera seguro, y el backend termina recibiendo siempre lo mismo.

| Proveedor | Web | iOS | Android |
|---|---|---|---|
| **Google** | Google Identity Services (botón GSI) → `idToken` | OAuth PKCE en `SFSafariViewController` → `code` | Plugin nativo (Play Services) → `idToken` |
| **Endpoint** | `POST /auth/google` | `POST /auth/google/exchange` | `POST /auth/google` |
| **Apple** | Redirect de servidor (`form_post`) → cookie HttpOnly | Hoja nativa `SignInWithApple` → `identityToken` | Chrome Custom Tab → deep link → `GET /auth/me?token=` |
| **Endpoint** | `/auth/apple/login` + `GET /auth/me` | `POST /auth/apple/exchange` | `/auth/apple/login?platform=android` + `GET /auth/me?token=` |

La detección de plataforma se hace con Capacitor, no con el user agent:

```ts
isNative  = signal(Capacitor.isNativePlatform());          // iOS o Android
isAndroid = signal(Capacitor.getPlatform() === 'android'); // 'web' | 'ios' | 'android'
```

---

## 2. Google

### 2.1 Web — Google Identity Services

Sin cambios respecto a lo que ya existía: el script de GSI renderiza el botón,
devuelve un `credential` (JWT) y se postea a `POST /auth/google { idToken }`.

- Client ID: **Web** `537881986178-23dhaeonqr38trcrmj76ke6hs64j8qpk...`
- El componente hace polling hasta que `window.google` existe (15 s) y muestra un
  botón de reintento si el script no cargó.

### 2.2 iOS — OAuth PKCE + SFSafariViewController

Tampoco cambió. Se abre `accounts.google.com` con `code_challenge` S256 en el
navegador del sistema, Google devuelve el `code` al scheme invertido
`com.googleusercontent.apps.<ID>:/`, y la app lo canjea en
`POST /auth/google/exchange { code, codeVerifier, redirectUri }`.

- Client ID: **iOS** (`...-eugpuu3m6hsh5i94lfmieljjqs4lngvu`)
- El scheme está declarado en `ios/App/App/Info.plist` → `CFBundleURLSchemes`.

### 2.3 Android — plugin nativo (implementado en esta sesión)

Android usa el selector de cuentas de Google Play Services, que devuelve el
`idToken` directo y entra por **el mismo endpoint que la web**.

```bash
npm install @codetrix-studio/capacitor-google-auth --legacy-peer-deps
npx cap sync android
```

`capacitor.config.ts`:

```ts
plugins: {
  GoogleAuth: {
    scopes: ['profile', 'email'],
    serverClientId: '537881986178-23dhaeonqr38trcrmj76ke6hs64j8qpk.apps.googleusercontent.com', // client WEB
    forceCodeForRefreshToken: true,
  },
}
```

`android/app/src/main/res/values/strings.xml`:

```xml
<string name="server_client_id">537881986178-23dhaeonqr38trcrmj76ke6hs64j8qpk.apps.googleusercontent.com</string>
```

Código (`src/app/google-login-test/google-login-test.ts`):

```ts
async ngOnInit(): Promise<void> {
  if (this.isNative()) {
    GoogleAuth.initialize();   // OBLIGATORIO antes de cualquier signIn()
  }
}

onGoogleNativeClick(): void {
  if (this.isAndroid()) this.loginWithGoogleAndroid();
  else                  this.loginWithGoogleNative();   // iOS: PKCE
}

async loginWithGoogleAndroid(): Promise<void> {
  const user = await GoogleAuth.signIn();
  const idToken = user.authentication?.idToken;
  this.onGoogleIdToken(idToken);        // → POST /auth/google
}
```

### 2.4 Configuración en Google Cloud Console

Hacen falta **tres** client IDs bajo el mismo proyecto:

| Tipo | Para qué | Datos que pide |
|---|---|---|
| Web | Botón GSI + `serverClientId` de Android | Orígenes autorizados (`http://localhost:4200`, dominio de QA/prod) |
| iOS | Flujo PKCE en iOS | Bundle ID `com.drkapps.pruebabiometria` |
| Android | Autoriza la firma de la app | Package name + **SHA-1** del certificado |

El client de Android no se referencia en el código: solo autoriza la firma. El
`idToken` que llega al backend se emite con el **client web** (`serverClientId`),
así que ese es el `aud` que valida el backend en Android y web.

Obtener los SHA-1 (uno por cada certificado con el que se firme):

```bash
# debug
keytool -list -v -keystore ~/.android/debug.keystore -alias androiddebugkey -storepass android -keypass android
# release
keytool -list -v -keystore mi-app-release-key.jks -alias <alias>
```

> Si se publica con **Play App Signing**, Google re-firma el APK: hay que
> registrar además el SHA-1 que aparece en Play Console → *Integridad de la app*.
> Es la causa nº 1 de "en mi máquina funciona y en producción no".

### 2.5 Contrato con backend (Google)

| Endpoint | Body | Devuelve |
|---|---|---|
| `POST /auth/google` | `{ idToken }` | `{ accessToken, refreshToken, expiresIn?, sessionId? }` |
| `POST /auth/google/exchange` | `{ code, codeVerifier, redirectUri }` | idem |

El backend debe aceptar **más de un `aud`** al validar el `idToken`: el del
client web (web + Android) y el del client iOS si algún día iOS pasa a mandar
`idToken` en vez de `code`.

---

## 3. Apple

### 3.1 Web — redirect de servidor (`form_post`)

El navegador **navega de verdad** (no fetch) a `/auth/apple/login?platform=web`.
El backend habla con Apple, recibe el `POST` del callback, crea la sesión, setea
la cookie `blua_session` (HttpOnly, Secure, SameSite=None) y redirige a
`/auth/apple/success`, donde Angular resuelve la sesión con `GET /auth/me`
(`withCredentials: true`).

### 3.2 iOS — hoja nativa

`SignInWithApple.authorize({ clientId: APPLE_SERVICES_ID, redirectURI, scopes, nonce })`
devuelve `identityToken` + `authorizationCode`, que se postean a
`POST /auth/apple/exchange`. El `nonce` viaja en claro a la app: iOS envía su
SHA-256 a Apple y el backend valida contra el original.

### 3.3 Android — Custom Tab + deep link (implementado en esta sesión)

Android no tiene hoja nativa de Apple y **no puede usar la cookie**: la sesión
que el backend setea vive en el Custom Tab, no en el WebView de la app. Por eso
el backend devuelve el control por deep link con un `token` de un solo uso, que
la app canjea por la sesión real.

```
[App] loginWithApple()
   │  Browser.open(/auth/apple/login?platform=android)      ← Chrome Custom Tab
   ▼
[Backend] ──► Apple ──► callback (form_post) ──► crea sesión
   │  302 → com.drkapps.pruebabiometria://apple-callback?token=XYZ
   ▼
[App] appUrlOpen → Browser.close() → GET /auth/me?token=XYZ
   ▼
{ accessToken, refreshToken, sessionId, perfil } → saveSession() → /home
```

**Inicio** (`src/app/auth.service.ts`):

```ts
async loginWithApple(): Promise<void> {
  const url = `${APPLE_LOGIN_URL}?${APPLE_PLATFORM_PARAM}=${this.platform()}`; // platform=web|android

  if (Capacitor.getPlatform() === 'android') {
    await Browser.open({ url, presentationStyle: 'fullscreen' });   // NUNCA window.location.href
    return;
  }
  window.location.href = url;
}
```

**Listener de deep link** (`src/app/deep-link.service.ts`). Vive en un servicio
`providedIn: 'root'` que arranca el componente raíz (`app.ts` → `ngOnInit`), **no**
la pantalla de login: el SO puede reabrir la app en cualquier ruta o relanzarla
desde cero, y un listener atado a un componente se pierde en esos casos. Un solo
listener enruta por prefijo, porque iOS ya usaba `appUrlOpen` para Google:

```ts
async init(): Promise<void> {
  if (this.started || !Capacitor.isNativePlatform()) return;   // idempotente
  this.started = true;

  this.listener = await App.addListener('appUrlOpen',
    (event: URLOpenListenerEvent) => this.zone.run(() => this.routeIncomingUrl(event.url)));

  // Cold start: si el deep link levantó la app, appUrlOpen ya se disparó.
  const launch = await App.getLaunchUrl();
  if (launch?.url) this.zone.run(() => this.routeIncomingUrl(launch.url));
}

private routeIncomingUrl(url: string): void {
  // appUrlOpen y getLaunchUrl pueden entregar la MISMA URL en un cold start, y
  // el token es de un solo uso: el segundo canje da 401 y pisaría el éxito.
  if (this.handled.has(url)) return;
  this.handled.add(url);

  if (url.startsWith(REDIRECT_URI))    return this.handleGoogleOAuthCallback(url); // Google iOS
  if (url.startsWith(APP_URL_SCHEME))  this.handleAppleDeepLink(url);              // Apple Android
}

private handleAppleDeepLink(url: string): void {
  Browser.close().catch(() => {});
  const params = new URL(url).searchParams;
  const token  = params.get('token');
  const error  = params.get('error');
  // error → mensaje traducido; token → canje contra /auth/me
  this.auth.meWithToken(token).subscribe({ next: … , error: … });
}
```

El servicio expone `loading` / `error` / `success` como signals; la pantalla de
login los combina con su propio estado (`computed`) para mostrarlos si está
visible, pero el canje y la navegación ocurren aunque no lo esté.

**Canje del token** (`auth.service.ts`):

```ts
meWithToken(token: string): Observable<TokenSessionResponse> {
  return this.http
    .get<TokenSessionResponse>(AUTH_ME_URL, { params: new HttpParams().set('token', token) })
    .pipe(tap(res => {
      if (!res?.accessToken) throw new Error('El backend no devolvió el accessToken de la sesión.');
      this.saveSession(res);        // accessToken + refreshToken + sessionId
      // el perfil puede venir en `user` o plano en la raíz
    }));
}
```

**Manifest** (`android/app/src/main/AndroidManifest.xml`), dentro de `MainActivity`:

```xml
<intent-filter>
    <action android:name="android.intent.action.VIEW" />
    <category android:name="android.intent.category.DEFAULT" />
    <category android:name="android.intent.category.BROWSABLE" />
    <data android:scheme="com.drkapps.pruebabiometria" android:host="apple-callback" />
</intent-filter>
```

`MainActivity` debe tener `android:launchMode="singleTask"` (Capacitor ya lo pone).

### 3.4 Configuración en Apple Developer

| Elemento | Valor en la POC |
|---|---|
| App ID (iOS) | `com.drkapps.pruebabiometria` + capability *Sign in with Apple* |
| Services ID (web/Android) | `cl.bupa.blua.qa.signin` |
| Return URL | `https://api-qa.bupa.cl/portal-blua/ms-controller/auth/apple/callback` |
| Key (.p8) | Para que el backend firme el `client_secret` (caduca cada 6 meses) |

Apple **solo acepta return URLs `https://`**: no admite `http://`, ni `localhost`,
ni custom schemes. De ahí que el backend haga de intermediario y sea él quien
redirige al deep link.

### 3.5 Contrato con backend (Apple)

| Paso | Request | Respuesta esperada |
|---|---|---|
| Inicio | `GET /auth/apple/login?platform=web\|android` | 302 a Apple |
| Fin (web) | callback | 302 a `/auth/apple/success` + cookie |
| Fin (android) | callback | 302 a `com.drkapps.pruebabiometria://apple-callback?token=…` o `?error=CODE` |
| Canje | `GET /auth/me?token=…` | `{ accessToken, refreshToken, sessionId?, user? }` |
| iOS nativo | `POST /auth/apple/exchange` | `{ accessToken, refreshToken }` |

El `token` del deep link debe ser **de un solo uso y de vida corta** (≤ 60 s):
queda en el historial del Custom Tab y en los logs del SO, así que no puede ser
el accessToken.

El `aud` del `identityToken` **cambia según el origen**: en web y Android es el
Services ID (`cl.bupa.blua.qa.signin`); en iOS nativo es el Bundle ID
(`com.drkapps.pruebabiometria`). El backend tiene que aceptar los dos.

---

## 4. Problemas comunes

### Google

| Síntoma | Causa | Solución |
|---|---|---|
| `DEVELOPER_ERROR` / status **10** en Android | SHA-1 no registrado, package distinto, o falta el client de tipo Android | Registrar el SHA-1 del keystore usado (debug **y** release, más el de Play App Signing) |
| `signIn()` responde pero `idToken` es `null` | Falta `serverClientId` o se puso el client **de Android** | `serverClientId` debe ser el client **Web**, en `capacitor.config.ts` y en `strings.xml` |
| Error **12501** | El usuario cerró el selector de cuentas | Tratarlo como cancelación, no como error |
| Error **12500** | Play Services desactualizado o cuenta mal configurada en el device | Actualizar Play Services; probar en un emulador *con Google APIs* |
| `Plugin not implemented: GoogleAuth` | No se corrió `cap sync`, o falta `GoogleAuth.initialize()` | `npx cap sync android` y llamar `initialize()` antes del primer `signIn()` |
| `403 disallowed_useragent` | Se abrió el OAuth dentro del WebView | Usar el plugin nativo (Android) o `Browser` de Capacitor (iOS) — nunca `window.location` en nativo |
| El botón web no aparece | El script de GSI no cargó (red/bloqueadores) | El componente reintenta; verificar CSP y conexión |
| `origin_mismatch` en web | El origen no está en el client Web | Agregar `http://localhost:4200` y el dominio real en *Orígenes autorizados* |
| Siempre entra con la misma cuenta | El plugin recuerda la sesión | Llamar `GoogleAuth.signOut()` antes de reintentar |
| `npm install` falla con `ERESOLVE` | El plugin declara peer `@capacitor/core@^6` y el proyecto va en 8 | Instalar con `--legacy-peer-deps` (verificado: compila y funciona en Capacitor 8) |
| Backend rechaza el token con `invalid audience` | El `aud` varía por plataforma | Aceptar la lista de client IDs (web + iOS) |

### Apple

| Síntoma | Causa | Solución |
|---|---|---|
| Pantalla en blanco o `invalid_client` en Android | Se navegó el WebView en vez de abrir un Custom Tab | `Browser.open()` de Capacitor |
| El deep link no abre la app | `intent-filter` mal escrito — **ojo**: `<category android:category="DEFAULT" />` es inválido | El atributo correcto es `android:name="android.intent.category.DEFAULT"` (y `…BROWSABLE`) |
| El deep link abre la app pero no pasa nada | El listener se registró después del evento (cold start) | Complementar `appUrlOpen` con `App.getLaunchUrl()` |
| Vuelve a la app sin sesión | Se esperaba la cookie HttpOnly, que no llega al WebView | Canjear el `token` del deep link contra `GET /auth/me?token=` |
| `invalid_redirect_uri` | La return URL no coincide **exacto** con la registrada, o no es `https` | Registrar la URL del backend en el Services ID; el deep link nunca se registra en Apple |
| El nombre y el email llegan vacíos | Apple **solo** los entrega en el primer login de ese usuario | Persistirlos en el backend la primera vez. Para volver a probar: appleid.apple.com → *Seguridad* → dejar de usar Apple ID con la app |
| Error **1001** en iOS | El usuario canceló la hoja nativa | Tratarlo como cancelación |
| Error **1000** en iOS | Falta la capability *Sign in with Apple* en Xcode | Agregarla en *Signing & Capabilities* y regenerar el provisioning |
| El backend rechaza el token nativo de iOS | El `aud` es el Bundle ID, no el Services ID | Aceptar ambos |
| Funcionaba y de golpe falla en el backend | El `client_secret` de Apple expiró (máx. 6 meses) | Regenerarlo desde la key `.p8` |
| Rechazo en App Store | *Guideline 4.8*: si hay login social de terceros en iOS, Apple debe estar disponible | Mantener el botón de Apple en iOS |

---

## 5. Cómo probar

```bash
# build + sync + APK
npx ng build && npx cap sync android
cd android && ./gradlew :app:assembleDebug

# simular el deep link sin pasar por Apple
adb shell am start -W -a android.intent.action.VIEW \
  -d "com.drkapps.pruebabiometria://apple-callback?token=TOKEN_DE_PRUEBA"

# ver que el intent-filter quedó registrado
adb shell dumpsys package com.drkapps.pruebabiometria | grep -A 5 "android.intent.action.VIEW"

# logs del WebView
adb logcat | grep -i capacitor
```

En iOS, si no hay JDK en el PATH para Gradle:
`JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home"`.

---

## 6. Checklist para llevarlo a Bupa

- [ ] Tres client IDs de Google (Web, iOS, Android) en el proyecto de Bupa.
- [ ] SHA-1 de debug, de release y de Play App Signing registrados.
- [ ] `serverClientId` (client **web**) en `capacitor.config.ts` y en `strings.xml`.
- [ ] Services ID de Apple + Return URL del backend de Bupa + key `.p8` vigente.
- [ ] Backend acepta `platform=web|android` en `/auth/apple/login`.
- [ ] Backend redirige al deep link con `token` de un solo uso cuando `platform=android`.
- [ ] Backend expone `GET /auth/me?token=` devolviendo la sesión completa.
- [ ] Backend valida los múltiples `aud` de Google y de Apple.
- [ ] `intent-filter` del scheme en el `AndroidManifest.xml` con `android:name` (no `android:category`).
- [ ] Scheme de la app en `Info.plist` si iOS también va a recibir el deep link
      (hoy no: iOS usa la hoja nativa).

### Pendientes de confirmar con backend

1. **Nombre del query param de plataforma**: se usó `platform`. Si el backend
   espera otra grafía, se cambia solo `APPLE_PLATFORM_PARAM` en
   `src/app/apple-auth.config.ts`.
2. **Nombres de los params del deep link**: se asumió `token` / `error`.
   Centralizados en `handleAppleDeepLink()`.
3. **`GET /auth/me?token=`**: hoy sale sin el bearer público de Bupa, porque el
   interceptor omite el `Authorization` para todas las URLs que empiezan por
   `/auth/me` (era el flujo de cookie). Si el endpoint lo exige, es una línea en
   `src/app/http.interceptor.ts`.

---

## 7. Archivos tocados en esta sesión

| Archivo | Cambio |
|---|---|
| `src/app/deep-link.service.ts` | **Nuevo.** Listener único de deep links en el root injector: enruta Apple (Android) y Google (iOS), deduplica URLs y expone el estado como signals |
| `src/app/google-auth.config.ts` | **Nuevo.** Client IDs de Google y `REDIRECT_URI` del flujo PKCE, compartidos entre el componente y el servicio |
| `src/app/app.ts` | Arranca `DeepLinkService.init()` en `ngOnInit` |
| `src/app/google-login-test/google-login-test.ts` | Login nativo de Google en Android; delega los callbacks por URL scheme en `DeepLinkService` y combina su estado con el propio |
| `src/app/auth.service.ts` | `loginWithApple()` con `platform=` y Custom Tab en Android; `meWithToken()`; tipo `TokenSessionResponse` |
| `src/app/apple-auth.config.ts` | `APPLE_PLATFORM_PARAM`, `APP_URL_SCHEME`, `APPLE_DEEP_LINK_URL` |
| `src/app/google-login-test/google-login-test.html` | El botón nativo llama a `onGoogleNativeClick()` |
| `src/app/http.interceptor.ts` | Comentario del caso `/auth/me?token=` |
| `android/app/src/main/AndroidManifest.xml` | Corregido el `intent-filter` del deep link (`android:name`) |
| `package.json` | `@codetrix-studio/capacitor-google-auth` |
