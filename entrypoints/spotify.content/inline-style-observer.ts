import chroma from "chroma-js";

import { formatMappedColor, hasColorToken, mapColorsInValue } from "../../lib/style-color-mapping";

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

export class InlineStyleObserver {
  private readonly selfMutatingElements = new WeakSet<HTMLElement>();
  private trackedInlineStyles = new WeakMap<HTMLElement, TrackedElementStyles>();
  private readonly touchedElements = new Set<HTMLElement>();

  private trackedSheetStyles = new WeakMap<CSSStyleDeclaration, Map<string, TrackedInlineStyle>>();
  private readonly touchedDeclarations = new Set<CSSStyleDeclaration>();
  private originalInsertRule: typeof CSSStyleSheet.prototype.insertRule | null = null;

  private readonly pendingElements = new Set<HTMLElement>();
  private readonly pendingTrees = new Set<HTMLElement>();
  private readonly pendingRules = new Set<CSSRule>();
  private readonly pendingStyledSheets = new Set<CSSStyleSheet>();
  private readonly observer = new MutationObserver((mutations) => this.handleMutations(mutations));

  private active = false;
  private observing = false;
  private processingFrameId: number | null = null;

  start(): void {
    if (this.active) {
      return;
    }

    this.active = true;

    for (const sheet of Array.from(document.styleSheets)) {
      if (this.isStyledSheet(sheet)) {
        this.processStyledSheet(sheet);
      }
    }

    this.patchInsertRule();
    this.processTree(document.documentElement);
    this.startObserving();
  }

  stop(): void {
    this.active = false;
    this.cancelScheduledProcessing();
    this.stopObserving();
    this.unpatchInsertRule();
    this.restoreSheetOverrides();
    this.restoreInlineOverrides();
  }

  private trackOriginalInlineStyle(element: HTMLElement, property: InlineStyleProperty): void {
    const tracked = this.trackedInlineStyles.get(element) ?? {};

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

    this.trackedInlineStyles.set(element, tracked);
    this.touchedElements.add(element);
  }

  private trackOriginalCustomProperty(element: HTMLElement, property: string): void {
    const tracked = this.trackedInlineStyles.get(element) ?? {};
    const customProperties = tracked.customProperties ?? new Map();

    if (!customProperties.has(property)) {
      customProperties.set(property, {
        value: element.style.getPropertyValue(property),
        priority: element.style.getPropertyPriority(property),
      });
    }

    tracked.customProperties = customProperties;
    this.trackedInlineStyles.set(element, tracked);
    this.touchedElements.add(element);
  }

  private maybeOverrideInlineStyle(element: HTMLElement, property: InlineStyleProperty): void {
    const originalValue = element.style.getPropertyValue(property).trim();
    if (originalValue.length === 0 || !hasColorToken(originalValue)) {
      return;
    }

    const mappedValue = mapColorsInValue(originalValue);
    if (mappedValue === originalValue) {
      return;
    }

    this.trackOriginalInlineStyle(element, property);
    this.selfMutatingElements.add(element);
    element.style.setProperty(property, mappedValue, "important");
    queueMicrotask(() => {
      this.selfMutatingElements.delete(element);
    });
  }

  private maybeOverrideInlineCustomProperties(element: HTMLElement): void {
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

      this.trackOriginalCustomProperty(element, property);
      this.selfMutatingElements.add(element);
      element.style.setProperty(property, mappedValue, "important");
      queueMicrotask(() => {
        this.selfMutatingElements.delete(element);
      });
    }
  }

  private processElement(element: HTMLElement): void {
    this.maybeOverrideInlineStyle(element, "background-image");
    this.maybeOverrideInlineStyle(element, "background-color");
    this.maybeOverrideInlineCustomProperties(element);
  }

  private processTree(root: ParentNode): void {
    if (root instanceof HTMLElement) {
      this.processElement(root);
    }

    for (const element of root.querySelectorAll<HTMLElement>("[style]")) {
      this.processElement(element);
    }
  }

  private processRuleDeclaration(style: CSSStyleDeclaration): void {
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

      const tracked = this.trackedSheetStyles.get(style) ?? new Map();
      if (!tracked.has(property)) {
        tracked.set(property, {
          value,
          priority: style.getPropertyPriority(property),
        });
        this.trackedSheetStyles.set(style, tracked);
        this.touchedDeclarations.add(style);
      }

      style.setProperty(property, mappedValue, "important");
    }
  }

  private processRule(rule: CSSRule): void {
    if (rule instanceof CSSStyleRule) {
      this.processRuleDeclaration(rule.style);
    } else if ("cssRules" in rule) {
      for (const child of Array.from((rule as CSSMediaRule).cssRules)) {
        this.processRule(child);
      }
    }
  }

  private isStyledSheet(sheet: CSSStyleSheet): boolean {
    return (
      sheet.ownerNode instanceof HTMLStyleElement && sheet.ownerNode.hasAttribute("data-styled")
    );
  }

  private processStyledSheet(sheet: CSSStyleSheet): void {
    try {
      for (const rule of Array.from(sheet.cssRules)) {
        this.processRule(rule);
      }
    } catch {
      // SecurityError for cross-origin sheets
    }
  }

  private hasPendingTreeAncestor(element: HTMLElement): boolean {
    for (const root of this.pendingTrees) {
      if (root === element || root.contains(element)) {
        return true;
      }
    }

    return false;
  }

  private enqueueElement(element: HTMLElement): void {
    if (this.hasPendingTreeAncestor(element)) return;

    this.pendingElements.add(element);
    this.scheduleProcessing();
  }

  private enqueueTree(root: HTMLElement): void {
    if (this.hasPendingTreeAncestor(root)) return;

    for (const pendingRoot of Array.from(this.pendingTrees)) {
      if (root.contains(pendingRoot)) {
        this.pendingTrees.delete(pendingRoot);
      }
    }

    for (const pendingElement of Array.from(this.pendingElements)) {
      if (root.contains(pendingElement)) {
        this.pendingElements.delete(pendingElement);
      }
    }

    this.pendingTrees.add(root);
    this.scheduleProcessing();
  }

  private enqueueStyledSheet(sheet: CSSStyleSheet): void {
    this.pendingStyledSheets.add(sheet);

    for (const rule of Array.from(this.pendingRules)) {
      if (rule.parentStyleSheet === sheet) {
        this.pendingRules.delete(rule);
      }
    }

    this.scheduleProcessing();
  }

  private enqueueRule(rule: CSSRule): void {
    const parentStyleSheet = rule.parentStyleSheet;
    if (parentStyleSheet !== null && this.pendingStyledSheets.has(parentStyleSheet)) return;

    this.pendingRules.add(rule);
    this.scheduleProcessing();
  }

  private handleMutations(mutations: MutationRecord[]): void {
    if (!this.active) return;

    for (const mutation of mutations) {
      if (mutation.type === "attributes") {
        const target = mutation.target;
        if (target instanceof HTMLElement && !this.selfMutatingElements.has(target)) {
          this.enqueueElement(target);
        }
        continue;
      }

      for (const node of mutation.addedNodes) {
        if (
          node instanceof HTMLStyleElement &&
          node.hasAttribute("data-styled") &&
          node.sheet !== null
        ) {
          this.enqueueStyledSheet(node.sheet);
        }

        if (node instanceof HTMLElement) {
          this.enqueueTree(node);
        }
      }
    }
  }

  private flushPendingWork(): void {
    if (!this.active) return;

    const styledSheets = Array.from(this.pendingStyledSheets);
    const rules = Array.from(this.pendingRules);
    const trees = Array.from(this.pendingTrees);
    const elements = Array.from(this.pendingElements);

    this.pendingStyledSheets.clear();
    this.pendingRules.clear();
    this.pendingTrees.clear();
    this.pendingElements.clear();

    this.stopObserving();
    try {
      for (const sheet of styledSheets) {
        this.processStyledSheet(sheet);
      }

      for (const rule of rules) {
        this.processRule(rule);
      }

      for (const root of trees) {
        this.processTree(root);
      }

      for (const element of elements) {
        this.processElement(element);
      }
    } finally {
      if (this.active) {
        this.startObserving();
      }
    }
  }

  private patchInsertRule(): void {
    const proto = CSSStyleSheet.prototype;
    this.originalInsertRule = proto.insertRule;
    const originalInsertRule = this.originalInsertRule;
    const inlineStyleObserver = this;

    proto.insertRule = function (this: CSSStyleSheet, rule: string, index?: number): number {
      const insertedIndex = originalInsertRule.call(this, rule, index);
      if (inlineStyleObserver.isStyledSheet(this)) {
        const insertedRule = this.cssRules[insertedIndex];
        if (insertedRule != null) {
          inlineStyleObserver.enqueueRule(insertedRule);
        }
      }
      return insertedIndex;
    };
  }

  private unpatchInsertRule(): void {
    if (this.originalInsertRule != null) {
      CSSStyleSheet.prototype.insertRule = this.originalInsertRule;
      this.originalInsertRule = null;
    }
  }

  private restoreProperty(
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

  private restoreInlineOverrides(): void {
    for (const element of this.touchedElements) {
      const tracked = this.trackedInlineStyles.get(element);
      if (tracked?.backgroundImage != null) {
        this.restoreProperty(element, "background-image", tracked.backgroundImage);
      }

      if (tracked?.backgroundColor != null) {
        this.restoreProperty(element, "background-color", tracked.backgroundColor);
      }

      if (tracked?.customProperties != null) {
        for (const [property, value] of tracked.customProperties) {
          this.restoreProperty(element, property, value);
        }
      }
    }

    this.touchedElements.clear();
    this.trackedInlineStyles = new WeakMap<HTMLElement, TrackedElementStyles>();
  }

  private restoreSheetOverrides(): void {
    for (const style of this.touchedDeclarations) {
      const tracked = this.trackedSheetStyles.get(style);
      if (tracked == null) continue;
      for (const [property, original] of tracked) {
        if (original.value.length === 0) {
          style.removeProperty(property);
        } else {
          style.setProperty(property, original.value, original.priority);
        }
      }
    }

    this.touchedDeclarations.clear();
    this.trackedSheetStyles = new WeakMap<CSSStyleDeclaration, Map<string, TrackedInlineStyle>>();
  }

  private startObserving(): void {
    if (this.observing) return;

    this.observer.observe(document.documentElement, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["style"],
    });
    this.observing = true;
  }

  private stopObserving(): void {
    if (!this.observing) return;

    this.observer.disconnect();
    this.observing = false;
  }

  private cancelScheduledProcessing(): void {
    if (this.processingFrameId !== null) {
      cancelAnimationFrame(this.processingFrameId);
      this.processingFrameId = null;
    }

    this.pendingStyledSheets.clear();
    this.pendingRules.clear();
    this.pendingTrees.clear();
    this.pendingElements.clear();
  }

  private scheduleProcessing(): void {
    if (!this.active || this.processingFrameId !== null) return;

    this.processingFrameId = requestAnimationFrame(() => {
      this.processingFrameId = null;
      this.flushPendingWork();
    });
  }
}
