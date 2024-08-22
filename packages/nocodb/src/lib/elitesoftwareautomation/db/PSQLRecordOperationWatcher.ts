import EventEmitter from 'events';
import { isEqual, merge, pick } from 'lodash';
import { nocoExecute } from 'nc-help';
import { Hook, Model, Project } from '../../models';
import { XKnex } from '../../db/sql-data-mapper';
import { MetaTable } from '../../utils/globals';
import NcConnectionMgrv2 from '../../utils/common/NcConnectionMgrv2';
import getAst from '../../db/sql-data-mapper/lib/sql/helpers/getAst';
import { sanitize } from '../../db/sql-data-mapper/lib/sql/helpers/sanitize';
import { invokeWebhook } from '../../meta/helpers/webhookHelpers';
import type NcMetaIO from '../../meta/NcMetaIO';
import type { HookType } from 'nocodb-sdk';
import type { Base } from '../../models';
import type Connection from 'mysql2/typings/mysql/lib/Connection';

export type PSQLRecordOperationEvent = {
  base: Base;
  operation: 'delete' | 'create' | 'update';
  model: Model;
  oldData: Record<string, any>;
  newData: Record<string, any>;
};

type IBaseData = {
  base: Base;
  models: Model[];
  knex: XKnex;
  connectionOptions: { [k: string]: any; database: string };
  throttleTaskId?: ReturnType<typeof setTimeout> | null;
};

type ISQLNotificationData = {
  channel: string;
  payload: string;
};

const regexForCharactersToReplace = /-/g;

/**
 * - Treats all sql resources under the prefix as its own
 */
export class PSQLRecordOperationWatcher extends EventEmitter {
  public readonly recordOperationEventType = 'record-operation';
  private readonly rewatchErrorRetryDelayMillis = 3000;
  private readonly throttleDelayMillis = parseInt(process.env.THROTTLE_DELAY_MILLIS) || 5000;
  private readonly consumptionBatchCount = 30;

  // NOTE: the objects stored here are used for compare by reference in various parts of the program
  private readonly allBaseData: Map<string, IBaseData> = new Map();

  constructor(private ncMeta: NcMetaIO) {
    super();
  }

  private log(
    message: string,
    extraData?: any,
    level: 'log' | 'error' | 'warn' | 'info' = 'log'
  ) {
    console[level](
      `${PSQLRecordOperationWatcher.name} : ${message}`,
      extraData
    );
  }

  private throttleAndConsumeNotifications(
    baseData: IBaseData,
    delayMillis?: number
  ) {
    if (baseData.throttleTaskId != undefined) return;

    baseData.throttleTaskId = setTimeout(() => {
      this.consumeNotifications(baseData);
    }, delayMillis || this.throttleDelayMillis);
  }

  private async convertDBDataToModelData(
    baseData: IBaseData,
    model: Model,
    dbData: Record<string, any>
  ) {
    const columns = await model.getColumns();

    let modelData = columns.reduce(
      (modelData, column) => ({
        ...modelData,
        [sanitize(column.title || column.column_name)]: sanitize(
          dbData[column.column_name]
        ),
      }),
      {} as Record<string, any>
    );

    const baseModel = await Model.getBaseModelSQL({
      id: model.id,
      dbDriver: await NcConnectionMgrv2.get(baseData.base),
    });

    if (modelData) {
      const proto = await baseModel.getProto();
      modelData.__proto__ = proto;
    }

    // retrieve virtual column data as well
    const { ast } = await getAst({ model });
    modelData = await nocoExecute(ast, modelData, {});
    return modelData;
  }

  // should be called by throttle task
  private async consumeNotifications(baseData: IBaseData, forDestroy = false) {
    const notificationsTableName = this.createSqlIdentifier(
      baseData,
      'notifications_table'
    );

    const perPage = this.consumptionBatchCount;

    const countResult = await baseData
      .knex(notificationsTableName)
      .count({ count: '*' });
    const numOfRows = +countResult[0]?.count || 0;

    if (numOfRows <= perPage) {
      baseData.throttleTaskId = null;
    }

    const notifications: {
      id: string;
      createdAt: string;
      nocodbModelId: string;
      operation: string;
      oldData?: Record<string, any> | null;
      newData?: Record<string, any> | null;
      numOfRows: number;
    }[] = await baseData
      .knex(notificationsTableName)
      .whereIn(
        'id',
        baseData.knex(notificationsTableName).select('id').limit(perPage)
      )
      .returning('*')
      .delete();

    if (notifications.length) {
      // this.log(
      //   'consuming notifications : ',
      //   notifications.map((notification) =>
      //     pick(notification, ['nocodbModelId'])
      //   )
      // );
    }

    if (numOfRows > perPage) {
      const consumeNotificationsPromise = this.consumeNotifications(baseData);
      if (forDestroy) await consumeNotificationsPromise;
    }

    await Promise.all(
      notifications.map(
        async ({
          nocodbModelId,
          operation,
          oldData: oldDBData,
          newData: newDBData,
        }) => {
          const model = baseData.models.find(
            (model) => model.id === nocodbModelId
          );
          if (!model) {
            // TODO: Log this error
            return;
          }

          const oldData = oldDBData
            ? await this.convertDBDataToModelData(baseData, model, oldDBData)
            : oldDBData;
          const newData = newDBData
            ? await this.convertDBDataToModelData(baseData, model, newDBData)
            : newDBData;

          const eventData: PSQLRecordOperationEvent = {
            base: baseData.base,
            oldData,
            newData,
            operation: operation as PSQLRecordOperationEvent['operation'],
            model,
          };
          this.emit(this.recordOperationEventType, eventData);
        }
      )
    );
  }

  private async registerListeners(
    baseDataForRef: IBaseData,
    connection: Connection
  ) {
    let rewatchHandled = false;

    const notificationChannel = this.getSqlNotificationChannel(baseDataForRef);

    const listeningQuery = `LISTEN ${notificationChannel}`;
    await connection.query(listeningQuery);

    connection.on('notification', (data: ISQLNotificationData) => {
      const notificationChannel =
        this.getSqlNotificationChannel(baseDataForRef);

      const { channel } = data;

      if (channel !== notificationChannel) return;

      // get the current baseData, it might be different from what was used in last notification because it was updated in the bases map
      const baseData = this.allBaseData.get(baseDataForRef.base.id);

      if (!baseData) return;

      // if not equal by reference, then do nothing. the baseData object that registered this listener has been replaced. Maybe the connection notification
      // event still fired because the connection object is just starting to be destroyed
      if (baseData !== baseDataForRef) return;

      this.throttleAndConsumeNotifications(baseData);
    });

    const endListener = () => {
      if (rewatchHandled) return;
      rewatchHandled = true;
      const rewatch = () => {
        const baseData = this.allBaseData.get(baseDataForRef.base.id);

        // if not equal by reference, then do nothing. the baseData object that registered this listener has been replaced.
        if (baseData !== baseDataForRef) return;

        this._watchBaseInternal(baseData.base, true).catch(() => {
          // TODO: Log this sensitive error and report as incident, this could cause events to be missed

          // retry after a delay.
          setTimeout(rewatch, this.rewatchErrorRetryDelayMillis);
        });
      };

      rewatch();
    };

    connection.on('end', endListener);
    connection.on('error', endListener);
  }

  private getSqlNotificationChannel(baseData: IBaseData) {
    return this.createSqlIdentifier(baseData, 'notification_channel');
  }

  private createSqlIdentifierPrefix(baseData: IBaseData) {
    return `esa_nocodb__${baseData.connectionOptions.database}`
      .toLowerCase()
      .replace(regexForCharactersToReplace, '_');
  }

  private createSqlIdentifier(baseData: IBaseData, suffix: string) {
    return `${this.createSqlIdentifierPrefix(baseData)}__${suffix}`
      .toLowerCase()
      .replace(regexForCharactersToReplace, '_');
  }

  private async setupSQLResources(baseData: IBaseData, models: Model[]) {
    const notificationChannel = this.getSqlNotificationChannel(baseData);

    // esa_nocodb__bmh__notifcations_channel

    const notificationsTableName = this.createSqlIdentifier(
      baseData,
      'notifications_table'
    );
    // esa_nocodb_bmh_notifcations_table

    const notificationsTableCreateQuery = `
    CREATE TABLE IF NOT EXISTS "${notificationsTableName}" ( "id" SERIAL PRIMARY KEY, "operation" VARCHAR(20) NOT NULL, "nocodbModelId" VARCHAR(30) NOT NULL, "oldData" JSONB, "newData" JSONB, "createdAt" TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP );
    `;

    this.log('about to run notificationsTableCreateQuery ');
    await baseData.knex.raw(notificationsTableCreateQuery);
    this.log('finished running notificationsTableCreateQuery ');

    const procedureName = this.createSqlIdentifier(baseData, 'function');
    // esa_nocodb_bmh_function
    const procedureQuery = `
    CREATE OR REPLACE FUNCTION ${procedureName}() RETURNS TRIGGER AS $trigger$
    DECLARE
      model_id TEXT;
    BEGIN
      model_id := TG_ARGV[0];

      RAISE LOG '${PSQLRecordOperationWatcher.name} : inserting notification event for model : %', model_id;

      INSERT INTO "${notificationsTableName}"( "operation", "nocodbModelId", "oldData", "newData" ) VALUES ( LOWER(TG_OP)::VARCHAR, model_id::VARCHAR,row_to_json(OLD)::JSONB, row_to_json(NEW)::JSONB );

      NOTIFY ${notificationChannel};

      IF (TG_OP = 'DELETE') THEN
        RETURN OLD;
      ELSIF (TG_OP = 'UPDATE' OR TG_OP = 'INSERT') THEN
        RETURN NEW;
      END IF;

      RETURN NULL;
    END;
    $trigger$ LANGUAGE plpgsql;
    `;
    this.log('about to run procedureQuery ');
    await baseData.knex.raw(procedureQuery);
    this.log('finnished running procedureQuery ');

    for (const { id: modelId, table_name: tableName } of models) {
      // Audit trail tables already skipped

      const triggerName = this.createSqlIdentifier(
        baseData,
        `${tableName}__trigger`
      );
      // esa_nocodb_bmh_{tableName}__trigger

      // postgressql does not have "create or replace" statement for function, hence that can be suffixed by first dropping it
      const dropTriggerQuery = `DROP TRIGGER IF EXISTS "${triggerName}" on "${tableName}"`;

      // use a constraint trigger so that if a transaction is active, the events are fired only after the transaction is successful
      const createTriggerQuery = `
      CREATE CONSTRAINT TRIGGER "${triggerName}"
      AFTER INSERT OR UPDATE OR DELETE ON "${tableName}"
      DEFERRABLE
      INITIALLY DEFERRED
      FOR EACH ROW EXECUTE PROCEDURE ${procedureName}('${modelId}');
      `;

      // any trigger that exist is always dropped, if it is to be recreated
      this.log(
        `about to run dropTriggerQuery for ${triggerName} on  ${tableName}`
      );
      await baseData.knex.raw(dropTriggerQuery);
      this.log(
        `finished running dropTriggerQuery for ${triggerName} on  ${tableName}`
      );

      this.log(
        `about to run createTriggerQuery for ${triggerName} on  ${tableName}`
      );
      await baseData.knex.raw(createTriggerQuery).catch((error: any) => {
        this.log(
          `Warning - Trigger not created on "${tableName}" probably because it does not exist. Analysis the stacktrace: ${
            error?.message || error
          }`,
          error
        );
      });
      this.log(
        `finished running createTriggerQuery for ${triggerName} on  ${tableName}`
      );
    }
  }

  private async disposeSQLResourcesForModel(
    baseData: IBaseData,
    { table_name: tableName }: Model
  ) {
    const oldTriggerName = this.createSqlIdentifier(
      baseData,
      `${tableName}__trigger`
    );
    const dropOldTriggerQuery = `DROP TRIGGER IF EXISTS ${oldTriggerName} on ${tableName}`;
    await baseData.knex.raw(dropOldTriggerQuery);
  }

  private async disposeSQLResources(baseData: IBaseData) {
    const notificationsTableName = this.createSqlIdentifier(
      baseData,
      'notifications_table'
    );
    const notificationsTableCreateQuery = `
    DROP TABLE IF EXISTS "${notificationsTableName}";
    `;
    await baseData.knex.raw(notificationsTableCreateQuery);

    const oldProcedureName = this.createSqlIdentifier(baseData, 'function');
    const oldProcedureQuery = `DROP FUNCTION IF EXISTS ${oldProcedureName}`;
    await baseData.knex.raw(oldProcedureQuery);

    for (const model of baseData.models) {
      await this.disposeSQLResourcesForModel(baseData, model);
    }
  }

  /**
   * should be called when a base is created OR when tables are created, updated or delete in a base.
   * @param base
   */
  async watchBase(base: Base) {
    return this._watchBaseInternal(base, false);
  }

  private async _watchBaseInternal(base: Base, rewatch: boolean) {
    if (!base.id) {
      // TODO: Log this error and report as incident
      return;
    }

    if (base.is_meta) return;

    const foundModelData: Record<string, any>[] = await this.ncMeta.metaList2(
      base.project_id,
      base.id,
      MetaTable.MODELS,
      {
        condition: {
          type: 'table',
        },
      }
    );

    const models = foundModelData.map(
      (foundModelDatum) => new Model(foundModelDatum)
    );

    const obsoleteModels: Model[] = [];

    let skippedModels: Model[] = [];
    let newModels: Model[] = [];

    let baseData: IBaseData = this.allBaseData.get(base.id);

    this.log(`watching base ${base.alias}`);
    this.log(`watching base ${base.id}`);

    const connectionOptions = (await base.getConnectionConfig()).connection;

    const createNewBaseData =
      !baseData ||
      // if connection options have changed which includes database name, port, host etc.
      !isEqual(connectionOptions, baseData.connectionOptions);

    if (baseData && createNewBaseData) {
      // //////// will never get called as basedata will always be empty at this point
      ///// and will never dispose all resources
      // ////// Needs to be fixed in case connection options change
      await this.unwatchBase(baseData.base);
    }

    if (createNewBaseData) {
      const knex = await this.createKnex(base);
      baseData = {
        base,
        models,
        knex,
        connectionOptions,
      };

      newModels.push(...models);
    } else {
      //////// this never even gets used as baseData will be empty
      const modelIds = models.map((model) => model.id); /////// //////// //  why is tablename being mapped to modelIDs
      obsoleteModels.push(
        ...baseData.models.filter((model) => !modelIds.includes(model.id))
      );
      const prevModelIds = baseData.models.map((model) => model.id); // this will always be empty, add logs to see intdev tests
      newModels.push(
        ...models.filter((model) => !prevModelIds.includes(model.id))
      );

      baseData.base = base;
      baseData.models = models;
    }

    /**
     * WARNING: do not watch on table ( especially notification table ) created by this class to avoid exaustive loop of death because nocodb will also have a model for the table. If the model is
     * watched( an sql trigger registered for it per se ), then a direct insert, update, delete action OR an insertion of notification event from trigger of other tables will cause a
     * notification event to be inserted again, which causes another insertion, hence an unending loop.
     * Also do not watch audit trail tables except explicitely setup to watch them.
     */
    let shouldWatchAuditTables: boolean = false;
    if (process.env.SHOULD_WATCH_AUDIT_TABLES === 'true') {
      shouldWatchAuditTables = true;
    }

    [newModels, skippedModels] = newModels.reduce(
      (results, newModel) => {
        results[
          newModel.table_name.startsWith(
            this.createSqlIdentifierPrefix(baseData)
          ) ||
          (!shouldWatchAuditTables && newModel.table_name.endsWith('_audit'))
            ? 1
            : 0
        ].push(newModel);
        return results;
      },
      [[], []]
    );

    const pickedFields = ['id', 'table_name', 'title'];
    this.log(
      `watching base : ${base.id} , ${
        (await base.getConnectionConfig()).database
      }`
    );
    this.log(
      `watched models`,
      newModels.map((model) => pick(model, pickedFields))
    );
    this.log(
      'skipped models',
      skippedModels.map((model) => pick(model, pickedFields))
    );
    this.log(
      'obsolete models',
      obsoleteModels.map((model) => pick(model, pickedFields))
    );

    this.log(JSON.stringify({ base }));

    await this.setupSQLResources(baseData, newModels);
    // this.log('finished seting up sql resources ...');

    // this.log('about to consume notifications');
    void this.consumeNotifications(baseData);
    // this.log('finished consuming notifications ..... ');

    if (createNewBaseData || rewatch) {
      const connection = await baseData.knex.client.acquireConnection();

      // this.log('about to register listeners');
      // start watching
      // ///////////
      await this.registerListeners(baseData, connection);
      // this.log('finished registering listeners ...');
    }

    // this.log('about to  dispose sql resources for obsolete models');
    await Promise.all(
      obsoleteModels.map((obsoleteModel) =>
        this.disposeSQLResourcesForModel(baseData, obsoleteModel)
      )
    );
    // this.log('done  disposing sql resources for obsolete models ....');

    this.allBaseData.set(base.id, baseData);
  }

  async unwatchBase(base: Base) {
    const baseData = this.allBaseData.get(base.id);
    if (baseData) {
      try {
        if (baseData.throttleTaskId != undefined) {
          clearTimeout(baseData.throttleTaskId);
          baseData.throttleTaskId = null;
        }

        try {
          await this.consumeNotifications(baseData, true);
        } catch {}

        // delete first before destroying all connections, so that a rewatch wont be attempted if connection.end event is fired
        this.allBaseData.delete(base.id);
        await this.disposeSQLResources(baseData);
      } finally {
        await baseData.knex.destroy();
      }
    }
  }

  async watchAllBases() {
    const projects = await Project.list({});
    const bases = (
      await Promise.all(projects.map((project) => project.getBases()))
    ).flat();
    const baseIds = bases.map((base) => base.id);
    //////// Retreive watched base data from DB and set it in this.allBaseData.

    const allObsoleteBaseData = Array.from(this.allBaseData.values()).filter(
      (baseData) => !baseIds.includes(baseData.base.id)
    ); // this will always be null as this.allBaseData should be empty at this point as no baseData
    // exists in allBaseData confirm with logs

    this.log(JSON.stringify({ allBaseData: this.allBaseData }));
    this.log(JSON.stringify({ allObsoleteBaseData }));
    for (const base of bases) {
      await this.watchBase(base);
    }

    for (const obsoleteBaseData of allObsoleteBaseData) {
      // no base will ever be unwatched as allObsoleteBaseData is empty
      await this.unwatchBase(obsoleteBaseData.base);
    }
  }

  private async createKnex(base: Base): Promise<XKnex> {
    const connectionConfig = await base.getConnectionConfig();
    const options = merge(connectionConfig, {
      pool: {
        min: 0,
        max: 3,
      },
    });
    return XKnex(options);
  }

  static defaultInstance: PSQLRecordOperationWatcher;
  static async watchForWebhook(ncMeta: NcMetaIO) {
    process.stderr.write('PSQLRecordOperationWatcher : watchForWebhook');
    const recordOperationWatcher = new PSQLRecordOperationWatcher(ncMeta);
    process.stderr.write('PSQLRecordOperationWatcher : watchForWebhook : instance created');
    PSQLRecordOperationWatcher.defaultInstance = recordOperationWatcher;
    process.stderr.write('PSQLRecordOperationWatcher : watchForWebhook : defaultInstance set');

    recordOperationWatcher.on(
      recordOperationWatcher.recordOperationEventType,
      async ({
        model,
        operation,
        oldData,
        newData,
      }: PSQLRecordOperationEvent) => {
        process.stderr.write('PSQLRecordOperationWatcher: hook invoked');
        const theOperation = operation as HookType['operation'];
        const event = 'after';
        process.stderr.write(JSON.stringify({ model, operation, oldData, newData }));

        if (theOperation === 'delete') {
          newData = oldData;
          oldData = null;
        }
        process.stderr.write('getting bases');
        const project = await Project.get(model.project_id);
        process.stderr.write('got project');
        process.stderr.write(JSON.stringify({ project }));
        const bases = await project.getBases();
        process.stderr.write('got bases');
        process.stderr.write(JSON.stringify({ bases }));
        const currentBase = bases.find((base) => base.id === model.base_id);
        process.stderr.write('got currentBase');
        process.stderr.write(JSON.stringify({ currentBase }));
        const shouldNotProceed =
          currentBase.is_meta ||
          process.env.ESA_SKIP_DB_RECORD_ACTION_EVENT_WATCHER_FOR_WEBHOOK ===
            'true';
        if (shouldNotProceed) return;
        try {
          const hooks = await Hook.list({
            fk_model_id: model.id,
            event,
            operation: theOperation,
          });
          for (const hook of hooks) {
            if (hook.active) {
              invokeWebhook(
                hook,
                model,
                undefined,
                oldData,
                newData,
                undefined
              );
            }
          }
        } catch (e) {
          const hookName = `${event}.${operation}`;
          console.log('PSQLRecordEvent : hooks :: error', hookName, e);
          // add incident reporting here if clling a hook fails
        }
      }
    );

    await recordOperationWatcher.watchAllBases();
  }
}
