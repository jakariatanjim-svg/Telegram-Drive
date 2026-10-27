import type { UnlistenFn } from '../eventBus';
import { getElectronBridge } from '../nativeBridge';

export type DragDropPayload =
  | { type: 'enter'; paths: string[]; position: { x: number; y: number } }
  | { type: 'over'; position: { x: number; y: number } }
  | { type: 'drop'; paths: string[]; position: { x: number; y: number } }
  | { type: 'leave' };

export interface DragDropEvent {
  payload: DragDropPayload;
}

export function getCurrentWebview() {
  return {
    async onDragDropEvent(handler: (event: DragDropEvent) => void): Promise<UnlistenFn> {
      let dragDepth = 0;

      const onDragEnter = (e: DragEvent) => {
        if (!e.dataTransfer?.types.includes('Files')) return;
        e.preventDefault();
        dragDepth++;
        if (dragDepth === 1) {
          const itemCount = Math.max(
            1,
            Array.from(e.dataTransfer.items ?? []).filter(i => i.kind === 'file').length,
          );
          const placeholderPaths = Array.from({ length: itemCount }, (_, idx) => `item_${idx}`);
          handler({
            payload: {
              type: 'enter',
              paths: placeholderPaths,
              position: { x: e.clientX, y: e.clientY },
            },
          });
        }
      };

      const onDragOver = (e: DragEvent) => {
        if (!e.dataTransfer?.types.includes('Files')) return;
        e.preventDefault();
        handler({
          payload: {
            type: 'over',
            position: { x: e.clientX, y: e.clientY },
          },
        });
      };

      const onDragLeave = (e: DragEvent) => {
        if (!e.dataTransfer?.types.includes('Files')) return;
        dragDepth = Math.max(0, dragDepth - 1);
        if (dragDepth === 0) {
          handler({ payload: { type: 'leave' } });
        }
      };

      const onDrop = (e: DragEvent) => {
        if (!e.dataTransfer?.types.includes('Files')) return;
        e.preventDefault();
        dragDepth = 0;
        const bridge = getElectronBridge();
        const files = Array.from(e.dataTransfer.files ?? []);
        const paths = files
          .map(f => bridge?.getPathForFile(f) || '')
          .filter((p): p is string => Boolean(p));

        handler({
          payload: {
            type: 'drop',
            paths,
            position: { x: e.clientX, y: e.clientY },
          },
        });
      };

      window.addEventListener('dragenter', onDragEnter, true);
      window.addEventListener('dragover', onDragOver, true);
      window.addEventListener('dragleave', onDragLeave, true);
      window.addEventListener('drop', onDrop, true);

      return () => {
        window.removeEventListener('dragenter', onDragEnter, true);
        window.removeEventListener('dragover', onDragOver, true);
        window.removeEventListener('dragleave', onDragLeave, true);
        window.removeEventListener('drop', onDrop, true);
      };
    },
  };
}
