import fs from 'node:fs';
import http from 'node:http';
import worker from './worker.js';

// ponytail: thin adapter so the Worker handler runs anywhere Node runs (Docker, laptop)
const port = Number(process.env.PORT || 8080);
http
  .createServer(async (req, res) => {
    const path = req.url.split('?')[0];
    if (path === '/map' || path === '/map.html' || path.startsWith('/web/')) {
      const file = path === '/map' ? 'public/map.html' : `public${path}`;
      try {
        const body = fs.readFileSync(file);
        res.writeHead(200, { 'content-type': file.endsWith('.html') ? 'text/html' : 'text/javascript' });
        res.end(body);
      } catch { res.writeHead(404); res.end('not found'); }
      return;
    }
    const response = await worker.fetch(new Request(`http://localhost${req.url}`, { headers: req.headers }));
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  })
  .listen(port, () => console.log(`listening on ${port}`));
