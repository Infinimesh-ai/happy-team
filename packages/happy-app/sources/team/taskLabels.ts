import { t } from '@/text';
import { TaskStatus } from './api';

/** Human-readable, localized label for a task/stage status. */
export function taskStatusLabel(status: TaskStatus): string {
    switch (status) {
        case 'PENDING': return t('team.tasks.statusPending');
        case 'PREPARING': return t('team.tasks.statusPreparing');
        case 'RUNNING': return t('team.tasks.statusRunning');
        case 'WAITING_APPROVAL': return t('team.tasks.statusWaitingApproval');
        case 'SUCCEEDED': return t('team.tasks.statusSucceeded');
        case 'FAILED': return t('team.tasks.statusFailed');
        case 'ESCALATED': return t('team.tasks.statusEscalated');
        case 'CANCELLED': return t('team.tasks.statusCancelled');
    }
}
