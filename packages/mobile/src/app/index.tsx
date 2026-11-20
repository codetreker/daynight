import { EmptyState, Screen, Section } from '../components/screen';

const MyWorkScreen = () => (
  <Screen title="My Work">
    <Section title="Needs Attention">
      <EmptyState>No items to review.</EmptyState>
    </Section>
    <Section title="In Progress">
      <EmptyState>No work in progress.</EmptyState>
    </Section>
  </Screen>
);

export default MyWorkScreen;
