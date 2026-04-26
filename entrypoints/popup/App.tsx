import { type JSX, useEffect, useState } from "react";
import {
  enabledItem,
  useSystemPrefItem,
  readEnabled,
  readUseSystemPref,
} from "../../lib/storage";

function syncTheme(enabled: boolean, useSystemPref: boolean): void {
  const { classList } = document.documentElement;
  if (!enabled) {
    classList.add("dark");
    classList.remove("use-system-pref");
  } else if (useSystemPref) {
    classList.remove("dark");
    classList.add("use-system-pref");
  } else {
    classList.remove("dark", "use-system-pref");
  }
}

export default function App(): JSX.Element | null {
  const [enabled, setEnabled] = useState<boolean>(enabledItem.fallback);
  const [useSystemPref, setUseSystemPref] = useState<boolean>(
    useSystemPrefItem.fallback,
  );
  const [loading, setLoading] = useState<boolean>(true);

  useEffect(() => {
    void Promise.all([readEnabled(), readUseSystemPref()]).then(([en, sys]) => {
      setEnabled(en);
      setUseSystemPref(sys);
      syncTheme(en, sys);
      setLoading(false);
    });
  }, []);

  useEffect(() => {
    if (!loading) syncTheme(enabled, useSystemPref);
  }, [enabled, useSystemPref, loading]);

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
      <header className="popup__header">
        <div className="popup__top-row">
          <div className="popup__brand">
            <img src="/icon-32.png" className="popup__icon" alt="" />
            <span className="popup__eyebrow">Spotify</span>
          </div>
          <div className="popup__status">
            <div
              className={`popup__status-dot${enabled ? " popup__status-dot--on" : ""}`}
            />
            <span>{enabled ? "Active" : "Off"}</span>
          </div>
        </div>
        <h1 className="popup__title">
          <span className="popup__title-accent">Light</span> Mode
        </h1>
      </header>

      <div className="controls">
        <label className="toggle-row">
          <span className="toggle-row__label">
            <span className="toggle-row__label-text">Enable extension</span>
          </span>
          <input
            type="checkbox"
            className="toggle"
            role="switch"
            checked={enabled}
            onChange={(e) => void handleEnabledChange(e.target.checked)}
          />
        </label>

        <label
          className={`toggle-row${!enabled ? " toggle-row--disabled" : ""}`}
        >
          <span className="toggle-row__label">
            <span className="toggle-row__label-text">
              Use system preference
            </span>
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
      </div>
    </main>
  );
}
