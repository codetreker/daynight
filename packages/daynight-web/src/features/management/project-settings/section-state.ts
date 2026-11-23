export type ProjectSettingsSectionState = {
  readonly dirty: boolean;
  readonly pending: boolean;
  readonly needsAttention: boolean;
};
export type ProjectSettingsStateObserver = (state: ProjectSettingsSectionState) => void;
