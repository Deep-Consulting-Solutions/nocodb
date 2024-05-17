import dns from 'node:dns';
import path from 'path';
import cors from 'cors';
import express from 'express';
import { PSQLRecordOperationWatcher } from 'src/lib/elitesoftwareautomation/db/PSQLRecordOperationWatcher';
import { createIncidentLog } from 'src/lib/incidentLogger';
import Noco from '~/Noco';

// ref: https://github.com/nodejs/node/issues/40702#issuecomment-1103623246
dns.setDefaultResultOrder('ipv4first');

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
})().catch((e) => console.log(e));
