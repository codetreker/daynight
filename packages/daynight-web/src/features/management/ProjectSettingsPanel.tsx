import type { ComponentProps } from 'react';
import { ProjectSettingsWorkspace } from './project-settings/ProjectSettingsWorkspace';

export const ProjectSettingsPanel = (props: ComponentProps<typeof ProjectSettingsWorkspace>) => <ProjectSettingsWorkspace {...props} />;
