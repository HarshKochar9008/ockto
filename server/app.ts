// HTTP layer: parse + validate input, authenticate, call the service, shape the response.
// Ownership checks live in service.ts, next to the queries they protect.
import { existsSync } from 'node:fs';
import fastifyStatic from '@fastify/static';
import * as Sentry from '@sentry/node';
import Fastify, { type FastifyError, type FastifyRequest } from 'fastify';
import { z, ZodError } from 'zod';
import * as S from '../shared/schemas.ts';
import { SESSION_COOKIE, checkLogin, createSession, endSession, rateLimited, readCookie, sessionCookie, userForSession } from './auth.ts';
import { pool } from './db.ts';
import { MAX_UPLOAD_BYTES, UPLOAD_TYPES, safeFilename } from './documents.ts';
import * as svc from './service.ts';

declare module 'fastify' {
  interface FastifyRequest { user: S.Me | null }
}

const PUBLIC_ROUTES = new Set(['/api/v1/auth/signup', '/api/v1/auth/login', '/api/v1/auth/logout']);
const Id = z.uuid();
const UploadQuery = z.object({ role: z.enum(['requirements', 'evidence']).default('evidence'), inject_failure: z.string().optional() });

export function buildApp({ temporal, webDist }: { temporal: svc.Temporal; webDist?: string }) {
  const app = Fastify({
    logger: process.env.NODE_ENV === 'test' ? false : { level: process.env.LOG_LEVEL ?? 'info' },
    trustProxy: process.env.TRUST_PROXY === 'true',
  });
  Sentry.setupFastifyErrorHandler(app);
  app.decorateRequest('user', null);

  // Uploads arrive as the raw request body; the real type is sniffed from the bytes.
  app.removeContentTypeParser('text/plain');
  app.addContentTypeParser([...UPLOAD_TYPES, 'application/octet-stream'], { parseAs: 'buffer', bodyLimit: MAX_UPLOAD_BYTES },
    (_req, body, done) => done(null, body));

  app.addHook('onRequest', async (req, reply) => {
    // CSRF, defence in depth on top of the SameSite=Lax cookie: refuse cross-site writes.
    if (req.method !== 'GET' && req.method !== 'HEAD' && req.headers.origin) {
      let host: string | undefined;
      try { host = new URL(req.headers.origin).host; } catch { /* "null" or garbage */ }
      if (host !== req.headers.host) return reply.code(403).send({ error: 'Cross-origin request refused.' });
    }
    if (!req.url.startsWith('/api/') || PUBLIC_ROUTES.has(req.routeOptions.url ?? '')) return;
    req.user = (await userForSession(readCookie(req.headers.cookie, SESSION_COOKIE))) ?? null;
    if (!req.user) return reply.code(401).send({ error: 'Please sign in.' });
  });

  app.addHook('onSend', async (req, reply) => {
    reply.header('x-content-type-options', 'nosniff').header('referrer-policy', 'same-origin').header('x-frame-options', 'SAMEORIGIN');
    if (req.url.startsWith('/api/')) reply.header('cache-control', 'no-store');
    else reply.header('content-security-policy', "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; frame-src 'self' https:; object-src 'none'; base-uri 'none'; frame-ancestors 'self'");
  });

  app.setErrorHandler((err: FastifyError, req, reply) => {
    if (err instanceof ZodError) {
      return reply.code(400).send({ error: 'Invalid request.', issues: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) });
    }
    if (err instanceof svc.HttpError) return reply.code(err.status).send({ error: err.message });
    const status = err.statusCode ?? 500;
    if (status < 500) return reply.code(status).send({ error: err.message });
    req.log.error(err);
    return reply.code(500).send({ error: 'Something went wrong on our side. It has been reported.' });
  });

  const uid = (req: FastifyRequest) => req.user!.id;
  const param = (req: FastifyRequest, name = 'id') => Id.parse((req.params as Record<string, string>)[name]);
  const limit = (req: FastifyRequest, bucket: string, max: number) => {
    if (rateLimited(`${bucket}:${req.user?.id ?? req.ip}`, max)) throw new svc.HttpError(429, 'Too many requests. Please wait a minute.');
  };
  // Only honoured when the operator turned the demo switch on.
  const inject = (v: unknown) =>
    svc.demoFailureInjection && (S.INJECTABLE_ACTIVITIES as readonly unknown[]).includes(v) ? (v as string) : undefined;

  app.get('/healthz', async () => {
    await pool.query('SELECT 1');
    return { ok: true };
  });

  // ------------------------------------------------------------------- auth

  app.post('/api/v1/auth/signup', async (req, reply) => {
    limit(req, 'signup', 5);
    const user = await svc.signup(S.SignupInput.parse(req.body));
    return reply.code(201).header('set-cookie', sessionCookie(await createSession(user.id))).send(user);
  });

  app.post('/api/v1/auth/login', async (req, reply) => {
    limit(req, 'login', 10);
    const { email, password } = S.LoginInput.parse(req.body);
    const user = await checkLogin(email, password);
    if (!user) return reply.code(401).send({ error: 'Email or password is incorrect.' });
    return reply.header('set-cookie', sessionCookie(await createSession(user.id))).send(user);
  });

  app.post('/api/v1/auth/logout', async (req, reply) => {
    await endSession(readCookie(req.headers.cookie, SESSION_COOKIE));
    return reply.header('set-cookie', sessionCookie('', 0)).code(204).send();
  });

  app.get('/api/v1/auth/me', async (req) => req.user);
  app.get('/api/v1/system', async () => svc.systemStatus());
  app.get('/api/v1/dashboard', async (req) => svc.dashboard(uid(req)));

  // ------------------------------------------------------------- workspaces

  app.post('/api/v1/workspaces', async (req, reply) => reply.code(201).send(await svc.createWorkspace(uid(req), S.WorkspaceInput.parse(req.body))));
  app.get('/api/v1/workspaces', async (req) => svc.listWorkspaces(uid(req)));
  app.get('/api/v1/workspaces/:id', async (req) => svc.getWorkspace(uid(req), param(req)));
  app.patch('/api/v1/workspaces/:id', async (req) => svc.updateWorkspace(uid(req), param(req), S.WorkspacePatch.parse(req.body)));
  app.delete('/api/v1/workspaces/:id', async (req, reply) => {
    await svc.deleteWorkspace(temporal, uid(req), param(req));
    return reply.code(204).send();
  });

  // -------------------------------------------------------------- documents

  app.post('/api/v1/workspaces/:id/documents', { bodyLimit: MAX_UPLOAD_BYTES }, async (req, reply) => {
    limit(req, 'upload', 30);
    if (!Buffer.isBuffer(req.body)) throw new svc.HttpError(415, 'Send the file as the request body with its Content-Type (PDF, PNG, JPEG or text).');
    const q = UploadQuery.parse(req.query);
    // The name travels in a header, not the URL, so it stays out of access logs.
    let name = String(req.headers['x-filename'] ?? 'document');
    try { name = decodeURIComponent(name); } catch { /* keep as sent */ }
    const res = await svc.uploadDocument(temporal, uid(req), param(req), {
      bytes: req.body, filename: safeFilename(name), declaredType: req.headers['content-type'], role: q.role, injectFailure: inject(q.inject_failure),
    });
    return reply.code(res.duplicate ? 200 : 201).send(res);
  });
  app.get('/api/v1/workspaces/:id/documents', async (req) => svc.listDocuments(uid(req), param(req)));
  app.get('/api/v1/documents/:id', async (req) => svc.getDocument(uid(req), param(req)));
  app.get('/api/v1/documents/:id/file', async (req, reply) => {
    const f = await svc.documentFile(uid(req), param(req));
    if (f.url) return reply.redirect(f.url);
    return reply
      .header('content-type', f.mime === 'text/plain' ? 'text/plain; charset=utf-8' : f.mime)
      .header('content-disposition', `inline; filename*=UTF-8''${encodeURIComponent(f.filename)}`)
      .send(f.bytes);
  });
  app.post('/api/v1/documents/:id/retry', async (req, reply) =>
    reply.code(202).send(await svc.retryDocument(temporal, uid(req), param(req), inject((req.body as { inject_failure?: string } | undefined)?.inject_failure))));
  app.delete('/api/v1/documents/:id', async (req, reply) => {
    await svc.deleteDocument(temporal, uid(req), param(req));
    return reply.code(204).send();
  });

  // ----------------------------------------------------------- requirements

  app.post('/api/v1/workspaces/:id/requirements', async (req, reply) =>
    reply.code(201).send(await svc.addRequirement(uid(req), param(req), S.RequirementInput.parse(req.body))));
  app.post('/api/v1/workspaces/:id/requirements/extract', async (req, reply) => {
    limit(req, 'upload', 30);
    const body = S.RequirementsTextInput.extend({ inject_failure: z.string().optional() }).parse(req.body);
    return reply.code(202).send(await svc.extractRequirementsFromText(temporal, uid(req), param(req), body.text, inject(body.inject_failure)));
  });
  app.post('/api/v1/workspaces/:id/requirements/confirm', async (req) => svc.confirmRequirements(uid(req), param(req)));
  app.get('/api/v1/workspaces/:id/requirements', async (req) => svc.listRequirements(uid(req), param(req)));
  app.get('/api/v1/requirements/:id', async (req) => svc.getRequirement(uid(req), param(req)));
  app.patch('/api/v1/requirements/:id', async (req) => svc.updateRequirement(uid(req), param(req), S.RequirementPatch.parse(req.body)));
  app.delete('/api/v1/requirements/:id', async (req, reply) => {
    await svc.deleteRequirement(uid(req), param(req));
    return reply.code(204).send();
  });

  // --------------------------------------------------------------- analysis

  app.post('/api/v1/workspaces/:id/analyze', async (req, reply) => {
    limit(req, 'analyze', 10);
    const body = S.AnalyzeInput.parse(req.body ?? {});
    return reply.code(202).send(await svc.analyze(temporal, uid(req), param(req), inject(body.inject_failure)));
  });
  app.get('/api/v1/workspaces/:id/analysis', async (req) => svc.getAnalysis(uid(req), param(req)));
  app.patch('/api/v1/checklist/:id', async (req) => svc.reviewChecklistItem(uid(req), param(req), S.ChecklistPatch.parse(req.body)));

  // ------------------------------------------------------ tasks & reminders

  app.post('/api/v1/workspaces/:id/tasks', async (req, reply) => reply.code(201).send(await svc.createTask(uid(req), param(req), S.TaskInput.parse(req.body))));
  app.get('/api/v1/workspaces/:id/tasks', async (req) => svc.listTasks(uid(req), param(req)));
  app.patch('/api/v1/tasks/:id', async (req) => svc.updateTask(temporal, uid(req), param(req), S.TaskPatch.parse(req.body)));
  app.delete('/api/v1/tasks/:id', async (req, reply) => {
    await svc.deleteTask(temporal, uid(req), param(req));
    return reply.code(204).send();
  });
  app.post('/api/v1/tasks/:id/reminders', async (req, reply) => {
    const body = S.ReminderInput.parse(req.body);
    return reply.code(201).send(await svc.scheduleReminders(temporal, uid(req), param(req), { ...body, inject_failure: inject(body.inject_failure) }));
  });
  app.delete('/api/v1/tasks/:id/reminders', async (req) => svc.cancelTaskReminders(temporal, uid(req), param(req)));

  // ---------------------------------------------- search, assistant, activity

  app.post('/api/v1/workspaces/:id/search', async (req) => {
    limit(req, 'search', 30);
    return svc.search(uid(req), param(req), S.SearchInput.parse(req.body).query);
  });
  app.post('/api/v1/workspaces/:id/ask', async (req) => {
    limit(req, 'ask', 10);
    return svc.ask(uid(req), param(req), S.AskInput.parse(req.body).question);
  });
  app.get('/api/v1/workspaces/:id/activity', async (req) => svc.activity(uid(req), param(req)));
  app.get('/api/v1/workspaces/:id/workflows/:workflowId', async (req) =>
    svc.workflowRun(temporal, uid(req), param(req), z.string().max(200).parse((req.params as { workflowId: string }).workflowId)));
  app.get('/api/v1/workspaces/:id/report.csv', async (req, reply) => {
    const { filename, csv } = await svc.reportCsv(uid(req), param(req));
    return reply.header('content-type', 'text/csv; charset=utf-8').header('content-disposition', `attachment; filename="${filename}"`).send(csv);
  });

  // ----------------------------------------------------- built web app (prod)

  if (webDist && existsSync(webDist)) {
    app.register(fastifyStatic, { root: webDist });
    app.setNotFoundHandler((req, reply) =>
      req.method === 'GET' && !req.url.startsWith('/api/') ? reply.sendFile('index.html') : reply.code(404).send({ error: 'Not found.' }));
  }

  return app;
}
