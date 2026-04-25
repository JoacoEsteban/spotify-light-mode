import { useEffect, useState } from 'react';
import {
  enabledItem,
  useSystemPrefItem,
  readEnabled,
  readUseSystemPref,
} from '../../lib/storage';

export default function App(): JSX.Element | null {
  const [enabled, setEnabled] = useState<boolean>(enabledItem.fallback);
  const [useSystemPref, setUseSystemPref] = useState<boolean>(useSystemPrefItem.fallback);
  const [loading, setLoading] = useState<boolean>(true);

  useEffect(() => {
    void Promise.all([readEnabled(), readUseSystemPref()]).then(([en, sys]) => {
      setEnabled(en);
      setUseSystemPref(sys);
      setLoading(false);
    });
  }, []);

  async function handleEnabledChange(value: boolean): Promise<void> {
    setEnabled(value);
    await enabledItem.setValue(value);
  }

  async function handleSysPrefChange(value: boolean): Promise<void> {
    setUseSystemPref(value);
    await useSystemPrefItem.setValue(value);
  }

  if (loading) return null;

  return (
    <main className="popup">
      <h1 className="popup__title">Spotify Light Mode</h1>

      <label className="toggle-row">
        <span className="toggle-row__label">Enable extension</span>
        <input
          type="checkbox"
          className="toggle"
          role="switch"
          checked={enabled}
          onChange={(e) => void handleEnabledChange(e.target.checked)}
        />
      </label>

      <label className={`toggle-row${!enabled ? ' toggle-row--disabled' : ''}`}>
        <span className="toggle-row__label">
          Use system preference
          <small>Only apply in light OS mode</small>
        </span>
        <input
          type="checkbox"
          className="toggle"
          role="switch"
          checked={useSystemPref}
          disabled={!enabled}
          onChange={(e) => void handleSysPrefChange(e.target.checked)}
        />
      </label>
    </main>
  );
}
