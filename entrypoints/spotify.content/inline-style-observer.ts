import chroma from "chroma-js";

import {
  formatMappedColor,
  hasColorToken,
  mapColorsInValue,
} from "../../lib/style-color-mapping";

type TrackedInlineStyle = {
  value: string;
  priority: string;
};

type TrackedElementStyles = {
  backgroundImage?: TrackedInlineStyle;
  backgroundColor?: TrackedInlineStyle;
  customProperties?: Map<string, TrackedInlineStyle>;
};

type InlineStyleProperty = "background-image" | "background-color";

export type InlineStyleObserver = {
  start: () => void;
  stop: () => void;
};

export function createInlineStyleObserver(): InlineStyleObserver {
  const selfMutatingElements = new WeakSet<HTMLElement>();
  let trackedInlineStyles = new WeakMap<HTMLElement, TrackedElementStyles>();
  const touchedElements = new Set<HTMLElement>();
  let observer: MutationObserver | null = null;

  let trackedSheetStyles = new WeakMap<
    CSSStyleDeclaration,
    Map<string, TrackedInlineStyle>
  >();
  const touchedDeclarations = new Set<CSSStyleDeclaration>();
  let originalInsertRule: typeof CSSStyleSheet.prototype.insertRule | null =
    null;

  function trackOriginalInlineStyle(
    element: HTMLElement,
    property: InlineStyleProperty,
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

  function trackOriginalCustomProperty(
    element: HTMLElement,
    property: string,
  ): void {
    const tracked = trackedInlineStyles.get(element) ?? {};
    const customProperties = tracked.customProperties ?? new Map();

    if (!customProperties.has(property)) {
      customProperties.set(property, {
        value: element.style.getPropertyValue(property),
        priority: element.style.getPropertyPriority(property),
      });
    }

    tracked.customProperties = customProperties;
    trackedInlineStyles.set(element, tracked);
    touchedElements.add(element);
  }

  function maybeOverrideInlineStyle(
    element: HTMLElement,
    property: InlineStyleProperty,
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

  function maybeOverrideInlineCustomProperties(element: HTMLElement): void {
    for (const property of Array.from(element.style)) {
      if (!property.startsWith("--")) {
        continue;
      }

      const originalValue = element.style.getPropertyValue(property).trim();
      if (
        originalValue.length === 0 ||
        !hasColorToken(originalValue) ||
        !chroma.valid(originalValue)
      ) {
        continue;
      }

      const mappedValue = formatMappedColor(originalValue);
      if (mappedValue === originalValue) {
        continue;
      }

      trackOriginalCustomProperty(element, property);
      selfMutatingElements.add(element);
      element.style.setProperty(property, mappedValue, "important");
      queueMicrotask(() => {
        selfMutatingElements.delete(element);
      });
    }
  }

  function processElement(element: HTMLElement): void {
    maybeOverrideInlineStyle(element, "background-image");
    maybeOverrideInlineStyle(element, "background-color");
    maybeOverrideInlineCustomProperties(element);
  }

  function processTree(root: ParentNode): void {
    if (root instanceof HTMLElement) {
      processElement(root);
    }

    for (const element of root.querySelectorAll<HTMLElement>("[style]")) {
      processElement(element);
    }
  }

  function processRuleDeclaration(style: CSSStyleDeclaration): void {
    for (const property of Array.from(style)) {
      const value = style.getPropertyValue(property).trim();
      if (value.length === 0) continue;

      let mappedValue: string;
      if (property.startsWith("--")) {
        if (!hasColorToken(value) || !chroma.valid(value)) continue;
        mappedValue = formatMappedColor(value);
      } else {
        if (!hasColorToken(value)) continue;
        mappedValue = mapColorsInValue(value);
      }

      if (mappedValue === value) continue;

      const tracked = trackedSheetStyles.get(style) ?? new Map();
      if (!tracked.has(property)) {
        tracked.set(property, {
          value,
          priority: style.getPropertyPriority(property),
        });
        trackedSheetStyles.set(style, tracked);
        touchedDeclarations.add(style);
      }

      style.setProperty(property, mappedValue, "important");
    }
  }

  function processRule(rule: CSSRule): void {
    if (rule instanceof CSSStyleRule) {
      processRuleDeclaration(rule.style);
    } else if ("cssRules" in rule) {
      for (const child of Array.from((rule as CSSMediaRule).cssRules)) {
        processRule(child);
      }
    }
  }

  function isStyledSheet(sheet: CSSStyleSheet): boolean {
    return (
      sheet.ownerNode instanceof HTMLStyleElement &&
      sheet.ownerNode.hasAttribute("data-styled")
    );
  }

  function processStyledSheet(sheet: CSSStyleSheet): void {
    try {
      for (const rule of Array.from(sheet.cssRules)) {
        processRule(rule);
      }
    } catch {
      // SecurityError for cross-origin sheets
    }
  }

  function patchInsertRule(): void {
    const proto = CSSStyleSheet.prototype;
    originalInsertRule = proto.insertRule;
    proto.insertRule = function (rule: string, index?: number): number {
      const insertedIndex = originalInsertRule!.call(this, rule, index);
      if (isStyledSheet(this)) {
        const insertedRule = this.cssRules[insertedIndex];
        if (insertedRule != null) {
          processRule(insertedRule);
        }
      }
      return insertedIndex;
    };
  }

  function unpatchInsertRule(): void {
    if (originalInsertRule != null) {
      CSSStyleSheet.prototype.insertRule = originalInsertRule;
      originalInsertRule = null;
    }
  }

  function restoreProperty(
    element: HTMLElement,
    property: string,
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

      if (tracked?.customProperties != null) {
        for (const [property, value] of tracked.customProperties) {
          restoreProperty(element, property, value);
        }
      }
    }

    touchedElements.clear();
    trackedInlineStyles = new WeakMap<HTMLElement, TrackedElementStyles>();
  }

  function restoreSheetOverrides(): void {
    for (const style of touchedDeclarations) {
      const tracked = trackedSheetStyles.get(style);
      if (tracked == null) continue;
      for (const [property, original] of tracked) {
        if (original.value.length === 0) {
          style.removeProperty(property);
        } else {
          style.setProperty(property, original.value, original.priority);
        }
      }
    }

    touchedDeclarations.clear();
    trackedSheetStyles = new WeakMap<
      CSSStyleDeclaration,
      Map<string, TrackedInlineStyle>
    >();
  }

  function start(): void {
    if (observer != null) {
      return;
    }

    for (const sheet of Array.from(document.styleSheets)) {
      if (isStyledSheet(sheet)) {
        processStyledSheet(sheet);
      }
    }

    patchInsertRule();
    processTree(document.documentElement);

    observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        if (mutation.type === "attributes") {
          const target = mutation.target;
          if (
            target instanceof HTMLElement &&
            !selfMutatingElements.has(target)
          ) {
            processElement(target);
          }
          continue;
        }

        for (const node of mutation.addedNodes) {
          if (
            node instanceof HTMLStyleElement &&
            node.hasAttribute("data-styled") &&
            node.sheet != null
          ) {
            processStyledSheet(node.sheet);
          }

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
    unpatchInsertRule();
    restoreSheetOverrides();
    restoreInlineOverrides();
  }

  return {
    start,
    stop,
  };
}
