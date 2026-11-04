# Estudio económico — Balance general

> Moneda: **genérica** (`¤`), con nombre aún por definir. Se cambia en un solo lugar:
> `CURRENCY` en `coordinator/game/economy.js`. Todos los montos del juego salen de ese archivo.

## 1. Objetivo del balance

Que adquirir propiedades **no sea ni trivial ni imposible**:

- Al inicio, cualquier jugador puede comprar casi todo lo que pisa en las primeras vueltas, pero **no todo**: tiene que elegir.
- Una propiedad sola rinde poco; el dinero de verdad está en **completar grupos y construir**. Eso empuja a negociar (intercambios).
- Ningún grupo debe ser claramente "el mejor": cada integrante tiene una sección y todas deben ser igual de atractivas en rentabilidad.
- La partida debe terminar en un tiempo razonable (las deudas eliminan jugadores).

## 2. Parámetros base

| Concepto | Valor | Razón |
| --- | --- | --- |
| Dinero inicial | 1.500 | Permite comprar ~6–8 propiedades baratas o ~4 caras. |
| Salario al pasar por Salida | 200 | ≈ 13% del dinero inicial por vuelta: sostiene compras sin inflar la economía. |
| Multa de cárcel | 50 | Barata; la cárcel penaliza más por perder turnos que por dinero. |
| Turnos máximos en cárcel | 3 | Al tercer intento fallido se paga la multa y se sale (sin moverse ese turno). |
| Dobles seguidos para ir a la cárcel | 3 | Freno a la suerte excesiva. |
| Hipoteca | 50% del precio | Liquidez de emergencia con pérdida. |
| Levantar hipoteca | 55% del precio (50% + 10% de interés) | Hipotecar tiene costo, no es gratis. |
| Venta de construcciones | 50% de su costo | Construir es una apuesta, no un ahorro. |
| Jugadores | 2 a 6 | |

## 3. Tablero: 40 casillas, 4 secciones iguales

Cada integrante tiene un lado del tablero (9 casillas) con **la misma estructura**:

```
Esquina │ A1 │ General │ A2 │ Donación │ Transporte │ B1 │ Especial/Servicio │ B2 │ B3
```

| Lado | Integrante | Casillas | Esquina que abre el lado |
| --- | --- | --- | --- |
| 0 | David | 1–9 | Salida (0) |
| 1 | Jossef | 11–19 | Cárcel (10) |
| 2 | Sebastian | 21–29 | Descanso (20) |
| 3 | Santiago | 31–39 | Ve a la cárcel (30) |

Total: 20 propiedades (8 grupos), 4 transportes, 2 servicios, 4 Tarjetas Generales, 2 Tarjetas Especiales, 4 donaciones y 4 esquinas.

Solo cambian los **precios**, que suben al avanzar por el tablero (igual que en el juego tradicional). Como las casas también suben de precio, **la rentabilidad relativa queda pareja** (ver §5).

## 4. Precios y rentas

La renta se calcula como fracción del precio según el nivel de construcción:

| Nivel | Sin casas | Grupo completo | 1 casa | 2 casas | 3 casas | 4 casas | Hotel |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Renta / precio | 7% | 14% | 35% | 100% | 280% | 380% | 470% |

| Grupo | Precios | Costo del grupo | Casa | Renta base con grupo | Renta con 3 casas | Hotel |
| --- | --- | --- | --- | --- | --- | --- |
| A de David | 60 / 80 | 140 | 50 | 8 / 12 | 170 / 225 | 280 / 375 |
| B de David | 100 / 100 / 120 | 320 | 50 | 14 / 14 / 16 | 280 / 280 / 335 | 470 / 470 / 565 |
| A de Jossef | 140 / 160 | 300 | 100 | 20 / 22 | 390 / 450 | 660 / 750 |
| B de Jossef | 180 / 180 / 200 | 560 | 100 | 26 / 26 / 28 | 505 / 505 / 560 | 845 / 845 / 940 |
| A de Sebastian | 220 / 240 | 460 | 150 | 30 / 34 | 615 / 670 | 1.035 / 1.130 |
| B de Sebastian | 260 / 260 / 280 | 800 | 150 | 36 / 36 / 40 | 730 / 730 / 785 | 1.220 / 1.220 / 1.315 |
| A de Santiago | 300 / 320 | 620 | 200 | 42 / 44 | 840 / 895 | 1.410 / 1.505 |
| B de Santiago | 350 / 350 / 400 | 1.100 | 200 | 50 / 50 / 56 | 980 / 980 / 1.120 | 1.645 / 1.645 / 1.880 |

**Transportes** (precio 200): renta 25 / 50 / 100 / 200 según cuántos tenga el dueño.
**Servicios** (precio 150): renta = suma de los dados × 4 (uno) o × 10 (ambos).

### Proporciones clave

| Indicador | Valor | Lectura |
| --- | --- | --- |
| Propiedad más barata / dinero inicial | 60 / 1.500 = 4% | Siempre se puede empezar a comprar. |
| Propiedad más cara / dinero inicial | 400 / 1.500 = 27% | Cara pero alcanzable desde la primera vuelta. |
| Grupo más caro / dinero inicial | 1.100 / 1.500 = 73% | Completarlo exige sacrificar el resto. |
| Valor total comprable | 5.400 | 20 propiedades (4.300) + transportes (800) + servicios (300). |
| Valor del tablero / dinero inicial total (4 jugadores) | 5.400 / 6.000 = 0,9 | Nadie puede comprarlo todo solo; con 4 jugadores el tablero se reparte en ~20 rondas. |

Con 2 jugadores la proporción es 1,8 (el tablero se llena más lento) y con 6 es 0,6 (se llena rápido y hay más competencia).

## 5. Rentabilidad: ¿cuándo se recupera una inversión?

Probabilidad aproximada de que un rival caiga en una casilla concreta en su turno: **≈ 2,8%** (avanza ~7 casillas por tiro más los dobles).

| Grupo | Inversión hasta 3 casas | Rondas para recuperarla (3 rivales) |
| --- | --- | --- |
| A de David | 440 | 13,3 |
| B de David | 770 | 10,2 |
| A de Jossef | 900 | 12,8 |
| B de Jossef | 1.460 | 11,1 |
| A de Sebastian | 1.360 | 12,6 |
| B de Sebastian | 2.150 | 11,4 |
| A de Santiago | 1.820 | 12,5 |
| B de Santiago | 2.900 | 11,2 |

- **Todas las secciones recuperan su inversión en 10–13 rondas.** Ningún integrante queda con una sección "mala": las baratas son accesibles antes y las caras golpean más fuerte.
- Los grupos de 3 propiedades rinden un poco mejor que los de 2 (más casillas donde caer), pero son más difíciles de completar.
- Una propiedad **sin casas** rinde ~0,6% de su precio por ronda (más de 150 rondas para recuperarse). Comprar sirve sobre todo para **completar grupos o negociar**.

## 6. Flujo de dinero por vuelta (sin contar rentas)

Por vuelta un jugador cae en ~5,7 casillas, así que la probabilidad de caer en una casilla concreta es ≈ 14%.

| Fuente | Valor esperado por vuelta |
| --- | --- |
| Salario | +200 |
| Donaciones (50 + 75 + 100 + 150) × 14% | −54 |
| Tarjetas (6 casillas × 14% ≈ 0,86 cartas, ~+20 c/u) | +17 |
| **Neto** | **≈ +163** |

El ingreso neto por vuelta (~11% del dinero inicial) permite seguir comprando y construir lentamente. Las rentas de los rivales son las que terminan de definir quién gana.

## 7. Donaciones y Fondo (estilo "Tío Rico")

- Hay 4 casillas de donación, una por sección: **50, 75, 100 y 150** ("Dona a [personaje por definir]").
- Algunas cartas también son donaciones (50 o 100).
- Lo donado **no desaparece**: va al **Fondo de Donaciones**, que se lleva entero quien cae en **Descanso** (casilla 20).
- Efecto: devuelve dinero al juego (evita que la economía se seque) y agrega un premio sorpresa que puede cambiar la partida.

## 8. Cartas

Dos mazos de 16 cartas. Los efectos ya funcionan; **el título temático está por definir** (`coordinator/game/cards.js`).

| Mazo | Estilo | Valor esperado por carta |
| --- | --- | --- |
| General (4 casillas) | Dinero, suave y favorable: cobros de 10–200, pagos de 50–100, donaciones, ir a Salida, cárcel, carta de salida, reparaciones. | ≈ +27 |
| Especial (2 casillas) | Movimiento y riesgo: avanzar a casillas concretas o al siguiente transporte (renta ×2), retroceder 3, pagar 50 a cada jugador, reparaciones. | ≈ +12 (más varianza) |

Las cartas de **reparaciones** (25–40 por casa, 100–115 por hotel) frenan a quien construye mucho.

## 9. Deudas, bancarrota y fin de partida

- Si un jugador no puede pagar, entra en **deuda**: debe vender construcciones (50%) o hipotecar hasta cubrirla. Mientras tanto no puede construir ni levantar hipotecas.
- Si no le alcanza, se declara en **bancarrota**:
  - Si debe a **un jugador**, ese jugador recibe su dinero, sus propiedades (hipotecadas siguen así) y el 50% de sus construcciones.
  - Si debe al **banco** o al Fondo, las propiedades vuelven al banco.
- Gana el último jugador que no quiebre.

## 10. Validación con simulaciones

`node coordinator/game/simulate.js [partidas] [jugadores]` juega partidas completas con bots simples: compran si les queda una reserva, construyen con el excedente y negocian para completar grupos.

| Jugadores | Rondas hasta terminar | Primera construcción | Primera eliminación | Propiedades compradas en la ronda 20 (de 26) |
| --- | --- | --- | --- | --- |
| 2 | 65,8 | ronda 11,9 | ronda 65,8 | 14,9 |
| 4 | 45,0 | ronda 5,7 | ronda 29,0 | 21,5 |
| 6 | 35,0 | ronda 3,3 | ronda 19,0 | 24,3 |

Todas las partidas simuladas terminaron. Con 4 jugadores el ritmo es el esperado: el tablero se reparte hacia la ronda 20, se construye pronto gracias a los intercambios, y las eliminaciones llegan a mitad de partida. Los humanos negocian menos que los bots, así que en la práctica las partidas pueden durar algo más.

## 11. Qué ajustar si el juego se siente...

| Síntoma | Parámetro a mover (en `economy.js`) |
| --- | --- |
| Muy fácil comprar / se llena muy rápido | Bajar `STARTING_MONEY` o `SALARY`, o subir `GROUP_PRICES`. |
| Muy difícil comprar | Subir `STARTING_MONEY` (p. ej. 1.800). |
| Partidas demasiado largas | Subir `RENT_FRACTIONS` de 3 casas en adelante, o bajar `houseCost`. |
| Partidas demasiado cortas | Bajar `RENT_FRACTIONS` altas o `GROUP_RENT_MULTIPLIER`. |
| El Fondo crece demasiado | Bajar `DONATION_AMOUNTS`. |

Después de cada ajuste conviene repetir la simulación para comparar.

## 12. Reglas simplificadas respecto al juego tradicional

- **No hay subastas**: si el jugador no compra, la propiedad sigue en el banco.
- **No hay límite de casas y hoteles** en el banco.
- Construir, hipotecar e intercambiar solo se puede **en tu propio turno** (orden claro y servidor autoritativo).
- Las cartas de "cada jugador te paga" no generan deuda a los demás: cada uno paga lo que pueda.
