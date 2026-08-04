# Conexión segura con Supabase

## Arquitectura recomendada

```text
organizations ── app_settings
      │
      ├── profiles ── auth.users
      ├── sections ── section_roles
      └── videos ── video_assignments
              └── video_sources
```

Las políticas RLS deben ser la autoridad. React puede ocultar elementos para mejorar la interfaz, pero nunca debe decidir por sí solo qué datos puede descargar una sesión.

La fuente del video está separada de sus metadatos. Un usuario puede recibir la tarjeta de un video bloqueado desde `videos` y `video_assignments`, pero RLS impide que lea `video_sources` hasta que `is_locked` sea falso para su rol.

## Migraciones

El esquema completo está en:

```text
supabase/migrations/20260804000000_video_hub_schema.sql
supabase/migrations/20260804010000_require_code_sessions.sql
supabase/migrations/20260804020000_atomic_admin_snapshot.sql
```

Incluye:

- Organizaciones y configuración visual.
- Perfiles `admin`, `operator` y `boss`.
- Secciones visibles independientemente por rol.
- Metadatos, fuentes y asignaciones de videos.
- Bloqueo independiente por rol sin filtrar el enlace.
- Auditoría preparada para eventos administrativos.
- Índices de códigos en esquema privado, sin texto plano.
- Bucket privado `video-assets` y políticas de Storage.
- Restricciones, índices, triggers de actualización y RLS.
- Guardado administrativo atómico y versionado: secciones, videos, fuentes, permisos y configuración se confirman juntos o se revierten juntos; una pestaña antigua no puede sobrescribir otra más reciente.
- Eliminación recuperable: la RPC archiva secciones y videos omitidos en vez de destruir sus relaciones históricas.

Para aplicarlo con el flujo recomendado:

```bash
npx supabase login
npx supabase link --project-ref mlrjcxxwzjqzdebqpfpx
npx supabase db push --dry-run
npx supabase db push
```

Después, carga `supabase/seed.sql` si quieres iniciar con las secciones y videos de ejemplo. Verifica el resultado con:

```bash
npm run check:supabase-schema
```

Si el comando muestra `PENDIENTE`, aplica en orden las migraciones indicadas y ejecútalo nuevamente; las tablas pueden estar disponibles mientras las RPC de hardening aún no lo están.

La clave publicable y la secret key de API no sustituyen el acceso administrativo de migraciones. `db push` necesita una sesión de Supabase y puede solicitar la contraseña de PostgreSQL.

## Acceso únicamente mediante código

Para conservar el formulario de una sola entrada:

1. React envía el código a la Netlify Function `login-with-code`.
2. La función calcula una huella HMAC usando `ACCESS_CODE_PEPPER` solo en el servidor.
3. La RPC privada localiza el rol y la cuenta interna sin almacenar ni devolver el código en texto plano.
4. La función genera y verifica internamente un magic link de Supabase Auth; el código nunca se usa como contraseña de Auth.
5. React instala la sesión recibida y carga los datos permitidos.
6. Todas las lecturas y escrituras posteriores quedan limitadas por `profiles` y las políticas RLS.

No guardes códigos, la clave secreta ni la clave `service_role` en variables `VITE_*`: cualquier variable con ese prefijo termina en el JavaScript público.

En el frontend solo deben existir:

```env
VITE_SUPABASE_URL=https://tu-proyecto.supabase.co
VITE_SUPABASE_PUBLISHABLE_KEY=tu-clave-publicable
```

Los secretos de servidor deben configurarse en Netlify, sin prefijo `VITE_`:

```text
SUPABASE_SECRET_KEY
ACCESS_CODE_PEPPER
```

La tabla `private.role_access_codes` solo guarda una huella HMAC. Las Netlify Functions invocan las RPC reservadas a `service_role`; el frontend nunca puede consultar la tabla privada ni usar la secret key. `ACCESS_CODE_PEPPER` debe ser un valor aleatorio de al menos 32 bytes y distinto de las claves de Supabase.

Existe un fallback temporal que usa `SUPABASE_SECRET_KEY` si el pepper no está configurado para no romper instalaciones existentes. Antes de producción configura un pepper propio y vuelve a ejecutar el aprovisionador con los tres códigos actuales; las huellas creadas con el valor anterior dejan de coincidir.

## Aprovisionar las tres cuentas internas

Después de aplicar las migraciones y `supabase/seed.sql`, configura temporalmente un código diferente para cada rol y ejecuta:

```bash
ADMIN_ACCESS_CODE='codigo-administrador' \
OPERATOR_ACCESS_CODE='codigo-operante' \
BOSS_ACCESS_CODE='codigo-jefe' \
npm run provision:supabase-roles
```

En PowerShell, establece esas tres variables con `$env:NOMBRE='valor'` y luego ejecuta el mismo comando npm. El script lee la URL, las claves y `ACCESS_CODE_PEPPER` desde el entorno o `.env`, crea o actualiza las cuentas con contraseñas Auth aleatorias e independientes, sincroniza `public.profiles` y registra solo huellas HMAC mediante `service_upsert_access_code`.

Los correos internos se generan con valores no entregables. Si necesitas personalizarlos, usa `ADMIN_AUTH_EMAIL`, `OPERATOR_AUTH_EMAIL` y `BOSS_AUTH_EMAIL`. No guardes los códigos en Git ni los configures como variables `VITE_*`; elimínalos del entorno después del aprovisionamiento.

## Reglas mínimas

- La rotación exige al menos 8 caracteres; usa 16 o más y 20–24 para administrador.
- Error genérico ante un código incorrecto, sin revelar el rol.
- Límite separado por código e IP; añade CAPTCHA si el portal estará expuesto a tráfico público no confiable.
- Peticiones de login JSON y mismo sitio; el endpoint rechaza envíos `cross-site` del navegador.
- Registro público desactivado.
- Rotación transaccional de las tres huellas desde una Netlify Function autenticada, nunca desde React directamente.
- Revocación de refresh tokens de los tres roles cuando cambian los códigos. Los JWT ya emitidos siguen vigentes hasta su expiración configurada en Supabase.
- Cuenta individual y MFA para administradores si el sistema tendrá información sensible.

## Videos realmente privados

RLS protege el registro del video, pero no convierte en privado un enlace público de YouTube, Vimeo o Google Drive. Si el material no debe compartirse, usa un bucket privado de Supabase Storage y URLs firmadas de corta duración, o un proveedor de streaming privado.

El administrador debe pegar una URL permitida. La aplicación normaliza el ID de YouTube, Drive, Vimeo o Loom y crea el reproductor; nunca debe aceptar HTML de iframe proporcionado por el usuario.

## Documentación oficial

- [Supabase Auth](https://supabase.com/docs/guides/auth)
- [Row Level Security](https://supabase.com/docs/guides/database/postgres/row-level-security)
- [Generar magic links en servidor](https://supabase.com/docs/reference/javascript/auth-admin-generatelink)
- [Variables de entorno de Netlify Functions](https://docs.netlify.com/build/functions/environment-variables/)
- [Desplegar Vite en Netlify](https://docs.netlify.com/build/frameworks/framework-setup-guides/vite/)
