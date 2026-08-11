import { z } from "zod";
import { storage } from "wxt/utils/storage";

export const enabledItem = storage.defineItem<boolean>("local:enabled", {
  fallback: true,
});

export const useSystemPrefItem = storage.defineItem<boolean>("local:useSystemPref", {
  fallback: false,
});

export const rateWidgetDismissedItem = storage.defineItem<boolean>("local:rateWidgetDismissed", {
  fallback: false,
});

const BooleanSchema = z.boolean();

export async function readEnabled(): Promise<boolean> {
  return BooleanSchema.parse(await enabledItem.getValue());
}

export async function readUseSystemPref(): Promise<boolean> {
  return BooleanSchema.parse(await useSystemPrefItem.getValue());
}

export async function readRateWidgetDismissed(): Promise<boolean> {
  return BooleanSchema.parse(await rateWidgetDismissedItem.getValue());
}
