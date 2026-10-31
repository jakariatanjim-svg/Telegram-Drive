import { useTranslation } from 'react-i18next';
import { BandwidthStats } from '../../../types';
import { formatBytes } from '../../../utils';

interface BandwidthWidgetProps {
    bandwidth: BandwidthStats | null;
}

export function BandwidthWidget({ bandwidth }: BandwidthWidgetProps) {
    const { t } = useTranslation();
    if (!bandwidth) return null;

    const totalBytes = bandwidth.up_bytes + bandwidth.down_bytes;
    const hasCustomQuota = bandwidth.limit_bytes > 0;

    if (!hasCustomQuota) {
        return (
            <div className="mt-1.5 flex items-center justify-between text-metadata text-app-text-secondary">
                <span>
                    ↑ {formatBytes(bandwidth.up_bytes)} · ↓ {formatBytes(bandwidth.down_bytes)}
                </span>
                <span className="text-badge text-app-text-tertiary">{t('settings.unlimited')}</span>
            </div>
        );
    }

    const percent = Math.min((totalBytes / bandwidth.limit_bytes) * 100, 100);

    return (
        <div className="mt-1.5 space-y-1 text-metadata text-app-text-secondary">
            <div className="flex justify-between">
                <span>Used this week:</span>
            </div>
            <div className="h-1 w-full overflow-hidden rounded-full bg-app-border">
                <div
                    className="h-full rounded-full bg-app-accent transition-[width] duration-500"
                    style={{ width: `${percent}%` }}
                ></div>
            </div>
            <div className="flex justify-between text-badge text-app-text-tertiary">
                <span>{formatBytes(totalBytes)}</span>
                <span>{formatBytes(bandwidth.limit_bytes)}</span>
            </div>
        </div>
    );
}
