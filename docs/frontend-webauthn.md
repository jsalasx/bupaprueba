# FIDO2 / WebAuthn (passkeys) — cliente Angular + Capacitor

Estado: **registro de passkey implementado**. Login sin contraseña y gestión de dispositivos
tienen el cliente HTTP y el mapper de errores listos, pero aún no tienen UI.

Base path del backend: `/portal-blua/ms-controller` (`environment.apiBaseUrl`).

---

## 1. Estructura de archivos por capa

```
src/app/webauthn/
├── base64url.util.ts                  # base64url ↔ ArrayBuffer (+ .spec.ts)
├── webauthn.dto.ts                    # DTOs = JSON del backend tal cual + mapper a dominio
├── webauthn-error.mapper.ts           # code → mensaje + estrategia de recuperación (+ .spec.ts)
├── webauthn.service.ts                # HTTP: los 7 endpoints (+ .spec.ts)
├── webauthn-platform.service.ts       # interfaz WebAuthnPlatform + rama web + rama nativa
├── webauthn-registration.store.ts     # máquina de estados de la ceremonia (+ .spec.ts)
└── passkey-register-button/           # componente de presentación (input()/output(), sin store)
```

Flujo: **componente → store → service (HTTP) → DTO/mapper**. Ningún componente habla HTTP directo;
el botón es un dumb component que recibe estado por `input()` y emite por `output()`.

Integración: `src/app/biometria/` es el contenedor. El botón de biometría nativa
(`activateBiometrics()`, token biométrico en Keychain) **no se tocó**: el de passkey es un botón
nuevo e independiente, y si la plataforma no soporta passkeys ni se pinta.

`provideWebAuthnPlatform()` en `app.config.ts` resuelve la rama por `Capacitor.isNativePlatform()`.

---

## 2. Plugin nativo: decisión

**Elegido: `@capgo/capacitor-passkey` (v8.4.0).**

Por qué hace falta un plugin y no basta `navigator.credentials`: en el WebView de Capacitor el origen
es `capacitor://localhost` (iOS) / `http://localhost` (Android). No coincide con el RPID del portal y
el backend valida `Origin`, así que toda ceremonia hecha desde el WebView falla en `finish`. No es
una optimización: la ruta nativa es la única que funciona en la app.

Por qué este y no otro:
- Delega en las APIs correctas — `ASAuthorizationPlatformPublicKeyCredentialProvider`
  (AuthenticationServices, iOS 16+) y `CredentialManager` (Android 14+ / Play Services).
- Trabaja con el **mismo JSON base64url** que ya usa el backend, así que en la rama nativa no hay
  conversión de buffers: se pasa `publicKey` tal cual llega de `begin` y se manda la respuesta tal
  cual a `finish`. Menos superficie donde romper el contrato.
- Peer `@capacitor/core >=8.0.0`, alineado con el 8.4.1 del proyecto.
- Mismo mantenedor (Capgo) que `@capgo/capacitor-native-biometric`, que ya está en el proyecto.
- La alternativa `capacitor-webauthn@8.0.0` tiene la misma compatibilidad, pero vive en un GitLab
  anónimo (`dev3374917`) sin trayectoria. Descartada por procedencia.
- Un plugin propio sería ~400 líneas de Swift + Kotlin para reimplementar exactamente esto.

**Pendiente de instalar** (el proyecto compila sin él; `isAvailable()` devuelve `false` y el botón
se oculta en la app hasta entonces):

```bash
npm i @capgo/capacitor-passkey --legacy-peer-deps   # ver §2.1
npx cap sync
```

El acceso es vía `registerPlugin<NativePasskeyPlugin>('CapacitorPasskey')` para que la ausencia del
paquete no rompa el build. La interfaz `NativePasskeyPlugin` de `webauthn-platform.service.ts` está
verificada contra los `.d.ts` de la v8.4.0: `isSupported()`, `createCredential({ publicKey })`,
`getCredential({ publicKey })`.

El plugin también ofrece `shimWebAuthn()`, que parchea `navigator.credentials` globalmente. **No lo
usamos**: la llamada directa deja la rama nativa explícita y evita monkey-patching. Si en iOS 17.4+
hiciera falta forzar el origin del `clientDataJSON`, ambos métodos aceptan un `origin?` opcional.

### 2.1 El ERESOLVE al instalar

`npm i` falla con un conflicto **preexistente**, ajeno a este plugin:
`@codetrix-studio/capacitor-google-auth@3.4.0-rc.4` declara peer `@capacitor/core@^6.0.0` y el
proyecto tiene 8.4.1. El árbol actual se armó saltándose esa validación, y cualquier `npm i` la
vuelve a disparar.

Salida inmediata: `--legacy-peer-deps`. Arreglo de fondo: subir `capacitor-google-auth` a una versión
con peer de Capacitor 8, o migrar a `@capgo/capacitor-social-login`. Conviene resolverlo aparte,
porque hoy el login con Google corre sobre una combinación que npm considera inválida.

---

## 3. Orígenes por ambiente para `webauthn.rpOrigins`

⚠️ **Esto es lo que hay que entregar a backend antes de probar en dispositivo.** El `origin` que el
sistema operativo escribe en el `clientDataJSON` no es el mismo en web, iOS y Android. Si falta
alguno en `configuration.yaml`, **todos los `finish` de esa plataforma fallan** — es la causa más
típica de fallo en ambiente desplegado.

### Web
El origen es la URL exacta del portal (esquema + host + puerto), sin path:

| Ambiente | Origin | rpId |
|---|---|---|
| Local | `http://localhost:4200` | `localhost` |
| QA | `https://<host-qa-del-portal>` | `<host-qa-del-portal>` |
| Producción | `https://<host-prod-del-portal>` | `<host-prod-del-portal>` |

> Los hosts del portal (no los de la API) faltan por confirmar. `environment.ts` sólo tiene las bases
> de API: hoy un ngrok para dev y `api-qa.bupa.cl` para Apple.

### iOS
iOS envía `https://<rpId>` — **el mismo string que el origin web de ese ambiente**. No hay un origin
extra que cargar, pero sí depende de Associated Domains (§4).

Bundle ID: `com.drkapps.pruebabiometria` · Team ID: `BTZNNA839U`
*(valores del proyecto de prueba actual; reemplazar por los del portal real)*

### Android
Android envía `android:apk-key-hash:<sha256-base64url>`, donde el hash es el del **certificado de
firma de cada variante**. Hay que cargar uno por variante:

```
android:apk-key-hash:<sha256-base64url-debug>
android:apk-key-hash:<sha256-base64url-staging>
android:apk-key-hash:<sha256-base64url-release>
```

**Debug (obtenido el 2026-07-28 del `~/.android/debug.keystore` del equipo de Alejandro):**

```
android:apk-key-hash:MR6TRKEdNdBbG7sL7oTBaJ__-LeH41uxbdJo7WHU4ho
```

Hex equivalente, para `assetlinks.json`:
```
31:1E:93:44:A1:1D:35:D0:5B:1B:BB:0B:EE:84:C1:68:9F:FF:F8:B7:87:E3:5B:B1:6D:D2:68:ED:61:D4:E2:1A
```

⚠️ `debug.keystore` se genera **por máquina y por usuario**. Cada dev que compile en local tendrá un
hash distinto, y todos deben estar en `rpOrigins` para que puedan probar. Staging y release siguen
pendientes.

Cómo obtener los demás:

```bash
# Opción GUI: Android Studio → panel Gradle → app → Tasks → android → signingReport
#   (lista SHA-1 y SHA-256 de todas las variantes de una vez)

# Opción terminal, con el JDK que trae Android Studio:
KEYTOOL="/Applications/Android Studio.app/Contents/jbr/Contents/Home/bin/keytool"

"$KEYTOOL" -list -v -keystore ~/.android/debug.keystore -alias androiddebugkey \
           -storepass android -keypass android | grep SHA256

"$KEYTOOL" -list -v -keystore mi-app-release-key.jks -alias <alias> | grep SHA256

# hex → base64url (lo que espera el backend en rpOrigins)
echo "AA:BB:CC:...:FF" | tr -d ':' | xxd -r -p | openssl base64 -A \
  | tr '+/' '-_' | tr -d '='
```

Si la app se publica con **Play App Signing**, el hash de release NO es el del `.jks` local sino el
del certificado que administra Google: sale de Play Console → *Setup → App signing → App signing key
certificate → SHA-256*.

Application ID: `com.drkapps.pruebabiometria` *(reemplazar por el del portal real)*

---

## 4. Requisitos para el equipo de plataforma

### iOS — Associated Domains
1. Entitlement en el target de la app:
   ```xml
   <key>com.apple.developer.associated-domains</key>
   <array>
     <string>webcredentials:<host-del-portal></string>
   </array>
   ```
   *(el proyecto iOS no tiene archivo `.entitlements` todavía — hay que crearlo)*
2. Publicar en el dominio del portal, servido por **HTTPS y con `Content-Type: application/json`**,
   sin redirects:
   ```
   https://<host-del-portal>/.well-known/apple-app-site-association
   ```
   ```json
   { "webcredentials": { "apps": ["BTZNNA839U.com.drkapps.pruebabiometria"] } }
   ```

### Es obligatorio en TODOS los ambientes

`assetlinks.json` (Android) y `apple-app-site-association` (iOS) son requisito del sistema
operativo, no un atajo de desarrollo: sin ellos la app nativa no puede usar passkeys. No hay flag ni
modo desarrollador que lo evite. Es el mismo mecanismo que ya se usa para Google Sign-In (SHA-1 en
Google Cloud Console) y Apple.

Un archivo **por dominio**, con contenido distinto por ambiente:

| Ambiente | `rpId` | Archivo en | Fingerprints |
|---|---|---|---|
| Dev (ngrok) | host del túnel | `https://<túnel>/.well-known/` | debug de cada dev |
| QA | host QA del portal | `https://<qa>/.well-known/` | debug + staging |
| Prod | host prod del portal | `https://<prod>/.well-known/` | **solo release** / Play App Signing |

⚠️ **Nunca incluir el hash de debug en producción.** Los `debug.keystore` viven sin proteger en el
home de cada dev y con contraseña pública (`android`): quien tenga uno podría compilar una app que
use las passkeys de usuarios reales. Lo mismo aplica a `webauthn.rpOrigins` del `configuration.yaml`
de prod.

Es configuración de **una sola vez** por ambiente: se publica el archivo estático y solo se toca
cuando entra una firma nueva (un dev nuevo, o rotación del certificado de release).

### Android — Digital Asset Links
Publicar en el dominio del portal, un objeto por variante de firma
(plantilla lista con los valores actuales en [`assetlinks.json`](./assetlinks.json)):
```
https://<host-del-portal>/.well-known/assetlinks.json
```
```json
[{
  "relation": ["delegate_permission/common.get_login_creds"],
  "target": {
    "namespace": "android_app",
    "package_name": "com.drkapps.pruebabiometria",
    "sha256_cert_fingerprints": ["<SHA256-hex-con-dos-puntos>"]
  }
}]
```

### Kong — riesgo abierto
Confirmar que **Kong no reescribe ni elimina el header `Origin`** hacia el ms-controller. Si lo
altera, el backend compara contra un origin distinto del que firmó el autenticador y `finish` falla
con `webauthn_assertion_invalid` en el ambiente desplegado aunque funcione en local. Se verifica
mirando el `Origin` que recibe el microservicio en un `begin`/`finish` real de QA.

---

## 4.1 Discrepancias detectadas contra el contrato (para backend)

Verificadas en QA el 2026-07-28 con un `register/begin` real (200, email `joal.sala@gmail.com`).

### a) `begin` anida las opciones un nivel más de lo documentado

El contrato dice `{ ceremonyId, publicKey: PublicKeyCredentialCreationOptions }`. Lo que llega es:

```json
{ "ceremonyId": "…", "publicKey": { "publicKey": { "rp": …, "challenge": … } } }
```

Es el `protocol.CredentialCreation` de go-webauthn serializado tal cual, que trae su propio campo
`publicKey`. Sin aplanar, el plugin nativo falla con `DataError: requestJson is required` porque no
encuentra el `challenge` en el nivel esperado.

El cliente lo absorbe en `unwrapOptions` (`webauthn.dto.ts`), que acepta las dos formas y detecta el
envoltorio por ausencia de `challenge`. **No hace falta que backend cambie nada**, pero conviene
alinear la documentación del contrato con lo que realmente emite — o devolver
`credentialCreation.Response` en vez del struct completo, y ahí el cliente sigue funcionando igual.

### b) `rp.id` es `localhost` — bloqueante en móvil

```json
"rp": { "name": "Blua Salud Digital", "id": "localhost" }
```

En navegador `localhost` está exento por spec y funciona. En **iOS y Android no**: el sistema
operativo exige validar el rpId contra `apple-app-site-association` / `assetlinks.json` servidos por
HTTPS en ese dominio, y `localhost` no es un dominio verificable. La ceremonia va a fallar en el
dispositivo pase lo que pase del lado del cliente.

Para probar en móvil hace falta que `webauthn.rpId` apunte al host real del portal por ambiente (QA,
prod), con los `rpOrigins` de §3 cargados y los archivos de §4 publicados. Un túnel ngrok no sirve
como rpId: cambia de host en cada arranque e invalida las credenciales ya registradas.

## 5. Restricciones que condicionan la UX (ya implementadas)

| Restricción del backend | Cómo la respeta el cliente |
|---|---|
| `ceremonyId` de un solo uso, desafío de 60 s | Ante `webauthn_challenge_invalid` el store vuelve a `begin`; nunca reintenta con el mismo id |
| `userVerification: required` | La ceremonia siempre exige Face ID / Touch ID / huella / PIN |
| Máximo 10 credenciales | `webauthn_credential_limit` deriva a gestión de dispositivos |
| 10 ceremonias por identidad / 60 s | Un 429 pasa el store a `cooldown` con el botón bloqueado y contador; `busy()` evita dobles clicks |
| Ambigüedad deliberada en 401 | `assertion_invalid` y `credential_invalid` comparten el mensaje genérico "No pudimos verificar tu dispositivo" |

Además:
- Nada de la ceremonia se persiste: `ceremonyId` y `challenge` viven en variables locales.
- No se loguea `clientDataJSON`, `signature`, tokens ni `credentialId` completos.
- `NotAllowedError` (cancelación o timeout) es cancelación silenciosa: vuelve a `idle` sin error rojo.
- Passkeys es un método **adicional**: Google, Apple, Azure, OTP y la biometría nativa siguen intactos
  y siempre visibles.

---

## 6. Pendiente

- [ ] `npm i @capgo/capacitor-passkey --legacy-peer-deps && npx cap sync`
- [ ] Resolver el peer inválido de `@codetrix-studio/capacitor-google-auth` (§2.1)
- [ ] Confirmar hosts del portal por ambiente y entregar la lista de §3 a backend
- [ ] `apple-app-site-association` + entitlement iOS
- [ ] `assetlinks.json` con las 3 huellas
- [ ] Verificar el header `Origin` a través de Kong
- [ ] **Captcha del login**: hoy el backend tiene la validación de `X-Forms-Captcha` **apagada**, y
      el cliente manda `environment.captchaTestToken` (`'test-captcha-token'`). Cuando se encienda,
      basta poner la site key del portal en `environment.recaptchaSiteKey`: `CaptchaService` carga
      reCAPTCHA v3 y pide un token real por ceremonia (acción `webauthn_login`). No hay que tocar el
      store ni los componentes. Este proyecto no tenía reCAPTCHA en ningún otro endpoint público, así
      que no existía un mecanismo previo al que engancharse.
- [ ] UI de gestión de dispositivos (listar / renombrar / revocar con confirmación; manejar el caso
      de revocar la credencial del dispositivo actual, que corta la sesión en curso)
