'use client';

/**
 * The per-activity selector at the top of the Schedule Designer. The screen is
 * one boat's weekly template at a time; picking a boat navigates to that boat's
 * template (URL-driven so the designer re-loads server-side with fresh rules).
 */
import { useRouter } from 'next/navigation';
import { FieldLabel, Select } from '../ui';

export interface ActivityOption {
  id: string;
  name: string;
}

export function ActivitySwitcher({
  activities,
  selectedId,
}: {
  activities: ActivityOption[];
  selectedId: string;
}) {
  const router = useRouter();
  return (
    <div className="max-w-sm">
      <FieldLabel htmlFor="schedule-activity">Boat / listing</FieldLabel>
      <Select
        id="schedule-activity"
        value={selectedId}
        onChange={(e) => router.push(`/schedule?tab=design&activity=${e.target.value}`)}
      >
        {activities.map((a) => (
          <option key={a.id} value={a.id}>
            {a.name}
          </option>
        ))}
      </Select>
    </div>
  );
}
