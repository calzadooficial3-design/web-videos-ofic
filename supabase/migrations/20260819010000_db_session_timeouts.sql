begin;

-- Salvaguarda permanente: si una conexión de PostgREST (rol `authenticator`)
-- queda "idle in transaction" -por ejemplo, un cliente que se desconecta a
-- medio guardar, sin enviar commit ni rollback- se queda sosteniendo
-- cualquier candado que ya haya tomado (como el advisory lock de
-- save_admin_snapshot) indefinidamente, bloqueando el resto de guardados de
-- esa organización y, si se acumulan varias, agotando el pool de conexiones
-- para TODA la base de datos. Nos pasó dos veces en la misma tarde. Postgres
-- ahora cierra sola cualquier sesión que quede inactiva a medio transacción
-- por más de 20 segundos, así nunca vuelve a requerir un pg_terminate_backend
-- manual.
alter role authenticator set idle_in_transaction_session_timeout = '20s';

-- Red de seguridad adicional: ninguna consulta individual debería tardar más
-- de 30 segundos en este proyecto; si alguna vez se queda corriendo de
-- verdad (no solo inactiva a medio transacción), también se corta en vez de
-- consumir una conexión para siempre.
alter role authenticator set statement_timeout = '30s';

commit;
