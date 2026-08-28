# Contrato del runner de Novaventa

Leer este archivo antes de lanzar un pedido real.

## Efecto autorizado

El runner reemplaza el contenido del carrito real de Oficina Virtual:

1. Abrir `https://oficinavirtual.novaventa.com/` con Puppeteer.
2. Reutilizar `.browser-profile-office`; si la sesión expiró, iniciar sesión automáticamente desde `.env` o solicitar login manual según la configuración.
3. Elegir Oficina Virtual si aparece el selector de modo.
4. Eliminar todos los artículos existentes del carrito.
5. Procesar `products.json` en orden.
6. Buscar cada código exacto, resolver el PDP cuando aparezca `Elegir tono`, fijar la cantidad con los controles reales y pulsar `Agregar` una vez.
7. Conservar agregados parciales y continuar después de faltantes o errores por producto.
8. Abrir el carrito, reconciliar cada CL y cantidad contra `products.json`, imprimir el resumen y cerrar el navegador.

No existe un paso de checkout. No pulsar `HACER MI PEDIDO` ni confirmar la compra.

## Entrada

Usar exclusivamente `<repo>/products.json`, con un array JSON no vacío:

```json
[
  { "code": "49774", "quantity": 1 },
  { "code": "47633", "quantity": 2 }
]
```

- Convertir `code` a texto sin espacios laterales.
- Exigir `quantity` entera y mayor o igual a 1.
- Preservar el orden y permitir códigos repetidos, igual que el runner original.
- Tratar `products.json.full` como respaldo manual, nunca como fallback automático.

## Configuración privada

Leer configuración desde `<repo>/.env` sin imprimir valores:

- `NOVAVENTA_USERNAME` y `NOVAVENTA_PASSWORD`: credenciales usadas únicamente por el login automático.
- `NOVAVENTA_LOGIN_MODE`: `auto` o `manual`. Si no se define, usar `auto` cuando ambas credenciales existen y `manual` cuando falta alguna.
- `NOVAVENTA_MANUAL_LOGIN`: compatibilidad heredada; `true` equivale a `manual` y `false` a `auto`. `NOVAVENTA_LOGIN_MODE` tiene precedencia.
- `HEADLESS`: `false` por defecto.
- `DEBUG_LOGS`: `true` por defecto.

Mantener `.env` y `.browser-profile-office` fuera de Git. Usar permisos `0600` para `.env`; el perfil puede contener cookies y datos de sesión.

Siempre intentar reutilizar una sesión válida antes de usar credenciales. Si el sitio exige reCAPTCHA, el modo visible puede continuar con intervención manual; no intentar evadirlo.

Usar `npm run skill:login-check` para comprobar autenticación de forma aislada. Ese modo termina después de autenticar y elegir Oficina Virtual, antes de abrir, vaciar o modificar el carrito.

## Resultado

El wrapper emite dos líneas estructuradas:

- `NOVAVENTA_SKILL_PREFLIGHT=<json>` antes de abrir el navegador.
- `NOVAVENTA_SKILL_RESULT=<json>` al terminar.

La comprobación aislada de login devuelve `report.event: "login-check"` y `report.authenticated: true`.

El resultado incluye `successfulProducts` y `errorProducts` cuando el flujo llega al resumen, incluso si `DEBUG_LOGS=false`.

Interpretar el resultado así:

- `completed`: el proceso terminó sin errores por producto conocidos.
- `completed_with_errors`: el carrito puede contener agregados correctos o parciales, pero hay uno o más errores por producto.
- `fatal`: falló el login, el vaciado, la navegación global o el proceso, o no se obtuvo un reporte terminal verificable.

El script original puede devolver código `0` aunque existan productos agotados, faltantes o parciales. Usar `report.errorCount`, `report.errorProducts` y `report.cartState` como fuentes principales.

## Artefactos de diagnóstico

Con `DEBUG_LOGS=true`, revisar el run más reciente bajo `logs/run-*`:

- `run.log`: salida humana.
- `events.jsonl`: eventos estructurados y `run-end`.
- `html/`: snapshots de página, tarjeta y carrito.

Las fallas por producto también pueden crear capturas en `screenshots/`. Estos archivos pueden revelar artículos, cupo o datos de cuenta; no publicarlos ni adjuntarlos sin autorización.

## Estados esperados por producto

- Agregado completo.
- Agregado parcial por límite.
- No encontrado.
- Agotado o no disponible.
- Límite por pedido.
- Puntos insuficientes.
- La mutación o la lectura final del carrito no confirmó la cantidad.
- Excepción puntual; continuar con el siguiente código.

El badge global muestra unidades pero no identifica el CL que cambió, y el aviso `Cantidad agregada` refleja estado local transitorio. La fuente de verdad es la mutación del carrito y la reconciliación final de cada fila visible con su cantidad.
