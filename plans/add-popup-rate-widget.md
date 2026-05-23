  # Add Popup Rate Widget

  ## Summary

  Add a compact review area beneath the existing popup toggles: a 5-star clickable widget that opens the correct store review page and then hides itself locally, plus a persistent subtle store link that remains visible afterward.

  ## Key Changes

  - Add browser-specific store URL constants in the popup:
      - Chrome/Chromium: https://chromewebstore.google.com/detail/spotify-light-mode/lengbgflhbbajjfklllkaiookcpkkdbl/reviews
      - Firefox: https://addons.mozilla.org/en-US/firefox/addon/spotify-light-mode/reviews/
      - Use import.meta.env.FIREFOX to choose AMO; otherwise use Chrome Web Store.
  - Add a new storage item, likely local:rateWidgetDismissed, validated with Zod like the existing booleans.
  - In entrypoints/popup/App.tsx:
      - Load rateWidgetDismissed alongside existing settings.
      - Render five accessible star buttons only when not dismissed.
      - On any star click, open the selected review URL in a new tab via browser.tabs.create({ url }), then persist dismissal.
      - Always render a small persistent text/link control such as Rate on store, using the same browser-specific URL.
  - In entrypoints/popup/App.css:
      - Keep the popup compact, matching the current refined light/dark styling.
      - Style stars as stable-size icon-like buttons with hover/focus states and no layout shift.
      - Keep the persistent link visually quieter than the toggles and star widget.

  ## Test Plan

  - Run bun run build.
  - Run bun run build:firefox.
  - Verify TypeScript catches the new storage item and browser API usage.
  - Manual popup checks:
      - First open shows the star widget and persistent store link.
      - Clicking any star opens the browser-specific reviews URL and hides only the star widget.
      - Reopening the popup keeps the star widget hidden.
      - Persistent store link still appears after dismissal.
      - Light/dark popup theme behavior remains unchanged.

  ## Assumptions

  - Clicking any of the 5 stars means “go rate this extension,” not collecting an in-popup score.
  - Dismissal is local-only and stored in extension storage; no analytics or external request is added.
  - The Firefox listing is https://addons.mozilla.org/en-US/firefox/addon/spotify-light-mode/; the reviews route is used for the widget.
  - Sources checked: README Chrome listing in repo, and Mozilla listing found at https://addons.mozilla.org/en-US/firefox/addon/spotify-light-mode/.
