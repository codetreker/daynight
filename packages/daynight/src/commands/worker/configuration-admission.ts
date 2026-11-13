export class ConfigurationAdmissionWaiting extends Error {
  constructor() { super("Worker configuration is not ready to admit a new execution."); }
}

export const assertConfigurationAdmission = (canAdmitNewExecution?: () => boolean): void => {
  if (canAdmitNewExecution !== undefined && !canAdmitNewExecution()) throw new ConfigurationAdmissionWaiting();
};
