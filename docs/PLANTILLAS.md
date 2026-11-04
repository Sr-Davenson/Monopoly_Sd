# Plantillas — qué completa cada integrante

Todo lo que está entre `[corchetes]` es un marcador por definir. Cada integrante (David, Jossef, Sebastian, Santiago) completa **su propia sección**. Los archivos están en `coordinator/game/`.

> Después de editar, reinicia el coordinador. El cliente recibe los datos nuevos al conectarse (`game_config`), así que **no hay que tocar el HTML**.

## 1. Idea central — `members.js`

```js
{
  id: 'david',
  name: 'David',
  side: 0,                               // no cambiar
  color: '#ef4444',                      // color de tu sección en el tablero
  sectionName: '[Sección de David]',     // ← nombre de tu sección
  idea: '[Idea central de David...]'     // ← tu idea central (aparece al elegir temática)
}
```

## 2. Propiedades y casillas — `board.js`

Cada lado tiene la misma estructura (ver `docs/ECONOMIA.md` §3). Para renombrar tus casillas:

- **Grupos**: `name` se genera como `[Grupo A de David]`. Puedes cambiarlo en `buildGroups()` o pedir una tabla de nombres por grupo.
- **Propiedades / transporte / servicio**: se generan como `[Propiedad A1 de David]`, `[Transporte de David]`, etc.
- **Donación**: en `DONATION_TARGETS` pon a quién se dona en tu sección (p. ej. "Dona a [tu personaje]").

> Sugerencia: cuando tengan los nombres, reemplacen la generación automática por una lista fija `NAMES = { david: { A1: '...', A2: '...', ... } }`.

**No cambies precios aquí.** Los precios viven en `economy.js` y están balanceados (`docs/ECONOMIA.md`).

## 3. Cartas — `cards.js`

Cada carta tiene:

| Campo | Quién lo define | Ejemplo |
| --- | --- | --- |
| `title` | El equipo (temático) | `'[Título por definir]'` → `'¡Encontraste un tesoro!'` |
| `text` | Descripción del efecto | `'Cobra 100.'` |
| `effect` | **No tocar** sin revisar el motor y el balance | `{ kind: 'collect', amount: 100 }` |

Si se agrega o cambia un efecto, hay que repetir la simulación (`node coordinator/game/simulate.js`).

## 4. Temática, skins (fichas) y caja — `themes.js`

```js
themeTemplate('david', 'David', ['▲', '△', '⬟', '★'])  // íconos provisionales
```

Cada temática tiene:

| Elemento | Qué es | Estado |
| --- | --- | --- |
| `name`, `description` | Nombre y descripción de tu temática | Por definir |
| `skins[0]` (`starter: true`) | **Ficha inicial**: la recibe quien elige tu temática al unirse a la partida | Funciona |
| `skins[1..3]` | Fichas común, rara y épica, que se obtienen con cajas | Plantilla |
| `box` | Tu caja: nombre, precio y probabilidades (común 70%, rara 25%, épica 5%) | Plantilla |
| `icon` | Por ahora un símbolo; luego puede ser la ruta a una imagen | Provisional |

**Elección de temática:** el jugador la escoge en la sala de espera, antes de iniciar. Puede cambiarla mientras espera, pero al empezar la partida queda fija.

### Pendiente para las cajas (fuera de este alcance)

Abrir cajas y guardar qué skins tiene cada usuario requiere **persistencia**: una tabla nueva en `auth-service`, p. ej. `user_skins(user_id, skin_id, obtained_at)`, y una moneda "meta" fuera de la partida para comprarlas. La plantilla ya define el contenido y las probabilidades para cuando se implemente.

## 5. Nombre del juego y moneda

- Nombre del juego: `[Nombre del juego]` en `client/game.html` (centro del tablero).
- Moneda: `CURRENCY` en `coordinator/game/economy.js` (`name` y `symbol`).
