import { knownQueryParams } from 'src/utils/nc-config';
import { DataRecoveryActivity, ServerIncident } from './entities';
import { addIncidentHandlingTables1689942863738 } from './migrations/1689942863738-addIncidentHandlingTables';

const ormConfig = () => {
  const parsedQuery: any = {};
  let url: any = {};

  if (process.env.NC_DB) {
    url = new URL(process.env.NC_DB);

    for (const [key, value] of url.searchParams.entries()) {
      const fnd = knownQueryParams.find(
        (param) => param.parameter === key || param.aliases.includes(key),
      );
      if (fnd) {
        parsedQuery[fnd.parameter] = value;
      } else {
        parsedQuery[key] = value;
      }
    }
  }

  const config = {
    type: 'postgres',
    ...(process.env.NC_DB
      ? {
          host: url.hostname,
          port: +url.port,
          username: parsedQuery.user,
          password: parsedQuery.password,
          database: parsedQuery.database,
        }
      : {
          host: process.env.DB_HOST,
          port: +process.env.DB_PORT,
          username: process.env.DB_USER,
          password: process.env.DB_PASSWORD,
          database: process.env.DB_NAME,
        }),
    entities: [ServerIncident, DataRecoveryActivity],
    migrations: [addIncidentHandlingTables1689942863738],
    migrationsRun: false,
    cli: {
      migrationsDir: `src/database/migrations`,
    },
    synchronize: false,
    dropSchema: false,
  };
  return config;
};

module.exports = ormConfig();
