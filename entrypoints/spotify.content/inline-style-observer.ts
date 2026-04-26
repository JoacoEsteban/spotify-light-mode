import { hasColorToken, mapColorsInValue } from "../../lib/style-color-mapping";

type TrackedInlineStyle = {
  value: string;
  priority: string;
};

type TrackedElementStyles = {
  backgroundImage?: TrackedInlineStyle;
  backgroundColor?: TrackedInlineStyle;
};

export type InlineStyleObserver = {
  start: () => void;
  stop: () => void;
};

export function createInlineStyleObserver(): InlineStyleObserver {
  const selfMutatingElements = new WeakSet<HTMLElement>();
  let trackedInlineStyles = new WeakMap<HTMLElement, TrackedElementStyles>();
  const touchedElements = new Set<HTMLElement>();
  let observer: MutationObserver | null = null;

  function trackOriginalInlineStyle(
    element: HTMLElement,
    property: "background-image" | "background-color",
  ): void {
    const tracked = trackedInlineStyles.get(element) ?? {};

    if (property === "background-image" && tracked.backgroundImage == null) {
      tracked.backgroundImage = {
        value: element.style.getPropertyValue(property),
        priority: element.style.getPropertyPriority(property),
      };
    }

    if (property === "background-color" && tracked.backgroundColor == null) {
      tracked.backgroundColor = {
        value: element.style.getPropertyValue(property),
        priority: element.style.getPropertyPriority(property),
      };
    }

    trackedInlineStyles.set(element, tracked);
    touchedElements.add(element);
  }

  function maybeOverrideInlineStyle(
    element: HTMLElement,
    property: "background-image" | "background-color",
  ): void {
    const originalValue = element.style.getPropertyValue(property).trim();
    if (originalValue.length === 0 || !hasColorToken(originalValue)) {
      return;
    }

    const mappedValue = mapColorsInValue(originalValue);
    if (mappedValue === originalValue) {
      return;
    }

    trackOriginalInlineStyle(element, property);
    selfMutatingElements.add(element);
    element.style.setProperty(property, mappedValue, "important");
    queueMicrotask(() => {
      selfMutatingElements.delete(element);
    });
  }

  function processElement(element: HTMLElement): void {
    maybeOverrideInlineStyle(element, "background-image");
    maybeOverrideInlineStyle(element, "background-color");
  }

  function processTree(root: ParentNode): void {
    if (root instanceof HTMLElement) {
      processElement(root);
    }

    for (const element of root.querySelectorAll<HTMLElement>("[style]")) {
      processElement(element);
    }
  }

  function restoreProperty(
    element: HTMLElement,
    property: "background-image" | "background-color",
    tracked: TrackedInlineStyle,
  ): void {
    if (tracked.value.length === 0) {
      element.style.removeProperty(property);
      return;
    }

    element.style.setProperty(property, tracked.value, tracked.priority);
  }

  function restoreInlineOverrides(): void {
    for (const element of touchedElements) {
      const tracked = trackedInlineStyles.get(element);
      if (tracked?.backgroundImage != null) {
        restoreProperty(element, "background-image", tracked.backgroundImage);
      }

      if (tracked?.backgroundColor != null) {
        restoreProperty(element, "background-color", tracked.backgroundColor);
      }
    }

    touchedElements.clear();
    trackedInlineStyles = new WeakMap<HTMLElement, TrackedElementStyles>();
  }

  function start(): void {
    if (observer != null) {
      return;
    }

    processTree(document.documentElement);

    observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        if (mutation.type === "attributes") {
          const target = mutation.target;
          if (target instanceof HTMLElement && !selfMutatingElements.has(target)) {
            processElement(target);
          }
          continue;
        }

        for (const node of mutation.addedNodes) {
          if (node instanceof HTMLElement) {
            processTree(node);
          }
        }
      }
    });

    observer.observe(document.documentElement, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["style"],
    });
  }

  function stop(): void {
    observer?.disconnect();
    observer = null;
    restoreInlineOverrides();
  }

  return {
    start,
    stop,
  };
}
