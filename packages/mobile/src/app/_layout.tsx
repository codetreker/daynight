import { DarkTheme, DefaultTheme, ThemeProvider } from 'expo-router';
import { NativeTabs } from 'expo-router/native-tabs';
import { StatusBar, useColorScheme } from 'react-native';

const RootLayout = () => {
  const isDark = useColorScheme() === 'dark';

  return (
    <ThemeProvider value={isDark ? DarkTheme : DefaultTheme}>
      <StatusBar barStyle={isDark ? 'light-content' : 'dark-content'} />
      <NativeTabs>
        <NativeTabs.Trigger name="index">
          <NativeTabs.Trigger.Icon sf="tray" md="inbox" />
          <NativeTabs.Trigger.Label>My Work</NativeTabs.Trigger.Label>
        </NativeTabs.Trigger>
        <NativeTabs.Trigger name="projects">
          <NativeTabs.Trigger.Icon sf="folder" md="folder" />
          <NativeTabs.Trigger.Label>Projects</NativeTabs.Trigger.Label>
        </NativeTabs.Trigger>
        <NativeTabs.Trigger name="assistants">
          <NativeTabs.Trigger.Icon sf="bubble.left" md="chat_bubble" />
          <NativeTabs.Trigger.Label>Assistants</NativeTabs.Trigger.Label>
        </NativeTabs.Trigger>
      </NativeTabs>
    </ThemeProvider>
  );
};

export default RootLayout;
