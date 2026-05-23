import { type JSX, useEffect, useState } from "react";
import { match } from "ts-pattern";
import { browser } from "wxt/browser";
import {
  enabledItem,
  rateWidgetDismissedItem,
  useSystemPrefItem,
  readEnabled,
  readRateWidgetDismissed,
  readUseSystemPref,
} from "../../lib/storage";

const CHROME_REVIEW_URL =
  "https://chromewebstore.google.com/detail/spotify-light-mode/lengbgflhbbajjfklllkaiookcpkkdbl/reviews";
const FIREFOX_REVIEW_URL =
  "https://addons.mozilla.org/en-US/firefox/addon/spotify-light-mode/reviews/";

const REVIEW_URL = match(import.meta.env.FIREFOX)
  .with(true, () => FIREFOX_REVIEW_URL)
  .with(false, () => CHROME_REVIEW_URL)
  .exhaustive();
const STAR_RATINGS = [1, 2, 3, 4, 5] as const;

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
  const [rateWidgetDismissed, setRateWidgetDismissed] = useState<boolean>(
    rateWidgetDismissedItem.fallback,
  );
  const [loading, setLoading] = useState<boolean>(true);

  useEffect(() => {
    void Promise.all([
      readEnabled(),
      readUseSystemPref(),
      readRateWidgetDismissed(),
    ]).then(([en, sys, rateDismissed]) => {
      setEnabled(en);
      setUseSystemPref(sys);
      setRateWidgetDismissed(rateDismissed);
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

  async function openReviewPage(): Promise<void> {
    await browser.tabs.create({ url: REVIEW_URL });
  }

  async function handleRateClick(): Promise<void> {
    setRateWidgetDismissed(true);
    await rateWidgetDismissedItem.setValue(true);
    await openReviewPage();
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

      <footer className="rate">
        {match(rateWidgetDismissed)
          .with(false, () => (
            <div className="rate__prompt" aria-label="Rate Spotify Light Mode">
              <span className="rate__copy">
                Enjoying it?
                <br />
                Leave a review ❤️
              </span>
              <div
                className="rate__stars"
                role="group"
                aria-label="Rate 5 stars"
              >
                {STAR_RATINGS.map((rating) => (
                  <button
                    key={rating}
                    type="button"
                    className="rate__star"
                    aria-label={`${rating} star${rating === 1 ? "" : "s"}`}
                    onClick={() => void handleRateClick()}
                  >
                    ★
                  </button>
                ))}
              </div>
            </div>
          ))
          .with(true, () => (
            <button
              type="button"
              className="rate__link"
              onClick={() => void openReviewPage()}
            >
              Enjoying it? Leave a review ❤️
            </button>
          ))
          .exhaustive()}
      </footer>
    </main>
  );
}
