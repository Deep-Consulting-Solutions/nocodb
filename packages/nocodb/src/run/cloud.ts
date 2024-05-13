// todo: move to env
// defining at the top to override the default value in app.config.ts
process.env.NC_DASHBOARD_URL = process.env.NC_DASHBOARD_URL ?? '/';

import path from 'path';
import cors from 'cors';
import express from 'express';
import typeorm from 'typeorm';
import { setupReusablesAndRoutes } from 'src/reusables';
import { PSQLRecordOperationWatcher } from 'src/lib/elitesoftwareautomation/db/PSQLRecordOperationWatcher';
import { createIncidentLog } from 'src/lib/incidentLogger';

import {
  createDatabaseConnection,
  runMigrations,
} from 'src/databaseConnection';
import Noco from '~/Noco';

const server = express();
server.enable('trust proxy');
server.use(cors());
server.use(
  process.env.NC_DASHBOARD_URL ?? '/dashboard',
  express.static(path.join(__dirname, 'nc-gui')),
);
server.set('view engine', 'ejs');

server.use(async (err, _req, res, next) => {
  if (err) {
    console.log('Catch Error:', err);
    try {
      await createIncidentLog(
        {
          errorMessage: err?.message,
          errorStackTrace: err.stack || '',
          incidentTime: new Date(),
        },
        {},
        (defaultTitle) => {
          return `System triggered - ${defaultTitle}`;
        },
      );
    } catch (incidentErr) {
      return res.status(400).json({ msg: incidentErr.message });
    }
    return res.status(400).json({ msg: err.message });
  }
  next();
});

(async () => {
  let connection;
  if (!typeorm.getConnectionManager().has('default')) {
    connection = await createDatabaseConnection();
  } else {
    connection = typeorm.getConnectionManager().get('default');
  }
  await runMigrations(connection);
  await setupReusablesAndRoutes(server, connection);

  const httpServer = server.listen(process.env.PORT || 8080, async () => {
    console.log(`App started successfully.\nVisit -> ${Noco.dashboardUrl}`);
    if (
      process.env.ESA_SKIP_DB_RECORD_ACTION_EVENT_WATCHER_FOR_WEBHOOK !== 'true'
    ) {
      try {
        await PSQLRecordOperationWatcher.watchForWebhook(Noco._ncMeta);
      } catch (e) {
        const message = `${PSQLRecordOperationWatcher.name} could not be setup`;
        // TODO: report as incident

        process.stderr.write(
          `${message} : ${e?.message || e?.toString()}`,
          function () {
            // this is critical, as events needs to be fired as quick as possible to meet business/app requirement though they will be in notifications table waiting to be picked.
            // It is better the program is down so this should be taken more seriously.
            process.exit(1);
          },
        );
      }
    }
    server.use(await Noco.init({}, httpServer, server));
  });
})().catch((e) => {
  console.log(e);
});
