# Conexión segura con Supabase

## Arquitectura recomendada

```text
Supabase Auth
    └── profiles (rol)
          ├── section_roles ── sections
          └── video_assignments ── videos
```

Las políticas RLS deben ser la autoridad. React puede ocultar elementos para mejorar la interfaz, pero nunca debe decidir por sí solo qué datos puede descargar una sesión.

## Acceso únicamente mediante código

Para conservar el formulario de una sola entrada:

1. React envía el código a una Edge Function pública llamada `login-with-code`.
2. La función calcula una huella HMAC del código usando un secreto del servidor.
3. La función localiza la cuenta interna asociada sin guardar el código en texto plano.
4. Supabase Auth valida el código como contraseña de esa cuenta.
5. La función devuelve la sesión de Auth.
6. Las consultas posteriores quedan limitadas por el rol de `profiles` y las políticas RLS.

No guardes códigos, la clave secreta ni la clave `service_role` en variables `VITE_*`: cualquier variable con ese prefijo termina en el JavaScript público.

En el frontend solo deben existir:

```env
VITE_SUPABASE_URL=https://tu-proyecto.supabase.co
VITE_SUPABASE_PUBLISHABLE_KEY=tu-clave-publicable
```

Los secretos de servidor deben configurarse en Supabase Edge Functions:

```text
CODE_LOOKUP_PEPPER
SUPABASE_SECRET_KEY
```

## Reglas mínimas

- Código aleatorio de 16 caracteres o más; para administrador, 20–24.
- Error genérico ante un código incorrecto, sin revelar el rol.
- Límite de intentos por IP y CAPTCHA después de varios fallos.
- CORS restringido al dominio final de Netlify.
- Registro público desactivado.
- Rotación de códigos desde una función autenticada, no desde React directamente.
- Cierre de sesiones activas cuando se cambia un código.
- Cuenta individual y MFA para administradores si el sistema tendrá información sensible.

## Videos realmente privados

RLS protege el registro del video, pero no convierte en privado un enlace público de YouTube, Vimeo o Google Drive. Si el material no debe compartirse, usa un bucket privado de Supabase Storage y URLs firmadas de corta duración, o un proveedor de streaming privado.

El administrador debe pegar una URL permitida. La aplicación normaliza el ID de YouTube, Drive, Vimeo o Loom y crea el reproductor; nunca debe aceptar HTML de iframe proporcionado por el usuario.

## Documentación oficial

- [Supabase Auth](https://supabase.com/docs/guides/auth)
- [Row Level Security](https://supabase.com/docs/guides/database/postgres/row-level-security)
- [Seguridad de Edge Functions](https://supabase.com/docs/guides/functions/auth)
- [Secretos de Edge Functions](https://supabase.com/docs/guides/functions/secrets)
- [Desplegar Vite en Netlify](https://docs.netlify.com/build/frameworks/framework-setup-guides/vite/)
