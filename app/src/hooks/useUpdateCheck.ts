import { useState, useCallback } from 'react';
import type { UpdateInstallPhase } from '../services/updateReliability';
import { openUrl } from '@tauri-apps/plugin-opener';

export const RELEASES_URL = 'https://github.com/jakariatanjim-svg/Telegram-Drive/releases/latest';

interface UpdateState {
    checking: boolean;
    available: boolean;
    downloading: boolean;
    progress: number;
    error: string | null;
    version: string | null;
    phase: UpdateInstallPhase | null;
}

interface UpdateCheckResult {
    version: string | null;
    error: string | null;
}

interface UpdateInstallResult {
    error: string | null;
}

export function useUpdateCheck() {
    const [state, setState] = useState<UpdateState>({
        checking: false,
        available: false,
        downloading: false,
        progress: 0,
        error: null,
        version: null,
        phase: null,
    });

    const checkForUpdates = useCallback(async (): Promise<UpdateCheckResult> => {
        setState(s => ({ ...s, checking: false, available: false, error: null }));
        return { version: null, error: null };
    }, []);

    const downloadAndInstall = useCallback(async (): Promise<UpdateInstallResult> => {
        try {
            await openUrl(RELEASES_URL);
            return { error: null };
        } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            setState(s => ({ ...s, error: message }));
            return { error: message };
        }
    }, []);

    const dismissUpdate = useCallback(() => {
        setState(s => ({ ...s, checking: false, available: false, version: null, phase: null }));
    }, []);

    return {
        ...state,
        checkForUpdates,
        downloadAndInstall,
        dismissUpdate,
    };
}
