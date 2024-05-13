import dns from 'node:dns';
import cors from 'cors';
import express from 'express';
import { getConnectionManager } from 'typeorm';
import Noco from '~/Noco';
import { createDatabaseConnection, runMigrations } from '../databaseConnection';
import { setupReusablesAndRoutes } from '../reusables';
import type { Connection } from 'typeorm';

// ref: https://github.com/nodejs/node/issues/40702#issuecomment-1103623246
dns.setDefaultResultOrder('ipv4first');

const server = express();
server.enable('trust proxy');
server.disable('etag');
server.disable('x-powered-by');
server.use(
  cors({
    exposedHeaders: 'xc-db-response',
  }),
);

server.set('view engine', 'ejs');

process.env[`DEBUG`] = 'xc*';

// (async () => {
//   await nocobuild(server);
//   const httpServer = server.listen(process.env.PORT || 8080, async () => {
//     console.log('Server started');
//   });
// })().catch((e) => console.log(e));

(async () => {
  let connection: Connection;
  if (!getConnectionManager().has('default')) {
    connection = await createDatabaseConnection();
  } else {
    connection = getConnectionManager().get('default');
  }
  await runMigrations(connection);
  await setupReusablesAndRoutes(server, connection);

  const httpServer = server.listen(process.env.PORT || 8080, async () => {
    server.use(await Noco.init({}, httpServer, server));
  });
})().catch((e) => console.log(e));
