import {
  FUEL_TYPE_LABELS,
  VEHICLE_CLASSES,
  effectiveMileage,
  fuelTypeSchema,
  type CommutePreferences,
} from '@machiya/shared';
import { useId } from 'react';
import { cn } from '../../lib/utils';

/**
 * The inputs behind a commute figure: vehicle, mileage, fuel, trips and days.
 *
 * Shared by the listing panel, where they change one listing's number in place,
 * and the account page, where they are the stored default. One copy, because
 * two would let the two surfaces disagree about what a trip is.
 */
export interface CommuteControlsProps {
  preferences: CommutePreferences;
  onChange: (patch: Partial<CommutePreferences>) => void;
  className?: string;
}

export function CommuteControls({ preferences, onChange, className }: CommuteControlsProps) {
  const mileageId = useId();
  const tripsId = useId();
  const daysId = useId();

  const vehicles = VEHICLE_CLASSES.filter(
    (vehicle) => vehicle.mode === (preferences.mode === 'transit' ? 'car' : preferences.mode),
  );

  return (
    <div className={cn('grid grid-cols-2 gap-2', className)}>
      {preferences.mode !== 'transit' ? (
        <>
          <label className="flex flex-col gap-0.5">
            <span className="text-label text-ink-soft">Vehicle</span>
            <select
              value={preferences.vehicleClass}
              onChange={(event) =>
                onChange({
                  vehicleClass: event.target.value as CommutePreferences['vehicleClass'],
                  // Cleared so the new class's own figure takes effect; the
                  // server does the same, and doing it here too stops the
                  // field showing a stale number for one round trip.
                  mileageKmPerLitre: null,
                })
              }
              className="h-8 rounded-inset border border-input bg-card px-1.5 text-sm"
            >
              {vehicles.map((vehicle) => (
                <option key={vehicle.id} value={vehicle.id}>
                  {vehicle.label}
                </option>
              ))}
            </select>
          </label>

          <label htmlFor={mileageId} className="flex flex-col gap-0.5">
            <span className="text-label text-ink-soft">Mileage (km/l)</span>
            <input
              id={mileageId}
              type="number"
              min={1}
              max={100}
              step={0.5}
              value={effectiveMileage(preferences)}
              onChange={(event) => {
                const next = Number(event.target.value);
                if (Number.isFinite(next) && next >= 1) onChange({ mileageKmPerLitre: next });
              }}
              className="h-8 rounded-inset border border-input bg-card px-1.5 text-sm tabular-nums"
            />
          </label>

          <label className="flex flex-col gap-0.5">
            <span className="text-label text-ink-soft">Fuel</span>
            <select
              value={preferences.fuelType}
              onChange={(event) => onChange({ fuelType: fuelTypeSchema.parse(event.target.value) })}
              className="h-8 rounded-inset border border-input bg-card px-1.5 text-sm"
            >
              {fuelTypeSchema.options.map((fuel) => (
                <option key={fuel} value={fuel}>
                  {FUEL_TYPE_LABELS[fuel]}
                </option>
              ))}
            </select>
          </label>
        </>
      ) : null}

      <label htmlFor={tripsId} className="flex flex-col gap-0.5">
        <span className="text-label text-ink-soft">Trips per day</span>
        <input
          id={tripsId}
          type="number"
          min={1}
          max={10}
          value={preferences.tripsPerDay}
          onChange={(event) => {
            const next = Number(event.target.value);
            if (Number.isInteger(next) && next >= 1) onChange({ tripsPerDay: next });
          }}
          className="h-8 rounded-inset border border-input bg-card px-1.5 text-sm tabular-nums"
        />
      </label>

      <label htmlFor={daysId} className="flex flex-col gap-0.5">
        <span className="text-label text-ink-soft">Working days</span>
        <input
          id={daysId}
          type="number"
          min={1}
          max={31}
          value={preferences.workingDaysPerMonth}
          onChange={(event) => {
            const next = Number(event.target.value);
            if (Number.isInteger(next) && next >= 1) onChange({ workingDaysPerMonth: next });
          }}
          className="h-8 rounded-inset border border-input bg-card px-1.5 text-sm tabular-nums"
        />
      </label>
    </div>
  );
}
