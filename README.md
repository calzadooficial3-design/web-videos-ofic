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

### Códigos de la demo

| Rol | Código |
| --- | --- |
| Administrador | `AUREA26` |
| Operante | `OPERA26` |
| Jefe | `JEFE26` |

El administrador puede cambiar estos códigos desde su panel. En la demo, la configuración se guarda en `localStorage`, por lo que solo persiste en el navegador actual.

## Funciones incluidas

- Login de una sola entrada que identifica el rol mediante el código.
- Secciones distintas en el sidebar de operante y jefe.
- Asignación de cada video a un rol y una sección específicos.
- Reproducción integrada de YouTube, Google Drive, Vimeo, Loom y archivos directos MP4/WebM/Ogg.
- Título, descripción, duración y opción de contenido destacado.
- Panel para crear, renombrar, ordenar, ocultar y eliminar secciones.
- Panel para crear, editar, buscar y eliminar videos.
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
- Redirección SPA hacia `index.html`

En Netlify puedes importar el repositorio y aceptar estos valores detectados.

## ¿Es necesario Supabase?

Para probar el diseño, no. Para publicar el sistema con datos reales, sí necesitas Supabase o un backend equivalente.

`localStorage` no es seguridad: los códigos y datos pueden inspeccionarse o modificarse desde el navegador y no se sincronizan entre dispositivos. En producción, Supabase debe encargarse de:

- Autenticar el código y crear una sesión.
- Guardar secciones, videos y asignaciones.
- Aplicar permisos RLS en la base de datos.
- Impedir que operante o jefe descarguen registros no autorizados.
- Guardar videos privados o generar enlaces temporales cuando corresponda.

La propuesta de tablas y políticas está en [`supabase/schema.sql`](supabase/schema.sql). La guía de conexión segura está en [`docs/SUPABASE.md`](docs/SUPABASE.md).

> No publiques la demo actual como sistema privado hasta conectar el backend. Ocultar contenido solo con React no constituye una barrera de seguridad.
