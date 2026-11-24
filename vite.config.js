import { defineConfig, loadEnv } from 'vite';

// In development, serve the Vercel Function in api/ from the Vite server so
// `npm run dev` works without `vercel dev`.
function devApi() {
  return {
    name: 'dev-api',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const path = req.url.split('?')[0];
        if (!/^\/api\/[a-z-]+$/.test(path)) return next();
        try {
          const mod = await server.ssrLoadModule(`${path}.js`);
          const handler = mod[req.method];
          if (!handler) {
            res.statusCode = 405;
            return res.end();
          }
          const chunks = [];
          for await (const c of req) chunks.push(c);
          const request = new Request(`http://${req.headers.host}${req.url}`, {
            method: req.method,
            headers: req.headers,
            body: ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(chunks),
          });
          const response = await handler(request);
          res.statusCode = response.status;
          response.headers.forEach((v, k) => res.setHeader(k, v));
          res.end(Buffer.from(await response.arrayBuffer()));
        } catch (err) {
          next(err);
        }
      });
    },
  };
}

export default defineConfig(({ mode }) => {
  // Server-side secrets (ANTHROPIC_API_KEY) from .env.local, for the dev API only.
  Object.assign(process.env, loadEnv(mode, process.cwd(), ''));
  return {
    plugins: [devApi()],
    build: {
      // three.js is most of the bundle (~150 kB gzipped); nothing to gain from splitting it.
      chunkSizeWarningLimit: 700,
    },
  };
});
