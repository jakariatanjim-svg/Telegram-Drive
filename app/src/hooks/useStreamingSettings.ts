import { useState, useEffect, useCallback } from 'react';
import { load } from '@tauri-apps/plugin-store';
import { StreamingQuality, StreamingSettings } from '../types';

const STORAGE_KEY = 'streaming_settings_v1';
const STREAMING_STORE_FILE = 'streaming.json';

const VALID_QUALITIES: StreamingQuality[] = [
    '360p',
    '480p',
    '720p',
    '1080p',
    '1440p',
    '2160p',
    'original',
];

const DEFAULTS: StreamingSettings = {
    quality: 'original',
    adaptiveMode: false,
};

function parseSettingsObject(parsed: unknown): StreamingSettings | null {
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return null;
    }
    const candidate = parsed as Partial<StreamingSettings>;
    const quality =
        candidate.quality && VALID_QUALITIES.includes(candidate.quality)
            ? candidate.quality
            : DEFAULTS.quality;
    const adaptiveMode =
        typeof candidate.adaptiveMode === 'boolean' ? candidate.adaptiveMode : DEFAULTS.adaptiveMode;
    return { quality, adaptiveMode };
}

function loadSettings(): StreamingSettings {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (raw) {
            const parsed = parseSettingsObject(JSON.parse(raw));
            if (parsed) return parsed;
        }
    } catch { /* corrupt data, use defaults */ }
    return { ...DEFAULTS };
}

export function useStreamingSettings() {
    const [settings, setSettings] = useState<StreamingSettings>(loadSettings);

    // Hydrate from portable store if localStorage had not yet loaded
    useEffect(() => {
        let cancelled = false;
        void (async () => {
            try {
                const store = await load(STREAMING_STORE_FILE);
                const saved = await store.get<StreamingSettings>(STORAGE_KEY);
                const parsed = parseSettingsObject(saved);
                if (!cancelled && parsed && !localStorage.getItem(STORAGE_KEY)) {
                    setSettings(parsed);
                }
            } catch {
                // Ignore store load error
            }
        })();
        return () => {
            cancelled = true;
        };
    }, []);

    useEffect(() => {
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
        } catch { /* storage full or unavailable */ }
        void (async () => {
            try {
                const store = await load(STREAMING_STORE_FILE);
                await store.set(STORAGE_KEY, settings);
                await store.save();
            } catch {
                // Ignore
            }
        })();
    }, [settings]);

    const setQuality = useCallback((quality: StreamingQuality) => {
        setSettings(prev => ({ ...prev, quality }));
    }, []);

    const setAdaptiveMode = useCallback((adaptiveMode: boolean) => {
        setSettings(prev => ({ ...prev, adaptiveMode }));
    }, []);

    return { settings, setQuality, setAdaptiveMode };
}
