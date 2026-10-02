import { Monitor, Moon, Sun } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { Menu, MenuContent, MenuRadioGroup, MenuRadioItem, MenuTrigger } from '../ui/Menu';
import { IconButton } from '../ui/IconButton';
import { themeModeLabels, themeModes, useTheme } from '../theme/ThemeProvider';
import type { ThemeMode } from '../theme/ThemeProvider';

const modeIcons: Record<ThemeMode, LucideIcon> = { system: Monitor, light: Sun, dark: Moon };

/** Theme control (mobile: system / light / dark; labels are the mobile strings). */
export function ThemeToggle() {
  const { mode, setMode } = useTheme();
  return (
    <Menu>
      <MenuTrigger asChild>
        <IconButton icon={modeIcons[mode]} label={`Tema: ${themeModeLabels[mode]}`} tone="onAppBar" />
      </MenuTrigger>
      <MenuContent align="end">
        <MenuRadioGroup value={mode} onValueChange={(value) => setMode(value as ThemeMode)}>
          {themeModes.map((m) => (
            <MenuRadioItem key={m} value={m} icon={modeIcons[m]}>
              {themeModeLabels[m]}
            </MenuRadioItem>
          ))}
        </MenuRadioGroup>
      </MenuContent>
    </Menu>
  );
}
