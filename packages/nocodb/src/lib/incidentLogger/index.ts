import incidentHandler from '@balance-my-hormones/incident-handling';
import type { Incident } from '@balance-my-hormones/incident-handling';

export const createIncidentLog = async (
  data: Incident,
  extras?: Record<string, any>,
  createCustomTicketSubject?: (defaultTitle: string) => string
) => {
  console.log('Creating incident logging....');
  try {
    await incidentHandler.logIncident(data, extras, {
      createCustomTicketSubject,
    });
  } catch (error) {
    console.log('Error when creating incident log:', error);
  }
};
