import { openPath, openUrl } from './plugin-opener';

export async function open(target: string): Promise<void> {
  if (/^(https?:|tg:|mailto:)/i.test(target)) {
    await openUrl(target);
  } else {
    await openPath(target);
  }
}
