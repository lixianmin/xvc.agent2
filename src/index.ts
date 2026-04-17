import { Hono } from 'hono';
import { serveStatic } from 'hono/cloudflare-workers';

const app = new Hono();

app.get('/api/health', (c) => c.json({ status: 'ok' }));

app.get('/*', serveStatic({ root: './' }));

export default app;
