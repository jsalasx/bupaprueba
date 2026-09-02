# Probar el chat clínico en local

Guía para levantar el flujo completo: paciente abre una consulta → el médico la ve
y la toma → conversan.

## 1. Backend

El front apunta a `http://localhost:8080`. Los endpoints de tickets y panel viven
en la rama `015-ticket-workflow-panel` del repo `portal-blua-ms-controller` y
**todavía no están en QA**, así que hay que correrlo en local.

```bash
cd ~/GitHub/portal-blua-ms-controller
git checkout 015-ticket-workflow-panel
CONFIG=$PWD/configuration.yaml go run main.go
```

Debe quedar escuchando en `:8080`. Compruébalo:

```bash
curl -i http://localhost:8080/portal-blua/ms-controller/healthcheck
```

### ⚠️ Falta la credencial de ACS

En `configuration.yaml` quedó añadida la sección `chat:` con un **placeholder**:

```yaml
chat:
  acs:
    connectionString: "endpoint=https://<recurso>.communication.azure.com/;accesskey=<clave>"
```

Sin la cadena real, todo lo demás funciona (listar, filtrar, panel), pero **crear un
requerimiento y conversar dan 502 `CHAT_UPSTREAM_UNAVAILABLE`**: el backend crea la
sala en el proveedor antes de persistir el ticket, así que sin credencial no hay
conversación. Pega la cadena del portal de Azure y reinicia.

`configuration.yaml` está en `.gitignore`, así que el secreto no se comitea.

## 2. Cuentas de prueba

El tipo de usuario decide qué puede hacer cada cuenta, y **se asigna solo según por
dónde entres**:

| Vía de entrada | Tipo asignado |
|---|---|
| OTP (código al correo), Google, Apple | `PACIENTE` |
| Bupa / Microsoft, desde `/login/medicos` | `MEDICO` |

No sobrescribe: una cuenta que ya tiene tipo lo conserva aunque entre por otra vía.

Para preparar cuentas sin pasar por el login (útil para ver el panel con datos):

```bash
cd ~/GitHub/portal-blua-ms-controller
CONFIG=$PWD/configuration.yaml go run ./scripts/cmd/seed-chat-users \
  -medico dra.ruiz@bupa.cl \
  -paciente juan.paciente@ejemplo.com \
  -tickets 6
```

`-tickets` siembra requerimientos repartidos entre los tres estados y varias fechas,
para ejercitar los filtros. **Esos requerimientos no tienen sala real**: sirven para
listar, filtrar y transicionar, no para conversar.

## 3. Frontend

```bash
cd ~/GitHub/pruebas/bupaprueba
npm start
```

Abre http://localhost:4200.

## 4. El recorrido

1. **Paciente** — en `/login`, usa **"Ingresar con código"**: escribe tu correo,
   recibes un código y entras. También sirven Google y Apple.
2. En `/home` escribe un asunto y pulsa **Crear consulta**. Entras directo al chat.
3. **Médico** — en otra ventana (o incógnito) entra por `/login/medicos` con la
   cuenta de Bupa.
4. En `/home/medicos` verás tres pestañas:
   - **Cola**: los abiertos que nadie atiende. Pulsa **Tomar**.
   - **Míos**: los que atiendes. Ahí conversas.
   - **Panel**: todo el equipo, con filtros por estado, médico y fechas.
5. Al tomarlo, el médico entra al chat y ambos conversan en vivo.
6. El médico puede **Devolver** el requerimiento a la cola o **Cerrar** la consulta.

## 5. Qué mirar en cada pantalla

### Paciente — `/home`

- **En curso**: las consultas vivas, abiertas y en atención juntas. Sale de
  `GET /chat/tickets/active`, que devuelve los dos estados en una sola página
  ordenada por última actividad. Cada fila dice qué está pasando ("Esperando que un
  médico la tome", "Esperando respuesta del médico", "El médico respondió") y marca
  **Sin responder** cuando el último mensaje es del paciente.
- **Historial**: plegado por defecto; al abrirlo trae todo, cerrados incluidos.
- **Tipo de consulta**: selector opcional junto al asunto. El backend no impone
  catálogo — la lista de la pantalla es del cliente.

El médico que atiende aparece por **nombre** ("Te atiende Dra. Ruiz"), no por correo: el backend
copia `assigneeName` en el requerimiento al tomarlo y lo borra al devolverlo a la cola.

**Ventana de agrupación.** Crea una consulta y, sin esperar, crea otra: la segunda
**no** abre un caso nuevo. El backend responde `200` con `reused: true`, la pantalla
avisa ("tu mensaje se sumó a la consulta que ya tenías abierta") y entra al hilo de
siempre. La ventana es `chat.tickets.creationWindowMinutes` en el
`configuration.yaml` del backend: 20 minutos por defecto, y `-1` la desactiva si
quieres probar el comportamiento anterior.

### Médico — chat de un requerimiento

Al abrir la conversación (o al tomarla desde la cola) aparece la **ficha del
paciente**: nombre, apellidos, RUT, fecha de nacimiento, edad, tipo de consulta,
región, último mensaje con quién lo envió, si queda algo sin responder, el médico
asignado y el ID de usuario. Se puede plegar con "Ocultar ficha".

Dos cosas que conviene comprobar a propósito:

- **Un paciente sin perfil muestra la ficha con guiones**, no un error: los datos
  salen de `profile` y, si nunca lo editó, de lo que declaró en el onboarding. Sin
  ninguno de los dos, la ficha va vacía y la conversación se atiende igual. La edad
  sale `—` (nunca `0`) cuando no hay fecha de nacimiento.
- **Al paciente no le llega la ficha.** Abre el mismo requerimiento con la cuenta del
  paciente: el bloque no aparece, porque el backend omite `patient` en su respuesta.

En `/home/medicos`, las pestañas **Míos** y **Panel** marcan **Sin responder** en los
requerimientos cuyo último mensaje es del paciente. Es distinto del punto naranja de
"no leído": ese dice que llegó algo, este dice que alguien sigue esperando.

## 6. Nota sobre `X-User-Id`

En el despliegue real, Kong valida el JWT e inyecta el header `X-User-Id`. Corriendo
el backend suelto no hay puerta de enlace, así que **el interceptor del front lo
envía con el correo de la sesión** — si no, todos los endpoints de chat responderían
`401 missing user identifier`.

Esto solo ocurre cuando la URL es `localhost`, y la condición mira la URL a propósito:
que no viaje a QA no puede depender de acordarse de cambiar un flag. Aun así, **es un
bypass de autenticación**: sirve para probar en tu máquina y no debe llegar a ningún
entorno compartido.

## 7. Si algo falla

| Síntoma | Causa probable |
|---|---|
| `502 CHAT_UPSTREAM_UNAVAILABLE` | Falta la cadena de conexión real de ACS |
| `403 PROFILE_NOT_ALLOWED` | La cuenta no tiene `user_type`. Entra por la puerta correcta o usa `seed-chat-users` |
| `401 missing user identifier` | No hay correo en la sesión: vuelve a entrar |
| `Status 0` / CORS | El backend no está corriendo, o no en `:8080` |
| El chat no carga mensajes | La cuenta no participa en ese requerimiento, o el ticket es de los sembrados (sin sala real) |
| Crear una consulta devuelve `200` y no `201` | No es un fallo: la ventana de agrupación la sumó a una que ya estaba abierta |
| La ficha del paciente no aparece | Estás mirando con la cuenta del paciente: solo la recibe el equipo médico |
| La ficha aparece con todo en guiones | Ese paciente no tiene perfil ni datos de onboarding cargados |
| `404` en `/chat/tickets/active` | El backend no está en la rama con el endpoint nuevo, o no se reinició |
| "Sin conexión en tiempo real" en el chat | La señalización de ACS no arrancó (red que bloquea su WebSocket). La conversación sigue, releyendo cada 10 s |
| Sale el correo del médico en vez de su nombre | Ese requerimiento se tomó antes de que se guardara `assignee_name`; vuelve a tomarlo o reasígnalo |
