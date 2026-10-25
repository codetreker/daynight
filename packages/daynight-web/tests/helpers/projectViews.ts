import { fireEvent, screen } from '@testing-library/react';

export const selectTaskList = async (): Promise<void> => {
  fireEvent.click(await screen.findByRole('tab', { name: /^(任务列表|Task list)$/ }));
};
