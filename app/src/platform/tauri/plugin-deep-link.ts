import { subscribeEvent, type UnlistenFn } from '../eventBus';

export async function getCurrent(): Promise<string[] | null> {
  return null;
}

export async function onOpenUrl(handler: (urls: string[]) => void): Promise<UnlistenFn> {
  return subscribeEvent<string[]>('td:deep-link', ev => {
    if (Array.isArray(ev.payload) && ev.payload.length > 0) {
      handler(ev.payload);
    }
  });
}
