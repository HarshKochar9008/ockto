// Fictional demo account and workspace, populated through the real pipeline:
// the documents are processed by the worker (start it before or after; Temporal queues the work).
import { makePdf, demoDocs } from '../scripts/demo-docs.ts';
import { one, pool } from './db.ts';
import { createWorkspace, signup, uploadDocument } from './service.ts';
import { connectTemporal } from './temporal.ts';

const EMAIL = 'demo@papertrail.test';
const PASSWORD = 'papertrail-demo';
const WORKSPACE = 'Northbridge MSc Data Science (demo)';

const temporal = await connectTemporal();
const user = (await one<{ id: string }>(pool, 'SELECT id FROM users WHERE email = $1', [EMAIL]))
  ?? await signup({ email: EMAIL, name: 'Alex Rivera (demo)', password: PASSWORD });

const existing = await one<{ id: string }>(pool, 'SELECT id FROM workspaces WHERE user_id = $1 AND name = $2', [user.id, WORKSPACE]);
const ws = existing ?? await createWorkspace(user.id, {
  name: WORKSPACE, process_type: 'university_application', institution: 'Northbridge University (fictional)',
  deadline: '2027-01-15', notes: 'Fictional demo data.',
});

for (const [filename, pages] of Object.entries(demoDocs)) {
  const role = filename.includes('requirements') ? 'requirements' : 'evidence';
  const { duplicate } = await uploadDocument(temporal, user.id, ws.id, { bytes: makePdf(pages), filename, declaredType: 'application/pdf', role });
  console.log(`${duplicate ? 'already uploaded' : 'uploaded'}: ${filename} (${role})`);
}

console.log(`\nSign in as ${EMAIL} / ${PASSWORD}`);
console.log('Next: open the workspace, confirm the extracted requirements, then run the analysis.');
await pool.end();
await temporal.connection.close();
