import { z } from 'zod';
import { storage } from 'wxt/utils/storage';

export const enabledItem = storage.defineItem<boolean>('local:enabled', {
  fallback: true,
});

export const useSystemPrefItem = storage.defineItem<boolean>('local:useSystemPref', {
  fallback: false,
});

const BooleanSchema = z.boolean();

export async function readEnabled(): Promise<boolean> {
  return BooleanSchema.parse(await enabledItem.getValue());
}

export async function readUseSystemPref(): Promise<boolean> {
  return BooleanSchema.parse(await useSystemPrefItem.getValue());
}
