# Cuatro Mundos — Monopoly SD (Proyecto final · Sistemas Distribuidos)

Juego de tablero multijugador en tiempo real. Cuatro mundos comparten el tablero: **Star Wars** (David), **Fantasía** (Jossef), **Vikingos** (Sebastian) y **Literatura** (Santiago). Las **salas las crean los jugadores** y las atiende una red de **X coordinadores en mesh** que puede crecer en caliente.

- **Salas dinámicas**: cualquier jugador crea una sala desde el lobby. La sala queda alojada en su coordinador y se ve desde **todos** los coordinadores.
- **Cambio automático de coordinador**: quien entra a una sala alojada en otro coordinador se cambia solo al anfitrión. Esto vale tanto para jugar como para observar.
- **Balanceo de carga**: el auth-service manda a cada jugador al coordinador menos cargado y reparte los empates por turnos (10 jugadores y 2 coordinadores quedan 5 y 5). **Cada vez que entra o sale un coordinador, recalcula las cargas y vuelve a repartir** a los jugadores del lobby en 1–2 s.
- **Replicación y tolerancia a fallos**: todas las salas y jugadores se replican. Si el anfitrión de una sala cae, otro coordinador la adopta con su estado.
- **Panel del coordinador**: al arrancar se abre una página con los demás coordinadores de la red y el estado del enlace con cada uno.

> **Tutorial para conectar X coordinadores con ngrok:** [`docs/COORDINADORES_NGROK.md`](docs/COORDINADORES_NGROK.md)

---

## 1. Arquitectura

```mermaid
flowchart LR
    subgraph Client["Cliente web :3000"]
        L[login.html]
        LB[lobby.html<br/>crear salas · plaza · misiones]
        G["game.html?sala=X&coord=Y<br/>tablero"]
    end

    subgraph Auth["auth-service :4000"]
        A1[POST /register · /login · /auth/google]
        A2[POST /heartbeat]
        A3[GET /coordinator<br/>balanceo · prefer · exclude]
        A4[GET /coordinators · /peers]
        A5[GET /me/progress<br/>POST /internal/match-result]
        DB[(SQLite)]
    end

    subgraph Mesh["Coordinadores (un puerto c/u: /connect + /peer + panel)"]
        CA[coord-a]
        CB[coord-b]
        CX[coord-x]
        CA <-->|wss /peer| CB
        CA <--> CX
        CB <--> CX
    end

    L -->|1. login → JWT| A1
    LB -->|2. GET /coordinator| A3
    LB -->|3. WS /connect| CB
    G -->|"GET /coordinator?prefer=anfitrión → WS"| CA
    CA & CB & CX -->|heartbeat cada 1 s| A2
    CA & CB & CX -->|descubrir pares| A4
```

| Componente | Responsabilidad |
| --- | --- |
| `auth-service/` | Usuarios (bcrypt + JWT + Google). **Directorio de coordinadores y balanceador**: recibe heartbeats, descarta los que llevan más de 3 s sin latir (o que se despiden con `/leave`), **rebalancea** cuando cambia la red y responde `/coordinator`, `/coordinators` y `/peers`. Guarda el progreso de misiones. |
| `coordinator/` | Atiende a sus clientes por WS, forma la mesh con los demás coordinadores, aloja las salas que crean sus jugadores, replica todo y corre la plaza a 20 Hz. Abre su **panel** en el navegador. |
| `client/` | Login, lobby (crear y listar salas, plaza en canvas, jugadores en línea, colección) y tablero. Pide coordinador al auth antes de abrir cada WS y se reconecta o se cambia de coordinador solo. |

---

## 2. Estructura del repositorio (programación modular)

```text
auth-service/
  index.js                     Arranque: monta las rutas
  src/config.js                Variables del .env
  src/db.js                    SQLite (usuarios, progreso, partidas)
  src/routes/auth.js           /register · /login · /auth/google
  src/routes/directory.js      /heartbeat · /leave · /coordinator (balanceo y rebalanceo) · /coordinators · /peers
  src/routes/progress.js       /me/progress · /internal/match-result

coordinator/
  index.js                     Arranque
  src/config.js                Línea de comandos + .env
  src/state.js                 Estado en memoria y utilidades de envío
  src/server.js                HTTP: panel, /status, WS /connect, WS /peer
  src/clients.js               WebSocket de los jugadores y sus mensajes
  src/mesh.js                  Enlaces con otros coordinadores y réplica
  src/rooms.js                 Salas creadas por jugadores (anfitrión, réplica, timers, adopción)
  src/broadcast.js             Difusión a los clientes locales
  src/loop.js                  Game loop de la plaza (20 Hz)
  src/directory.js             Heartbeat y descubrimiento de pares
  src/ngrok.js                 Detecta (o lanza) el túnel de ngrok
  src/panel.js                 API del panel y apertura del navegador
  panel/index.html · panel.css · panel.js     Panel del coordinador
  game/                        Motor del juego (no depende de red)

client/
  server.js                    Sirve public/ y genera /js/config.js
  public/login.html · lobby.html · game.html   Solo marcado (sin CSS ni JS en línea)
  public/css/                  styles.css (base) · login.css · lobby.css · game.css
  public/js/lib/               dom.js · net.js · tokens.js · sounds.js (compartidos)
  public/js/pages/             login.js · lobby.js · game.js (uno por página)

docs/  COORDINADORES_NGROK.md · ECONOMIA.md · PLANTILLAS.md
```

---

## 3. Cómo correrlo en local

Requisitos: **Node.js 18+**. Usen la misma `JWT_SECRET` en `auth-service/.env` y `coordinator/.env`.

```bash
# 0) Dependencias (una vez)
cd auth-service && npm install && cd ..
cd coordinator  && npm install && cd ..
cd client       && npm install && cd ..

# 1) Auth-service + directorio
cd auth-service && npm start                 # http://localhost:4000

# 2) Coordinadores (una terminal por cada uno; cada uno abre su panel)
cd coordinator && npm run start:a            # coord-a · http://localhost:5001
cd coordinator && npm run start:b            # coord-b · http://localhost:5002
cd coordinator && npm run start:c            # coord-c · http://localhost:5003

# 3) Cliente web
cd client && npm start                       # http://localhost:3000
```

Cualquier otro coordinador: `node index.js --id coord-x --port 5004`. Con ngrok: `node index.js --id coord-x --port 5004 --ngrok`. Todas las opciones están en el [tutorial](docs/COORDINADORES_NGROK.md#8-referencia-de-opciones-del-coordinador).

| Servicio | Variable | Por defecto | Uso |
| --- | --- | --- | --- |
| auth | `PORT`, `JWT_SECRET`, `JWT_EXPIRES_IN`, `DB_PATH`, `GOOGLE_CLIENT_ID` | | Igual que en talleres anteriores |
| auth | `HEARTBEAT_TTL_MS` | `3000` | Sin heartbeat durante este tiempo → coordinador muerto |
| auth | `REBALANCE_WINDOW_MS`, `REBALANCE_COOLDOWN_MS` | `30000`, `1000` | Tiempo que se sigue rebalanceando tras un cambio en la red / pausa mínima entre planes |
| coordinator | `--id`, `--port`, `--auth-url`, `--public-url`, `--ngrok`, `--no-panel` | | Ver tutorial §8 |
| coordinator | `TURN_TIMEOUT_MS`, `MAX_ROOMS`, `ROOM_EMPTY_MS`, `ROOM_ABANDON_MS` | `90000`, `24`, `60000`, `90000` | Tiempo por turno, límite de salas, borrar sala vacía o abandonada |
| client | `PORT`, `AUTH_URL`, `GOOGLE_CLIENT_ID` | | El cliente **no tiene** URL de coordinador fija |

---

## 4. Endpoints del directorio (auth-service)

### `POST /heartbeat` — cada coordinador, cada 1 s

```bash
curl -X POST http://localhost:4000/heartbeat -H "Content-Type: application/json" \
  -d '{"coordinatorId":"coord-a","publicUrl":"wss://a.ngrok-free.app","peerUrl":"wss://a.ngrok-free.app/peer","connectedPlayers":7,"lobbyPlayers":5,"uptime":12345}'
# 200 {"ok":true}
# 200 {"ok":true,"rebalance":{"moves":[{"coordinatorId":"coord-a","count":3}]}}   ← orden de rebalanceo
```

`lobbyPlayers` son los jugadores que se pueden mover: están en el lobby, no dentro de una sala.

### Rebalanceo cuando cambia la red

Cada vez que **entra** un coordinador (nuevo o que vuelve) o **sale** uno (por TTL o con `POST /leave`), el directorio recalcula las cargas durante 30 s:

1. Espera a tener **datos frescos**: que todos los coordinadores hayan latido después de la última asignación, para no decidir con cifras viejas.
2. Calcula **un plan global**. El ideal es `total / N` por coordinador. Cada coordinador por encima del techo mueve su exceso a los que están por debajo del piso. Por ejemplo, con A=3 y B=3, si entra C queda A: 1 → C y B: 1 → C.
3. Entrega a cada coordinador su parte en la respuesta de su siguiente heartbeat.
4. El coordinador cierra a esos jugadores con **`4011 move:<destino>`**, empezando por los que llegaron más recientemente. El cliente se reconecta a ese destino y el lobby avisa *"Balanceo de carga: te movemos de B a A…"*.

Tiempos medidos en local: cae A → todos en B en 0,5 s · vuelve A → 3/3 en 1,8 s · entra C → 2/2/2 en 1,9 s · C se despide → 3/3 en 0,5 s.

### `POST /leave` — un coordinador que se cierra con Ctrl+C

Lleva el JWT de servicio. El directorio lo saca **al instante**, sin esperar el TTL, y rebalancea.

```bash
curl -X POST http://localhost:4000/leave -H "Authorization: Bearer <JWT de servicio>"   # lo hace el coordinador al recibir Ctrl+C
# 200 {"ok":true}
```

### `GET /coordinator` — balanceador de carga

```bash
curl http://localhost:4000/coordinator                    # el menos cargado
curl http://localhost:4000/coordinator?prefer=coord-a     # coord-a si está vivo (anfitrión de la sala)
curl http://localhost:4000/coordinator?exclude=coord-b    # cualquiera menos el que acaba de fallar
# 200 {"coordinatorId":"coord-b","publicUrl":"wss://b.ngrok-free.app"}
# 503 {"error":"no_coordinators_available"}
```

- **Menos cargado**: según los jugadores del último heartbeat más las asignaciones hechas desde entonces (reserva provisional). Así, si 10 clientes entran en el mismo segundo, no van todos al mismo coordinador.
- **Empates por turnos** (round-robin): con carga igual, se alternan.
- **`prefer`**: lo usa el tablero para ir al anfitrión de la sala. Si ese coordinador no está vivo, se aplica el balanceo normal.

### `GET /coordinators` y `GET /peers`

`/coordinators` lista todos los vivos con carga, uptime y `lastSeenMsAgo`. Lo usan los coordinadores para descubrir pares y para su panel. `/peers` es la versión corta (`coordinatorId`, `peerUrl`).

### Otros

| Endpoint | Para qué |
| --- | --- |
| `GET /me/progress` (Bearer JWT de usuario) | Estadísticas para las misiones de fichas. |
| `POST /internal/match-result` (Bearer JWT de servicio) | El anfitrión de la sala reporta el resultado de la partida. Es idempotente por `matchId`. |

---

## 5. Protocolo de la mesh

Cada coordinador escucha a sus pares en **`<publicUrl>/peer`**, el mismo puerto y el mismo túnel que los clientes. Cada 1 s pide `/coordinators` y abre conexión hacia los pares que aún no tiene.

**Una sola conexión por par.** Solo el coordinador con el id **menor** (orden lexicográfico) inicia la conexión; el mayor espera. Si aun así llega una conexión de un par con el que ya hay enlace, se cierra la nueva (`4009 duplicate peer link`).

**Handshake.** El primer mensaje en cada sentido es:

```json
{ "type": "hello", "coordinatorId": "coord-a", "auth": "<JWT de servicio>" }
```

El campo `auth` es un JWT `{ role: "coordinator" }` firmado con `JWT_SECRET`. Así, un proceso cualquiera no puede meterse a la mesh ni inyectar estado.

**Mensajes replicados** (todos llevan `origin`):

| Mensaje | Cuándo | Qué hace quien lo recibe |
| --- | --- | --- |
| `intent_replicate` `{userId, intent:{dir}, x, y}` | Un cliente local cambia de dirección | Aplica el intent a su copia del jugador |
| `extras_replicate` `{userId, extras}` | Un cliente local cambia color, ánimo o ficha | Actualiza los extras |
| `player_joined` `{userId, username, x, y, view, roomId, since}` | Un cliente se conecta | Agrega el jugador al mundo |
| `player_left` `{userId}` | Un cliente se desconecta | Lo quita, solo si sigue siendo de ese coordinador |
| `positions_replicate` `{positions:[...]}` | Cada 1 s | Corrige la deriva de posiciones |
| `room_state` `{roomId, writer, meta:{name, emblem, host, createdBy}, state}` | Se crea o cambia una sala | Crea la sala si no la conocía y adopta el estado si su versión es mayor |
| `room_deleted` `{roomId}` | El anfitrión borra una sala | La borra y deja una lápida para no resucitarla |

**Sin bucles de replicación**: nadie retransmite lo que recibe, y se descarta todo mensaje con `origin` propio.

**Al enlazarse**, dos coordinadores se mandan sus jugadores locales y **todas** las salas. **Si un par se cae**, los demás retiran a sus jugadores y los marcan desconectados en las salas.

### Game loop de la plaza (20 Hz)

1. Aplica los intents de **todos** los jugadores (locales y remotos).
2. Hace broadcast del `state` **solo a sus clientes locales**.

---

## 6. Salas creadas por los jugadores

1. **Crear**: en el lobby, el jugador escribe un nombre y elige un emblema. El cliente envía `create_room`. Su coordinador crea la sala (`sala-<hex>`), queda como **anfitrión** y la replica a todos. El creador entra directo al tablero.
2. **Ver**: todos los lobbies, en cualquier coordinador, reciben la sala en `rooms_update` con su anfitrión, estado (**Vacía**, **Sin iniciar**, **En curso**, **Finalizada**), asientos, jugadores y observadores.
3. **Entrar u observar**: el lobby abre `game.html?sala=<id>&coord=<anfitrión>`. El tablero pide `GET /coordinator?prefer=<anfitrión>` y se conecta allá. Si el WS llega a otro coordinador, este responde **`4010 host:<anfitrión>`** y el cliente se cambia solo, con el aviso *"Esta sala la atiende coord-a. Cambiando de coord-b a coord-a…"*.
4. **Reglas**: mínimo 2 y máximo 6 jugadores por sala. Un jugador solo puede estar en una sala activa a la vez, y solo puede tener una sala propia vacía. Hay un máximo de `MAX_ROOMS` salas.
5. **Temporizadores**: el fin de turno, la expulsión de quien no se reconecta en 30 s y la limpieza los corre **el anfitrión**. Una sala sin iniciar que queda vacía se borra a los 60 s. Una partida sin nadie conectado se borra a los 90 s.
6. **Si cae el anfitrión**: cuando ni la mesh ni el directorio lo ven, el **líder** (el coordinador vivo con id menor) adopta la sala, sube la versión y la replica. Los jugadores se reconectan y terminan en el nuevo anfitrión.

**Consistencia**: se replica el **estado completo** de la sala con una versión que solo crece. Si dos coordinadores escriben la misma versión a la vez, gana el `writer` con id menor y todos convergen al mismo estado. Como los jugadores de una sala están en el anfitrión, en la práctica casi todas las escrituras salen de un solo coordinador.

---

## 7. Cliente

1. Login → `GET /coordinator` → WS a `publicUrl/connect?token=…` (`public/js/lib/net.js`).
2. La UI muestra el coordinador en la barra superior, en la plaza junto a **"Tick: 20 Hz"**, bajo cada ficha del canvas, en la lista de jugadores y en cada sala ("Alojada en coord-a").
3. **Si el WS se cae**, el cliente vuelve a pedir `GET /coordinator?exclude=<el caído>`. Los cierres 4001, 4002, 4003 y 4004 son definitivos. Los cierres 4010 (sala en otro coordinador) y 4011 (rebalanceo) son un **cambio de coordinador**.
4. **Sesión única en toda la mesh**: si el mismo usuario abre sesión en otro coordinador, la vieja se cierra con `4002`.
5. En la sala de espera, si el cliente pierde o cambia de coordinador, recupera su asiento con la misma temática y ficha.

---

## 8. Temáticas, fichas y misiones

Cada temática tiene **6 fichas**: una inicial y cinco que se **desbloquean con misiones**. El progreso (partidas jugadas y ganadas, propiedades compradas, construcciones) lo guarda el auth-service y lo reportan los coordinadores al terminar cada partida. El coordinador **valida en el servidor** que la ficha elegida esté desbloqueada.

| Mundo | Ficha inicial | Fichas desbloqueables (misión) |
| --- | --- | --- |
| **Star Wars** — Una Galaxia Muy, Muy Lejana | Casco de Darth Vader | Caza TIE Imperial (jugar 1 partida) · Casco del Capitán Rex, Fase II (comprar 6 propiedades) · Caza Ala-X (jugar 3) · Casco de Boba Fett (construir 5) · Estrella de la Muerte (ganar 2) |
| **Fantasía** — Reinos de Fantasía | Poción Arcana | Sombrero de Merlín (jugar 2) · Espada en la Piedra (construir 5) · Unicornio de Brocelianda (comprar 6) · Santo Grial (jugar 4) · Dragón Ancestral (ganar 2) |
| **Vikingos** — Saga Vikinga | Casco del Jarl | Drakkar (jugar 2) · Mjölnir (construir 6) · Escudo Rúnico (comprar 6) · Lobo Fenrir (jugar 4) · Cuervo de Odín (ganar 1) |
| **Literatura** — Mundos de Papel | Gregorio Samsa en su cama | Marranito de *Rebelión en la granja* (jugar 1) · Mariposas amarillas de Macondo (comprar 6) · Sombrero de Arsène Lupin (comprar 10) · Sísifo y su piedra (jugar 5) · Feto de *Un mundo feliz* (ganar 2) |

Propiedades por lado del tablero:

| Lado | Grupo A | Grupo B | Transporte / Servicio | Donación |
| --- | --- | --- | --- | --- |
| Star Wars | Cantina de Mos Eisley (Tatooine) · Ciudad de las Nubes (Bespin) | Palacio Real de Theed (Naboo) · Ciudad Tipoca (Kamino) · Templo Jedi (Coruscant) | Halcón Milenario | Palacio de Jabba el Hutt |
| Fantasía | Bosque de Brocelianda · Árbol de los Elfos | Torre de Merlín · Ávalon · Castillo de Camelot | Grifo Mensajero / Pozo de los Deseos | Dragón dormido |
| Vikingos | Monasterio de Lindisfarne · Mercado de Hedeby | Aldea de Kattegat · Bifröst · Valhalla | Sleipnir | Odín |
| Literatura | Habitación de Gregorio Samsa · La Aguja Hueca de Lupin | Granja Manor del Sr. Jones · Centro de Incubación de Londres · Macondo | Globo de Phileas Fogg / Biblioteca de Babel | Sísifo |

La moneda son los **Doblones (Đ)**. Las fichas son dibujos SVG propios (`client/public/js/lib/tokens.js`).

---

## 9. Exposición con ngrok

El tutorial completo está en **[`docs/COORDINADORES_NGROK.md`](docs/COORDINADORES_NGROK.md)**. En resumen:

- PC central: túneles para el **auth** (4000) y el **cliente** (3000). En `client/.env`: `AUTH_URL=https://<auth>.ngrok-free.app`.
- Cada integrante: `node index.js --id coord-<nombre> --port 5001 --auth-url https://<auth>.ngrok-free.app --ngrok`. **Un solo túnel por coordinador**, porque la mesh va por `/peer` en el mismo puerto.
- Si ngrok ya está abierto, el coordinador detecta el túnel de su puerto y anuncia `wss://…` sin configurar nada.

---

## 10. Guía de la sustentación

1. **Red de coordinadores (3 min).** Levantar el auth y dos o tres coordinadores. Mostrar el **panel** de cada uno: todos se ven entre sí y aparecen como `enlazado`. `curl <auth>/coordinators` muestra la carga y el último heartbeat.
2. **Balanceo y rebalanceo (3 min).** Abrir 6 pestañas (un usuario por pestaña): quedan 3 y 3. `Ctrl+C` en A: todos pasan a B. Volver a encender A: en 1–2 s quedan otra vez 3 y 3 (la consola del auth muestra `[BALANCE] … Plan: coord-b: 3 → coord-a`). Encender C: quedan 2/2/2.
3. **Crear sala en A y unirse desde B (3 min).** Un jugador en `coord-a` crea "La guarida". Un jugador en `coord-b` la ve con "Alojada en coord-a · al entrar pasarás de coord-b a coord-a". Al pulsar "Unirme", el tablero se conecta a `coord-a`. El panel de `coord-a` muestra a ambos jugadores en la sala.
4. **Observar (1 min).** Un tercero en `coord-b` pulsa "Observar partida" y también se cambia a `coord-a`.
5. **Matar el anfitrión (3 min).** `Ctrl+C` en `coord-a`. Al instante (Ctrl+C avisa con `/leave`; si el proceso muere sin avisar, en 3 s) el auth lo descarta y `coord-b` adopta la sala ("Adopto la sala…" en su panel). Los jugadores se reconectan solos y siguen la partida.
6. **Sumar un coordinador en vivo (1 min).** `node index.js --id coord-x --port 5009`. Aparece en los paneles de todos y empieza a recibir jugadores.

---

## 11. Pruebas

```bash
cd coordinator
npm test            # pruebas del motor (reglas, fichas, serialize/load, resultados)
npm run simulate    # simulación de partidas para validar la economía
```

También se corrió una prueba de punta a punta (auth + 2 coordinadores + clientes WS). Verifica que:

- los dos coordinadores se enlazan por `/peer`;
- el directorio los ve a la vez;
- 10 peticiones a `/coordinator` quedan 5 y 5, y `prefer` funciona;
- una sala creada en A se ve desde B;
- un jugador que entra por B recibe `4010 host:coord-a` y luego juega en A;
- el panel solo responde en local;
- al matar A, B adopta la sala.

---

## 12. Decisiones y límites conocidos

- **`/heartbeat` es abierto**, como pide el enunciado. La mesh sí exige credencial de coordinador en el `hello`, así que un registro falso no puede inyectar estado. Sí podría anunciar una URL falsa a los clientes.
- **Anfitrión por sala**: mantener a los jugadores de una sala en el mismo coordinador evita casi todos los conflictos de escritura. Aun así es consistencia eventual, no consenso: durante una adopción, una acción simultánea puede descartarse.
- **Enlace mesh**: solo el id menor inicia la conexión. Si su túnel funciona pero el del otro no, el enlace no se forma. El panel lo muestra como `esperando` o `sin enlace` con el último error.
- **Desbalance por salas**: el lobby se reparte por igual, pero los jugadores de una sala se concentran en su anfitrión. Es la regla pedida.
- El estado vive en memoria: mientras quede **al menos un coordinador vivo**, las salas sobreviven. El progreso de misiones persiste en SQLite.

---

## 13. Tracks del examen final

**Track principal: chat distribuido.** **Track secundario: modo espectador.** Se eligieron dos tracks porque el espectador comparte con el chat la misma infraestructura (el canal de la sala), y el chat sin el espectador no mostraría el caso "lector que no escribe".

### 13.1 Chat distribuido (principal)

- **Canales**: `global` (plaza del lobby, visible desde todos los coordinadores) y `room:<id>` (chat de cada sala). El cliente no elige el canal: el servidor lo deduce de lo que está viendo, así que nadie puede escribir en una sala ajena.
- **Flujo**: `chat_send` → el coordinador local valida, sella con su reloj, guarda en su historial, entrega a sus clientes y replica por la mesh con `chat_replicate`. Los pares **re-validan** (no confían en el otro coordinador), actualizan su reloj y entregan a los suyos. Nadie retransmite lo recibido, así que no hay bucles. Al enlazarse dos coordinadores se intercambian los historiales (`chat_sync`); los duplicados se descartan por id `origin#seq`.
- **Orden (la parte difícil)**: los relojes de pared pueden estar desfasados, así que se usa un **reloj de Lamport** por coordinador. El orden total es `(lc, origin, seq)`. Si Alice (coord-A) y Bob (coord-B) escriben a la vez, ambos mensajes tienen el mismo `lc` y el desempate por id del coordinador es arbitrario pero **igual en todos**: Charlie, en coord-C, ve la misma conversación que los demás. Si un mensaje llega tarde y le toca ir antes de otros ya mostrados, el cliente lo **inserta en su lugar** con un destello. La prueba de punta a punta comprueba que 12 mensajes enviados a la vez desde dos coordinadores quedan en el mismo orden en los tres clientes.
- **Validación**: máximo 200 caracteres (`CHAT_MAX_LEN`), se eliminan caracteres de control e invisibles (RTL, ancho cero), se colapsan espacios y se rechazan mensajes vacíos. El **cliente escapa HTML** porque siempre usa `textContent` (`<img onerror=…>` se ve como texto).
- **Rate limiting**: cubeta de fichas por usuario (ráfaga de 5, ritmo sostenido de 1 por segundo). Quien insiste mientras está limitado acumula faltas y queda **silenciado 15 s** (`chat_error: rate_limited | muted`, con `retryMs`). Además hay una guardia por socket: más de 60 mensajes WS por segundo (de cualquier tipo) cierra la conexión con `4008`. En la prueba, 40 mensajes seguidos dejan pasar 5, y 1000 `ping` en un segundo cortan el socket.
- **Persistencia mínima**: cada coordinador guarda en memoria los últimos 50 mensajes por canal (`CHAT_HISTORY`). El cliente que se conecta recibe `chat_history`; si cambia de coordinador por rebalanceo o failover, recibe el historial del nuevo, que ya lo tiene replicado. Los canales de sala se borran con la sala.
- **Sonido**: cada mensaje recibido y enviado suena con el instrumento de la temática (`chatIn`, `chatOut`), con un intervalo mínimo para que una ráfaga no sature.
- **Límites conocidos**: el historial es solo en memoria (si caen todos los coordinadores se pierde). El orden es consistencia eventual: un mensaje con retraso de red puede aparecer insertado más arriba. Un mensaje enviado justo cuando se corta el enlace con un par puede no llegar a ese par hasta el siguiente `chat_sync`.

### 13.2 Modo espectador (secundario)

- **Entrada pública**: `spectate.html` (enlace en el login y en el lobby) lista las salas con `GET <coordinador>/rooms` (público) y abre `game.html?sala=…&espectador=1`. El WS es `/connect?view=board&room=<id>&spectator=1` **sin token**.
- **Qué recibe**: `welcome`, la configuración, `game_state` en cada cambio y el chat de la sala. La pantalla es la del tablero con una insignia y una franja **MODO ESPECTADOR**, sin controles de jugador (intercambios, propiedades, elegir ficha).
- **Solo lectura, validado en el servidor**: los espectadores usan un manejador aparte que solo atiende `ping` y `get_game`. `intent`, `game_action`, `extras_update` y `chat_send` se **ignoran** sin tocar el estado ni lanzar errores (un único aviso `spectator_readonly` por conexión). Desde DevTools, `conn.send({type:'intent', intent:{dir:{x:1,y:0}}})` no tiene efecto.
- **No cuentan para el balanceo**: viven en un mapa propio (`spectators`), no en `clients`. El heartbeat reporta solo los jugadores, y `/status` y el panel muestran los espectadores aparte. No se replican por la mesh.
- **Costo y justificación**: un coordinador con 100 jugadores y 1000 espectadores tiene que enviar el estado a 1100. Decisiones:
  1. Los espectadores van al coordinador que **aloja** la sala (redirección `4010`, igual que los jugadores). El trabajo se hace donde ya vive la sala y no hace falta replicar nada.
  2. El estado se serializa **una sola vez** por cambio y se envía el mismo texto a jugadores y espectadores. Se envía solo cuando cambia (no a 20 Hz).
  3. **Tope por coordinador** (`MAX_SPECTATORS`, 150 por defecto): el excedente recibe `4013 spectators full`.
  4. Guardia anti-inundación y ping/pong para sacar conexiones muertas.

  No se hizo un coordinador exclusivo de espectadores porque complicaría la mesh sin ganar nada con este volumen. Atajo documentado: el contador de espectadores anónimos solo lo conoce el anfitrión de la sala.

### 13.3 Subasta de bienes en bancarrota

Cuando un jugador queda en bancarrota (deuda, rendición, tiempo agotado o desconexión de más de 30 s) y siguen quedando **al menos 2 jugadores**, sus propiedades se **subastan una por una**; el dinero y las cartas de salida pasan al acreedor, como antes. Si la partida termina con esa baja, no hay subasta.

- Pueden ofertar todos los jugadores activos y conectados. Oferta mínima Đ10; cada oferta debe superar a la anterior en Đ10 y no puede exceder el dinero de quien oferta. Se puede **pasar** (definitivo para esa propiedad).
- La propiedad se adjudica cuando nadie más puede o quiere superar la oferta, o cuando vence el reloj (20 s para la primera oferta, 10 s tras cada nueva; `AUCTION_OPEN_MS` y `AUCTION_BID_MS`). Sin ofertas, vuelve al banco.
- Es **autoritativa y replicada**: el estado de la subasta va dentro del estado de la sala. El reloj lo corre el anfitrión y, si cae, el nuevo anfitrión lo reprograma al adoptar la sala.
- Durante la subasta el reloj del turno queda en pausa y el resto de acciones se bloquea; al terminar, el turno se reanuda con el tiempo completo.

### 13.4 Cómo demostrarlo

```bash
cd coordinator && npm test      # 34 pruebas: motor, subastas y núcleo del chat
```

1. **Chat**: tres usuarios en tres coordinadores abren el lobby y escriben a la vez. Todos ven el mismo orden. Con una ráfaga de mensajes aparece *"Vas muy rápido"* y luego *"Silenciado"*.
2. **Espectador**: pestaña de jugador y pestaña anónima en `spectate.html` → *Observar*. La del espectador ve moverse al jugador y leer el chat, pero no escribe. Desde su consola, `conn.send({type:'game_action', data:{action:'roll'}})` no hace nada.
3. **Subasta**: en una partida de 3 o más, un jugador con propiedades pulsa *Rendirse*; aparece el panel de subasta para todos, incluidos los espectadores.
