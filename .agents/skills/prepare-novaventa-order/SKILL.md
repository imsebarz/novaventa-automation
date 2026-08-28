---
name: prepare-novaventa-order
description: Preparar y reemplazar el carrito de la Oficina Virtual de Novaventa desde el archivo products.json del repo. Usar cuando el usuario pida armar, repetir, cargar o ejecutar un pedido de Novaventa por códigos y cantidades; vaciar el carrito existente, agregar lo disponible, detectar faltantes o límites y entregar un resumen sin finalizar la compra. Invocar explícitamente porque modifica el carrito real.
---

# Preparar pedido Novaventa

## Objetivo

Orquestar el runner determinístico del repo para conservar exactamente su comportamiento. Dejar el carrito preparado y nunca pulsar `HACER MI PEDIDO`, entrar al checkout ni confirmar una compra.

## Ejecutar el flujo

1. Resolver la raíz con `git rev-parse --show-toplevel` y confirmar que contiene `script.js`, `package.json` y `products.json`.
2. Leer [references/behavior-contract.md](references/behavior-contract.md) antes de ejecutar. Tratar ese archivo como el contrato de efectos, entradas y resultados.
3. Confirmar que la petición autoriza reemplazar o vaciar el carrito. Considerar suficiente una petición explícita como “reemplaza el carrito”, “arma el pedido desde cero” o el prompt predeterminado de esta skill. Si solo pide agregar productos y no autoriza perder el carrito actual, detenerse y preguntar antes de lanzar el runner.
4. No leer ni mostrar valores de `.env`, cookies o archivos del perfil. No copiar `.browser-profile-office`, `logs/` ni `screenshots/` dentro de la skill.
5. Ejecutar el preflight desde la raíz:

   ```bash
   npm run skill:check
   ```

6. Si faltan dependencias, ejecutar `npm ci` y repetir el preflight. No modificar `products.json`; sus cambios pertenecen al usuario.
7. Lanzar el flujo con TTY. El runner reutiliza la sesión guardada; si expiró, usa el login automático cuando `.env` contiene ambas credenciales y el modo efectivo es `auto`:

   ```bash
   npm run skill:run
   ```

8. Mantener la sesión del comando y seguir su salida. Si el modo es `manual` o Novaventa exige reCAPTCHA, indicar al usuario que complete el login en la ventana abierta y que avise cuando esté listo; después enviar ENTER a la misma sesión. No pedir, leer ni transcribir credenciales en el chat.
9. Esperar hasta `NOVAVENTA_SKILL_RESULT=...`. No confundir código de salida `0` con éxito total: revisar `status`, `report.successCount`, `report.errorCount`, `report.errorProducts` y la reconciliación `report.cartState` del resultado.
10. Entregar un resumen con referencias agregadas, parciales o fallidas, motivo por código y resumen final del carrito. Indicar siempre que el pedido quedó sin enviar.

## Recuperar fallos

- Si otro proceso posee el lock, no iniciar un segundo run. Verificar primero si el PID reportado sigue activo.
- Si caducó la sesión, dejar que el modo efectivo decida el flujo: `auto` usa las credenciales privadas de `.env`; `manual` espera al usuario. Si Novaventa exige reCAPTCHA, completar ese paso manualmente en la ventana visible.
- Para validar únicamente el login sin abrir ni modificar el carrito, ejecutar `npm run skill:login-check`. Exigir que el resultado contenga `report.event: "login-check"` y `report.authenticated: true`.
- Si cambió la interfaz o fallan selectores, revisar el último `logs/run-*` y ejecutar `npm run inspect -- <codigo>` con un solo código representativo. Usar la evidencia para reparar `script.js`; no improvisar clics alternativos durante un pedido real.
- Si el proceso termina sin `run-end`, reportar el error global y la ruta del run diagnóstico más reciente.
- No usar `products.json.full` a menos que el usuario lo pida explícitamente.

## Límites

- Ejecutar una sola instancia a la vez.
- Conservar el perfil y los artefactos fuera de la skill y fuera de Git.
- No borrar logs, capturas o perfiles sin una petición explícita.
- No avanzar más allá del carrito bajo ninguna circunstancia.
