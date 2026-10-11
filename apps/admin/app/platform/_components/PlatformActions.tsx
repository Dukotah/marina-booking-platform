'use client';

import { useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { openClientAction } from '../actions';
import { Button } from '../../../components/ui';

/** Drops the platform admin into a client's dashboard, then navigates there. */
export function OpenClientButton({ operatorId }: { operatorId: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  return (
    <Button
      variant="primary"
      size="sm"
      disabled={pending}
      onClick={() =>
        start(async () => {
          await openClientAction(operatorId);
          router.push('/');
          router.refresh();
        })
      }
    >
      {pending ? 'Opening…' : 'Open dashboard'}
    </Button>
  );
}
