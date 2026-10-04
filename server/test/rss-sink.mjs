import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

/**
 * A local stand-in for the Goodreads feed, so the whole sync loop is testable
 * with no network. Pointed at by GOODREADS_BASE_URL.
 *
 * Serves the fixture on page 1 of each shelf and an empty feed afterwards,
 * which is exactly the "short page terminates the walk" shape the real endpoint
 * produces.
 */
const EMPTY = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel><title>empty</title></channel></rss>`;

export function startRssSink({ failWith = null, items = null, emptyShelves = [] } = {}) {
  const fixture = readFileSync(join(here, 'fixtures', 'list_rss_read.xml'), 'utf8');
  const empty = readFileSync(join(here, 'fixtures', 'list_rss_empty.xml'), 'utf8');
  let requests = 0;

  const server = createServer((req, res) => {
    requests += 1;
    const url = new URL(req.url, 'http://localhost');
    if (failWith) {
      res.writeHead(failWith, { 'content-type': 'text/plain' });
      return res.end('nope');
    }
    const page = Number(url.searchParams.get('page') ?? '1');
    const shelf = url.searchParams.get('shelf') ?? '';
    res.writeHead(200, { 'content-type': 'application/rss+xml' });
    // A shelf the caller declared empty answers with a well-formed, item-less
    // feed -- exactly what Goodreads does for, say, an empty currently-reading.
    if (emptyShelves.includes(shelf)) return res.end(empty);
    res.end(page === 1 ? (items ?? fixture) : EMPTY);
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        url: `http://127.0.0.1:${port}`,
        requests: () => requests,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}
