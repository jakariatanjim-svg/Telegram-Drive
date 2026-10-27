import {
  emitPlatformEvent,
  subscribeEvent,
  type PlatformEvent,
  type UnlistenFn,
} from '../eventBus';

export type { UnlistenFn };
export type Event<T> = PlatformEvent<T>;
export type EventCallback<T> = (event: Event<T>) => void;

export async function listen<T = unknown>(
  event: string,
  handler: EventCallback<T>,
): Promise<UnlistenFn> {
  return subscribeEvent<T>(event, handler);
}

export async function emit(event: string, payload?: unknown): Promise<void> {
  return emitPlatformEvent(event, payload);
}
