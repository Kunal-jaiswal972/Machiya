import { useStatusProbe } from '../hooks/use-status';
import { cn } from '../lib/utils';

/**
 * Scaffolding probe: proves web to API to Postgres/Redis wiring end to end.
 * Replaced by the real search panel in step 6.
 */
export function StatusCard() {
  const { hello, health } = useStatusProbe();

  return (
    <section
      aria-label="Service status"
      className="w-80 max-w-[calc(100vw-2rem)] rounded-xl border bg-card/95 p-4 shadow-lg backdrop-blur"
    >
      <h2 className="text-sm font-semibold tracking-tight">Stack status</h2>

      <p className="mt-1 text-xs text-muted-foreground">
        {hello.isPending && 'Contacting the API…'}
        {hello.isError && 'API unreachable. Is it running on port 4000?'}
        {hello.data?.message}
      </p>

      <ul className="mt-3 space-y-1.5">
        <StatusRow
          label="api"
          ok={hello.isSuccess}
          pending={hello.isPending}
          detail={hello.data ? 'hello route responding' : undefined}
        />
        {health.data?.dependencies.map((dependency) => (
          <StatusRow
            key={dependency.name}
            label={dependency.name}
            ok={dependency.ok}
            pending={false}
            detail={dependency.detail ?? dependency.error}
          />
        ))}
        {health.isPending && <StatusRow label="dependencies" ok={false} pending />}
      </ul>
    </section>
  );
}

interface StatusRowProps {
  label: string;
  ok: boolean;
  pending: boolean;
  detail?: string;
}

function StatusRow({ label, ok, pending, detail }: StatusRowProps) {
  return (
    <li className="flex items-center gap-2 text-xs">
      <span
        aria-hidden
        className={cn(
          'size-2 shrink-0 rounded-full',
          pending ? 'animate-pulse bg-muted-foreground' : ok ? 'bg-band-1' : 'bg-band-4',
        )}
      />
      <span className="font-mono">{label}</span>
      <span className="sr-only">{pending ? 'checking' : ok ? 'healthy' : 'unhealthy'}</span>
      {detail && <span className="truncate text-muted-foreground">{detail}</span>}
    </li>
  );
}
