# Aurea Video Hub

Portal privado de videos creado con React + Vite. Incluye tres accesos diferenciados: administrador, operante y jefe.

## Ejecutar en Git Bash

```bash
npm install
npm run dev
```

Abre `http://localhost:5173`.

Para comprobar la conexión configurada con Supabase:

```bash
npm run check:supabase
```

La aplicación lee y guarda videos, secciones, configuración y permisos únicamente en Supabase. No existe almacenamiento local propio para contenido ni para el tema; solo Supabase Auth administra la sesión del usuario. Los códigos nunca se guardan en el bundle ni en texto plano en la base de datos.

## Funciones incluidas

- Login de una sola entrada que identifica el rol mediante el código.
- Secciones distintas en el sidebar de operante y jefe.
- Asignación de cada video a un rol y una sección específicos.
- Reproducción integrada de YouTube, Google Drive, Vimeo, Loom y archivos directos MP4/WebM/Ogg.
- Título, descripción, duración y opción de contenido destacado.
- Panel para crear, renombrar, ordenar, ocultar y eliminar secciones.
- Panel para crear, editar, buscar y eliminar videos.
- Configuración general de identidad, bienvenida, ayuda y modo claro.
- Guardado automático transaccional y versionado en Supabase, con lectura al iniciar y al volver a enfocar la página.
- Vista previa de permisos por rol.
- Tema negro/dorado y modo claro.
- Diseño responsive para escritorio, tablet y móvil.

## Compilar y desplegar en Netlify

```bash
npm run build
```

El archivo `netlify.toml` ya configura:

- Comando de build: `npm run build`
- Carpeta publicada: `dist`
- Functions: `netlify/functions`
- Redirección SPA hacia `index.html`

En Netlify configura estas variables y vuelve a desplegar:

```env
VITE_SUPABASE_URL=https://tu-proyecto.supabase.co
VITE_SUPABASE_PUBLISHABLE_KEY=tu-clave-publicable
SUPABASE_SECRET_KEY=tu-clave-secreta
ACCESS_CODE_PEPPER=valor-aleatorio-largo-y-privado
```

`SUPABASE_SECRET_KEY` y `ACCESS_CODE_PEPPER` deben marcarse como secretos y nunca llevar el prefijo `VITE_`. Las dos variables `VITE_*` se incluyen en el cliente por diseño; los secretos solo están disponibles para Netlify Functions. Genera el pepper con al menos 32 bytes aleatorios y mantenlo igual en tu entorno local y en Netlify.

Si agregas o cambias `ACCESS_CODE_PEPPER`, vuelve a ejecutar `npm run provision:supabase-roles` con los tres códigos actuales para regenerar sus huellas antes de desplegar.

## ¿Es necesario Supabase?

Sí. Esta versión usa Supabase como fuente de verdad para:

- Autenticar el código y crear una sesión.
- Guardar secciones, videos y asignaciones.
- Aplicar permisos RLS en la base de datos.
- Impedir que operante o jefe descarguen registros no autorizados.
- Guardar videos privados o generar enlaces temporales cuando corresponda.

Las migraciones versionadas están en [`supabase/migrations`](supabase/migrations), los datos iniciales en [`supabase/seed.sql`](supabase/seed.sql) y la guía de conexión segura en [`docs/SUPABASE.md`](docs/SUPABASE.md).

Antes del primer login ejecuta `npm run provision:supabase-roles` con los tres códigos solo en variables temporales; consulta la guía para el procedimiento completo.
