import { zodResolver } from '@hookform/resolvers/zod';
import {
  COMMUTE_MODES,
  mapStyleChoiceSchema,
  phoneFieldSchema,
  profileUpdateSchema,
  type CommuteMode,
  type MapStyleChoice,
} from '@machiya/shared';
import {
  Bike,
  Building2,
  Bus,
  Car,
  Loader2,
  MailCheck,
  Monitor as MonitorSmartphone,
  Moon,
  Star,
  Sun,
  Trash2,
} from 'lucide-react';
import { useEffect } from 'react';
import { useForm } from 'react-hook-form';
import { Link, useNavigate } from 'react-router';
import { toast } from 'sonner';
import { CommuteControls } from '../components/commute/CommuteControls';
import { EmptyState } from '../components/EmptyState';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '../components/ui/alert-dialog';
import { Button } from '../components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../components/ui/card';
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '../components/ui/form';
import { Input } from '../components/ui/input';
import { useDeleteAccount, useProfile, useUpdateProfile } from '../hooks/use-account';
import { useCommutePreferences } from '../hooks/use-commute';
import { useDeleteOffice, useOffices, useSetDefaultOffice } from '../hooks/use-offices';
import { useUiPreferences } from '../hooks/use-ui-preferences';
import { formatRelative } from '../lib/format';
import { startTour } from '../lib/tour';
import { auth } from '../lib/auth-client';
import { useAuth } from '../lib/auth-context';
import { cn } from '../lib/utils';

/** Empty means null to the API, which cannot take the empty string itself. */
const profileFormSchema = profileUpdateSchema.extend({ phone: phoneFieldSchema });

const MODE_ICON: Record<CommuteMode, typeof Car> = { car: Car, bike: Bike, transit: Bus };
const MODE_LABEL: Record<CommuteMode, string> = { car: 'Car', bike: 'Bike', transit: 'Bus' };

/**
 * Everything the product keeps about you, on one page: who you are, how you
 * travel, where you work, and the way out.
 *
 * The commute block writes through the same store and the same endpoint as the
 * listing panel's controls, so a default set here is the default a listing is
 * priced with — there is no second copy of these settings.
 */
export function AccountPage() {
  const { user } = useAuth();
  const profile = useProfile();

  if (!user) return null;

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-4 px-4 py-8">
      <header className="flex flex-col gap-1">
        <h1 className="text-display">Your account</h1>
        <p className="text-sm text-ink-soft">
          {user.email}
          {user.emailVerified ? (
            <span className="ml-2 inline-flex items-center gap-1 text-verdant">
              <MailCheck className="size-3.5" aria-hidden />
              verified
            </span>
          ) : (
            <span className="ml-2 text-clay">not verified yet</span>
          )}
        </p>
      </header>

      <ProfileCard
        name={profile.data?.user.name ?? user.name}
        phone={profile.data?.user.phone ?? null}
        isLoading={profile.isPending}
      />
      <CommuteCard />
      <MapCard />
      <OfficesCard />
      <DangerCard />
    </div>
  );
}

function ProfileCard({
  name,
  phone,
  isLoading,
}: {
  name: string;
  phone: string | null;
  isLoading: boolean;
}) {
  const update = useUpdateProfile();

  const form = useForm({
    resolver: zodResolver(profileFormSchema),
    defaultValues: { name, phone: phone ?? '' },
  });

  // The row arrives after the first render, so the fields are re-seeded when it
  // does — but never over something already being typed.
  const { reset, formState } = form;
  useEffect(() => {
    if (isLoading || formState.isDirty) return;
    reset({ name, phone: phone ?? '' });
  }, [name, phone, isLoading, formState.isDirty, reset]);

  const submit = form.handleSubmit((values) => {
    update.mutate(
      { name: values.name, phone: values.phone ? values.phone : null },
      {
        onSuccess: (result) => {
          form.reset({ name: result.user.name, phone: result.user.phone ?? '' });
          toast.success('Saved');
        },
        onError: (error) =>
          toast.error(error instanceof Error ? error.message : 'That could not be saved'),
      },
    );
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>Details</CardTitle>
        <CardDescription>
          Your name is what a lister sees on an enquiry. Your number is shared only after you send
          one.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Form {...form}>
          <form onSubmit={submit} className="flex flex-col gap-3">
            <FormField
              control={form.control}
              name="name"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Name</FormLabel>
                  <FormControl>
                    <Input {...field} autoComplete="name" />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="phone"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Phone</FormLabel>
                  <FormControl>
                    <Input
                      {...field}
                      value={field.value ?? ''}
                      inputMode="tel"
                      autoComplete="tel"
                      placeholder="98765 43210"
                    />
                  </FormControl>
                  <FormDescription>
                    Optional. Leave it empty and listers reply by message only.
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />

            <div className="flex justify-end">
              <Button type="submit" disabled={update.isPending || !form.formState.isDirty}>
                {update.isPending ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
                Save details
              </Button>
            </div>
          </form>
        </Form>
      </CardContent>
    </Card>
  );
}

function CommuteCard() {
  const { preferences, update } = useCommutePreferences();

  return (
    <Card>
      <CardHeader>
        <CardTitle>How you travel</CardTitle>
        <CardDescription>
          Every commute cost in the product is worked out from these. Change one and the listings
          re-price.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <div className="flex gap-1.5">
          {COMMUTE_MODES.map((mode) => {
            const Icon = MODE_ICON[mode];
            const isSelected = preferences.mode === mode;

            return (
              <button
                key={mode}
                type="button"
                aria-pressed={isSelected}
                onClick={() => update({ mode })}
                className={cn(
                  'flex flex-1 items-center justify-center gap-1.5 rounded-chrome border px-3 py-2 text-sm',
                  isSelected
                    ? 'border-water bg-water-soft text-ink'
                    : 'border-input text-ink-soft hover:text-ink',
                )}
              >
                <Icon className="size-4" aria-hidden />
                {MODE_LABEL[mode]}
              </button>
            );
          })}
        </div>

        <CommuteControls preferences={preferences} onChange={update} />
      </CardContent>
    </Card>
  );
}

const MAP_STYLE_LABEL: Record<MapStyleChoice, string> = {
  auto: 'Match the app',
  light: 'Light',
  dark: 'Dark',
};

function MapCard() {
  const { preferences, update, isPersisted } = useUiPreferences();
  const runTour = (): void => {
    startTour({ onFinished: () => update({ tourCompletedAt: new Date().toISOString() }) });
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>The map</CardTitle>
        <CardDescription>
          How the map is drawn, and the walkthrough of what it is showing you.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="flex flex-col gap-1.5">
          <span className="text-label text-ink-soft">Style</span>
          <div className="flex gap-1.5">
            {mapStyleChoiceSchema.options.map((choice) => (
              <button
                key={choice}
                type="button"
                aria-pressed={preferences.mapStyle === choice}
                onClick={() => update({ mapStyle: choice })}
                className={cn(
                  'flex flex-1 items-center justify-center gap-1.5 rounded-chrome border px-3 py-2 text-sm',
                  preferences.mapStyle === choice
                    ? 'border-water bg-water-soft text-ink'
                    : 'border-input text-ink-soft hover:text-ink',
                )}
              >
                {choice === 'auto' ? <MonitorSmartphone className="size-4" aria-hidden /> : null}
                {choice === 'light' ? <Sun className="size-4" aria-hidden /> : null}
                {choice === 'dark' ? <Moon className="size-4" aria-hidden /> : null}
                {MAP_STYLE_LABEL[choice]}
              </button>
            ))}
          </div>
          <p className="text-data text-ink-faint">
            Satellite is not offered: every imagery layer that is free to use forbids a product like
            this one, and the ones that allow it are not free.
          </p>
        </div>

        <div className="flex items-center justify-between gap-3 border-t border-edge pt-3">
          <div>
            <p className="text-sm">Show me around again</p>
            <p className="text-data text-ink-faint">
              {preferences.tourCompletedAt
                ? `You last finished the walkthrough ${formatRelative(preferences.tourCompletedAt)}.`
                : 'You have not been through the walkthrough yet.'}
            </p>
          </div>
          <Button variant="outline" size="sm" asChild>
            <Link to="/" onClick={() => window.setTimeout(runTour, 900)}>
              Start it
            </Link>
          </Button>
        </div>

        {!isPersisted ? (
          <p className="text-data text-ink-faint">
            These are kept on this device until you sign in.
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}

function OfficesCard() {
  const { offices, isLoading } = useOffices();
  const setDefault = useSetDefaultOffice();
  const remove = useDeleteOffice();

  return (
    <Card>
      <CardHeader>
        <CardTitle>Saved offices</CardTitle>
        <CardDescription>
          The default is where the map opens. Save one from the search — the star beside the office
          field.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="flex flex-col gap-2">
            {[0, 1].map((row) => (
              <div key={row} className="h-14 animate-pulse rounded-chrome bg-paper-sunken" />
            ))}
          </div>
        ) : offices.length === 0 ? (
          <EmptyState
            illustration="rings"
            title="No offices saved yet."
            detail="Set one on the map and save it, and it is where you start next time."
            action={
              <Button asChild size="sm">
                <Link to="/">Open the map</Link>
              </Button>
            }
          />
        ) : (
          <ul className="flex flex-col gap-2">
            {offices.map((office) => (
              <li
                key={office.id}
                className="flex items-center gap-3 rounded-chrome border border-edge px-3 py-2"
              >
                <Building2 className="size-4 shrink-0 text-ink-faint" aria-hidden />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{office.label}</p>
                  <p className="truncate text-data text-ink-faint">{office.address}</p>
                </div>

                {office.isDefault ? (
                  <span className="inline-flex items-center gap-1 rounded-round bg-signal/20 px-2 py-0.5 text-label text-signal-ink">
                    <Star className="size-3" aria-hidden />
                    Default
                  </span>
                ) : (
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={setDefault.isPending}
                    onClick={() =>
                      setDefault.mutate(office.id, {
                        onSuccess: () => toast.success(`${office.label} is where the map opens`),
                        onError: () => toast.error('That could not be made the default'),
                      })
                    }
                  >
                    Make default
                  </Button>
                )}

                <Button
                  variant="ghost"
                  size="icon"
                  disabled={remove.isPending}
                  onClick={() =>
                    remove.mutate(office.id, {
                      onSuccess: () => toast.success(`${office.label} removed`),
                      onError: () => toast.error('That office could not be removed'),
                    })
                  }
                >
                  <Trash2 className="size-4" aria-hidden />
                  <span className="sr-only">Remove {office.label}</span>
                </Button>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

function DangerCard() {
  const navigate = useNavigate();
  const remove = useDeleteAccount();

  const confirm = (): void => {
    remove.mutate(undefined, {
      onSuccess: async () => {
        await auth.signOut();
        toast.success('Your account is closed.');
        void navigate('/');
      },
      onError: (error) =>
        toast.error(error instanceof Error ? error.message : 'That could not be done'),
    });
  };

  return (
    <Card className="border-clay/40">
      <CardHeader>
        <CardTitle>Close this account</CardTitle>
        <CardDescription>
          Your name, email, phone and saved places are erased and you are signed out. Listings you
          published come down. Enquiry threads stay, because the person you were talking to is part
          of them too — your side will show as a closed account.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button variant="destructive" disabled={remove.isPending}>
              {remove.isPending ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
              Close my account
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Close this account?</AlertDialogTitle>
              <AlertDialogDescription>
                This cannot be undone. You would need to sign up again from scratch, and the
                offices, favourites and saved searches on this account are not recoverable.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Keep it</AlertDialogCancel>
              <AlertDialogAction onClick={confirm}>Close my account</AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </CardContent>
    </Card>
  );
}
