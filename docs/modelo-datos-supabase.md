# Modelo de datos para Supabase

Objetivo: pasar de login local y presupuestos/propuestas en borrador a un sistema persistente con clientes, permisos por tarifario, historial de analisis, calculos y envios.

Supuesto funcional:
- ONUS administra la herramienta.
- Los clientes entran en la app y generan sus propias peticiones/propuestas.
- La informacion no se considera confidencial critica, por lo que priorizamos acceso simple y gestionable.
- ONUS debe poder crear, ver, modificar, activar o desactivar usuarios desde la app.
- Los clientes solo ven su tarifario asignado y sus propias propuestas.

## Tablas base

### access_users

Usuarios simples que acceden a la app. No dependemos inicialmente de un sistema complejo de contrasenas. ONUS puede crear y modificar estos accesos desde la propia herramienta.

Campos:
- `id`: uuid, primary key.
- `name`: texto visible del usuario.
- `login_code`: codigo de acceso legible, por ejemplo `meteor`, `districenter`, `onus`.
- `pin`: codigo/PIN editable por ONUS.
- `role`: `admin` o `client`.
- `client_id`: referencia opcional a `clients.id`.
- `can_view_all_tariffs`: boolean, por defecto false.
- `created_at`: timestamp.
- `updated_at`: timestamp.
- `last_login_at`: timestamp opcional.
- `is_active`: boolean.

Regla:
- ONUS sera `admin`.
- Meteor y Districenter seran `client`.
- Admin puede ver y editar todos los accesos.
- Cliente no puede ver ni editar accesos.

Nota:
- Si mas adelante queremos seguridad completa, esta tabla puede convivir con Supabase Auth o migrarse a Supabase Auth.
- En esta primera fase el acceso puede ser `cliente + PIN`.
- Para no guardar PIN en claro en produccion, idealmente se guarda un `pin_hash`. Si preferimos maxima simplicidad operativa, podemos empezar con PIN visible y luego endurecerlo.

### clients

Empresas o clientes operativos.

Campos:
- `id`: uuid, primary key.
- `name`: nombre comercial.
- `code`: codigo interno legible, por ejemplo `onus`, `meteor`, `districenter`.
- `contact_email`: email principal.
- `billing_email`: email de facturacion opcional.
- `phone`: opcional.
- `notes`: texto opcional.
- `created_at`: timestamp.
- `is_active`: boolean.

Regla:
- Un cliente puede tener uno o varios `access_users`.
- Un cliente puede tener uno o varios tarifarios, aunque lo normal sera uno.

### tariffs

Tarifarios disponibles.

Campos:
- `id`: uuid, primary key.
- `code`: `onus-express-2026`, `meteor`, `districenter`.
- `name`: nombre visible.
- `description`: descripcion.
- `source_file`: nombre del archivo origen.
- `version`: version legible.
- `engine_key`: clave del motor de calculo, por ejemplo `onus`, `meteor`, `districenter`.
- `data`: jsonb con el tarifario estructurado.
- `created_at`: timestamp.
- `updated_at`: timestamp.
- `is_active`: boolean.

### client_tariffs

Relacion entre cliente y tarifario permitido.

Campos:
- `id`: uuid, primary key.
- `client_id`: referencia a `clients.id`.
- `tariff_id`: referencia a `tariffs.id`.
- `is_default`: boolean.
- `created_at`: timestamp.

Regla:
- ONUS puede ver todos los tarifarios por rol `admin`.
- Meteor solo tendra relacion con Meteor.
- Districenter solo tendra relacion con Districenter.

## Operativa de IA y calculo

### analyses

Cada analisis realizado por la IA o por fallback local.

Campos:
- `id`: uuid, primary key.
- `client_id`: referencia a `clients.id`.
- `tariff_id`: referencia a `tariffs.id`.
- `created_by`: referencia a `access_users.id`.
- `input_text`: texto escrito por el usuario.
- `input_files`: jsonb con nombres/tipos de adjuntos.
- `summary`: resumen entendido.
- `pricing_request`: jsonb con parametros editables.
- `missing_data`: jsonb/lista.
- `detected_criteria`: jsonb/lista.
- `ai_model`: texto opcional.
- `status`: `draft`, `approved`, `priced`, `failed`.
- `created_at`: timestamp.
- `approved_at`: timestamp opcional.

### quotes

Tarifas calculadas y listas para presupuesto/propuesta.

Campos:
- `id`: uuid, primary key.
- `analysis_id`: referencia a `analyses.id`.
- `client_id`: referencia a `clients.id`.
- `tariff_id`: referencia a `tariffs.id`.
- `created_by`: referencia a `access_users.id`.
- `document_type`: `budget` o `proposal`.
- `pricing_result`: jsonb con resultado completo del motor.
- `lines`: jsonb con desglose.
- `base_amount`: numeric.
- `vat_percentage`: numeric.
- `vat_amount`: numeric.
- `total_amount`: numeric.
- `currency`: texto, por defecto `EUR`.
- `status`: `draft`, `sent`, `accepted`, `rejected`, `expired`.
- `created_at`: timestamp.
- `updated_at`: timestamp.

Regla:
- Admin genera `budget` / presupuesto.
- Cliente genera `proposal` / propuesta.
- Cuando un cliente calcula y envia desde su cuenta, por defecto se genera `proposal`.
- Cuando ONUS calcula para un cliente, por defecto se genera `budget`.

### quote_messages

Borradores y envios de email.

Campos:
- `id`: uuid, primary key.
- `quote_id`: referencia a `quotes.id`.
- `recipient_email`: email destino.
- `subject`: asunto.
- `body`: cuerpo enviado.
- `provider`: `local`, `resend`, `brevo` u otro.
- `provider_message_id`: texto opcional.
- `status`: `draft`, `sent`, `failed`.
- `error_message`: texto opcional.
- `created_at`: timestamp.
- `sent_at`: timestamp opcional.

### quote_events

Historial de acciones.

Campos:
- `id`: uuid, primary key.
- `quote_id`: referencia a `quotes.id`.
- `actor_id`: referencia opcional a `access_users.id`.
- `event_type`: `created`, `edited`, `calculated`, `sent`, `accepted`, `rejected`, `expired`.
- `details`: jsonb.
- `created_at`: timestamp.

## Adjuntos

### analysis_files

Metadatos de documentos subidos.

Campos:
- `id`: uuid, primary key.
- `analysis_id`: referencia a `analyses.id`.
- `file_name`: nombre original.
- `mime_type`: tipo MIME.
- `storage_path`: ruta en Supabase Storage.
- `extracted_text`: texto extraido opcional.
- `created_at`: timestamp.

## Permisos RLS recomendados

Admin:
- Puede leer y escribir todo.
- Puede crear, modificar y desactivar `access_users`.
- Puede cambiar PIN/codigo de acceso.
- Puede asignar tarifarios a clientes.

Cliente:
- Solo puede leer su `client`.
- Solo puede leer los tarifarios asociados en `client_tariffs`.
- Solo puede crear y leer sus `analyses`, `quotes`, `quote_messages` y `quote_events`.
- No puede editar tarifarios.
- No puede ver otros clientes.
- No puede ver ni editar usuarios.

## Orden de implementacion

1. Crear proyecto Supabase.
2. Crear tablas `clients`, `access_users`, `tariffs`, `client_tariffs`.
3. Migrar login local a login simple contra `access_users`.
4. Guardar analisis en `analyses`.
5. Guardar calculos en `quotes`.
6. Guardar borradores/envios en `quote_messages`.
7. Activar historial con `quote_events`.
8. Conectar email real con Resend o Brevo.

## Pantalla de administracion minima

ONUS necesita una vista sencilla para gestionar accesos y tarifarios.

Funciones:
- Crear cliente.
- Crear usuario de acceso para cliente.
- Editar nombre, codigo y PIN.
- Activar/desactivar usuario.
- Asignar tarifario permitido.
- Ver ultimos analisis/propuestas de cada cliente.
- Entrar como cliente para soporte, opcional.

Campos visibles en tabla:
- Cliente.
- Usuario/codigo.
- Rol.
- Tarifario asignado.
- Estado.
- Ultimo acceso.
- Acciones: editar, desactivar, cambiar PIN.
