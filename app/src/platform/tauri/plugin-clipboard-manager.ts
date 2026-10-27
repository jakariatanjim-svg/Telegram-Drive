import { getElectronBridge } from '../nativeBridge';

export async function writeText(text: string): Promise<void> {
  const bridge = getElectronBridge();
  if (bridge) {
    await bridge.clipboardWriteText(text);
    return;
  }
  await navigator.clipboard.writeText(text);
}

export async function readText(): Promise<string> {
  const bridge = getElectronBridge();
  if (bridge) {
    return await bridge.clipboardReadText();
  }
  return await navigator.clipboard.readText();
}
