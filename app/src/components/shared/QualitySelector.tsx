import { useTranslation } from 'react-i18next';
import {
    StreamingQuality,
    qualityLabel,
    HLS_QUALITIES,
    TranscodeCapabilities,
    TranscodeJobPhase,
} from '../../types';
import { Zap, Wifi, Loader2, AlertTriangle, Check } from 'lucide-react';
import i18n from '../../i18n';

interface QualitySelectorProps {
    currentQuality: StreamingQuality;
    onChange: (quality: StreamingQuality) => void;
    adaptiveMode: boolean;
    onToggleAdaptive: () => void;
    measuredSpeedKbps?: number;
    transcodeCapabilities?: TranscodeCapabilities | null;
    variantStates?: Record<string, TranscodeJobPhase>;
    sourceHeight?: number | null;
}

const QUALITIES: StreamingQuality[] = [
    '360p',
    '480p',
    '720p',
    '1080p',
    '1440p',
    '2160p',
    'original',
];

export function QualitySelector({
    currentQuality,
    onChange,
    adaptiveMode,
    onToggleAdaptive,
    measuredSpeedKbps,
    transcodeCapabilities,
    variantStates = {},
    sourceHeight = null,
}: QualitySelectorProps) {
    const { t } = useTranslation();

    const handleManualQuality = (quality: StreamingQuality) => {
        if (adaptiveMode) onToggleAdaptive();
        onChange(quality);
    };

    const isTranscodeAvailable =
        transcodeCapabilities?.available ?? transcodeCapabilities?.ffmpeg_available ?? false;

    const visibleQualities = QUALITIES.filter(quality => {
        if (quality === 'original' || currentQuality === quality) return true;
        if (sourceHeight === null || sourceHeight <= 0) return true;
        const qualityHeight = parseInt(quality, 10);
        return qualityHeight <= sourceHeight;
    });

    return (
        <div className="flex flex-wrap items-center gap-1.5 bg-black/50 backdrop-blur-sm rounded-lg px-2 py-1.5 border border-white/10">
            {/* Adaptive Auto toggle */}
            <button
                type="button"
                onClick={onToggleAdaptive}
                className={`flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-medium transition-all duration-200 ${
                    adaptiveMode
                        ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30'
                        : 'text-white/60 hover:text-white border border-transparent hover:bg-white/5'
                }`}
                title={
                    adaptiveMode
                        ? 'Adaptive quality: ON — automatically selects optimal stream'
                        : 'Adaptive quality: OFF — manual quality selection'
                }
            >
                <Wifi className="w-3 h-3" />
                {i18n.t('settings.auto')}
            </button>

            {/* Divider */}
            <div className="w-px h-5 bg-white/15" />

            {/* Full unlocked quality presets (360p through 4K + Original) */}
            {visibleQualities.map(quality => {
                const isActive = !adaptiveMode && currentQuality === quality;
                const isHls = HLS_QUALITIES.includes(quality);
                const variantState: TranscodeJobPhase = variantStates[quality] ?? 'idle';
                const label = qualityLabel(quality, t('settings.original'));

                let statusIcon: React.ReactNode = null;
                if (isHls && (variantState === 'preparing' || variantState === 'caching' || variantState === 'transcoding')) {
                    statusIcon = <Loader2 className="w-3 h-3 animate-spin" />;
                } else if (variantState === 'ready') {
                    statusIcon = <Check className="w-3 h-3 text-emerald-400" />;
                } else if (variantState === 'failed') {
                    statusIcon = <AlertTriangle className="w-3 h-3 text-red-400" />;
                }

                const tooltipHint =
                    quality === 'original'
                        ? 'Stream full original quality (uncompressed)'
                        : isTranscodeAvailable
                          ? variantState === 'preparing'
                              ? `Preparing ${label}...`
                              : variantState === 'caching'
                                ? 'Caching source stream...'
                                : variantState === 'transcoding'
                                  ? `Transcoding to ${label}...`
                                  : variantState === 'ready'
                                    ? `${label} ready (HLS)`
                                    : variantState === 'failed'
                                      ? `${label} transcode failed — click to retry`
                                      : `Play in ${label}`
                          : `Play ${label} (streams full source when FFmpeg is not installed)`;

                return (
                    <button
                        type="button"
                        key={quality}
                        onClick={() => handleManualQuality(quality)}
                        className={`flex items-center gap-1.5 px-2 py-1 rounded-md text-[11px] font-medium transition-all duration-200 ${
                            isActive
                                ? 'bg-telegram-primary/20 text-telegram-primary border border-telegram-primary/30'
                                : adaptiveMode
                                  ? 'text-white/45 hover:text-white/85 hover:bg-white/5 border border-transparent'
                                  : 'text-white/65 hover:text-white/95 hover:bg-white/5 border border-transparent'
                        }`}
                        title={tooltipHint}
                    >
                        {statusIcon}
                        <span>{label}</span>
                    </button>
                );
            })}

            {/* Measured speed indicator (in adaptive mode) */}
            {adaptiveMode && measuredSpeedKbps !== undefined && measuredSpeedKbps > 0 && (
                <>
                    <div className="w-px h-5 bg-white/15" />
                    <span className="flex items-center gap-1 text-[10px] text-white/50">
                        <Zap className="w-3 h-3" />
                        {measuredSpeedKbps > 999
                            ? `${(measuredSpeedKbps / 1000).toFixed(1)} Mbps`
                            : `${Math.round(measuredSpeedKbps)} Kbps`}
                    </span>
                </>
            )}
        </div>
    );
}
