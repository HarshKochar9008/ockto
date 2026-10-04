import { migrate, pool } from './db.ts';

const applied = await migrate();
console.log(applied.length ? `applied: ${applied.join(', ')}` : 'schema up to date');
await pool.end();
