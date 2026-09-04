const { Pool } = require('pg');
const pool = new Pool({host:process.env.DB_HOST, port:process.env.DB_PORT, database:process.env.DB_NAME, user:process.env.DB_USER, password:process.env.DB_PASSWORD, max:5});
const excluded = ['spatial_ref_sys','__EFMigrationsHistory','session'];
const qi = s => '"' + String(s).replaceAll('"','""') + '"';
async function tables(){const {rows}=await pool.query(`SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE' AND table_name <> ALL($1) ORDER BY table_name`,[excluded]); return rows.map(r=>r.table_name)}
async function columns(table){const {rows}=await pool.query(`SELECT c.column_name,c.data_type,c.udt_name,c.is_nullable,c.column_default,c.is_identity,c.is_generated, CASE WHEN tc.constraint_type='PRIMARY KEY' THEN true ELSE false END is_pk FROM information_schema.columns c LEFT JOIN information_schema.key_column_usage k ON k.table_schema=c.table_schema AND k.table_name=c.table_name AND k.column_name=c.column_name LEFT JOIN information_schema.table_constraints tc ON tc.constraint_name=k.constraint_name AND tc.table_schema=k.table_schema WHERE c.table_schema='public' AND c.table_name=$1 ORDER BY c.ordinal_position`,[table]); return rows}
async function primaryKey(table){return (await columns(table)).filter(c=>c.is_pk)}
module.exports={pool,qi,tables,columns,primaryKey,excluded};
