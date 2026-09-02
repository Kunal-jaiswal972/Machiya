import { MapCanvas } from '../components/MapCanvas';
import { StatusCard } from '../components/StatusCard';

export function HomePage() {
  return (
    <div className="relative h-full w-full">
      <MapCanvas />

      <div className="pointer-events-none absolute inset-0 p-4">
        <div className="pointer-events-auto">
          <StatusCard />
        </div>
      </div>
    </div>
  );
}
