import { useTheme } from 'expo-router';
import type { PropsWithChildren } from 'react';
import { Platform, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

type TitledContent = PropsWithChildren<{ title: string }>;

export const Screen = ({ title, children }: TitledContent) => {
  const { colors } = useTheme();

  return (
    <SafeAreaView
      edges={Platform.OS === 'android' ? ['top', 'left', 'right'] : ['left', 'right']}
      style={[styles.screen, { backgroundColor: colors.background }]}
    >
      <ScrollView contentContainerStyle={styles.content}>
        <Text accessibilityRole="header" style={[styles.title, { color: colors.text }]}>
          {title}
        </Text>
        {children}
      </ScrollView>
    </SafeAreaView>
  );
};

export const Section = ({ title, children }: TitledContent) => {
  const { colors } = useTheme();

  return (
    <View style={[styles.section, { borderTopColor: colors.border }]}>
      <Text accessibilityRole="header" style={[styles.heading, { color: colors.text }]}>
        {title}
      </Text>
      {children}
    </View>
  );
};

export const EmptyState = ({ children }: { children: string }) => {
  const { dark } = useTheme();

  return <Text style={{ color: dark ? '#b1b1b6' : '#595960' }}>{children}</Text>;
};

const styles = StyleSheet.create({
  screen: { flex: 1 },
  content: { padding: 20, gap: 20 },
  title: { fontSize: 28, fontWeight: '700' },
  section: { borderTopWidth: StyleSheet.hairlineWidth, paddingTop: 16, gap: 6 },
  heading: { fontSize: 17, fontWeight: '600' },
});
