import type { ListingPatchInput, OutOfCoverage } from '@machiya/shared';
import { ArrowLeft, ArrowRight, Loader2 } from 'lucide-react';
import { useCallback, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router';
import { toast } from 'sonner';
import { AmenitiesStep } from '../../components/wizard/AmenitiesStep';
import { AvailabilityStep } from '../../components/wizard/AvailabilityStep';
import { BasicsStep } from '../../components/wizard/BasicsStep';
import { LocationStep } from '../../components/wizard/LocationStep';
import { PhotosStep } from '../../components/wizard/PhotosStep';
import { PricingStep } from '../../components/wizard/PricingStep';
import { ReviewStep } from '../../components/wizard/ReviewStep';
import { WizardShell } from '../../components/wizard/WizardShell';
import {
  WIZARD_STEP_IDS,
  isWizardStep,
  stepComplete,
  stepIndex,
  type WizardStepId,
} from '../../components/wizard/steps';
import { Button } from '../../components/ui/button';
import {
  useListingDraft,
  useOpenDraft,
  usePublishDraft,
  type DraftStart,
} from '../../hooks/use-listing-draft';
import { ApiRequestError } from '../../lib/api';

/**
 * The listing wizard.
 *
 * The step lives in the URL and the draft id in the path, so a reload, a back
 * button and a link into step four all behave. Everything else lives on the
 * server: see `useListingDraft`, and D67 for why the row can be half-empty.
 *
 * There is no role gate on reaching this page. A seeker may draft a listing and
 * is upgraded to lister by the act of publishing one — the transition happens
 * in `changeStatus`, inside the same transaction as the publish, so the two can
 * never disagree.
 */
export function WizardPage() {
  const { id } = useParams<{ id?: string }>();
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();

  const stepParam = params.get('step') ?? undefined;
  const step: WizardStepId = isWizardStep(stepParam) ? stepParam : 'location';

  const { draft, isLoading, save, saveState, saveAsync } = useListingDraft(id);
  const openDraft = useOpenDraft();
  const publish = usePublishDraft(id);

  const [direction, setDirection] = useState(1);
  const [coverageRefusal, setCoverageRefusal] = useState<OutOfCoverage | null>(null);
  const [publishError, setPublishError] = useState<string | null>(null);

  const goTo = useCallback(
    (next: WizardStepId, listingId = id) => {
      setDirection(stepIndex(next) >= stepIndex(step) ? 1 : -1);
      if (listingId && listingId !== id) {
        navigate(`/lister/listings/${listingId}/edit?step=${next}`, { replace: true });
        return;
      }
      setParams({ step: next }, { replace: true });
    },
    [id, navigate, setParams, step],
  );

  const handleOpenDraft = useCallback(
    async (start: DraftStart) => {
      try {
        const created = await openDraft.mutateAsync(start);
        navigate(`/lister/listings/${created.id}/edit?step=location`, { replace: true });
      } catch (error) {
        if (error instanceof ApiRequestError && error.coverage) {
          // The 422 carries the served cities, so the step renders them as
          // buttons rather than parsing them out of the sentence (D53).
          setCoverageRefusal(error.coverage);
          return;
        }
        toast.error(error instanceof Error ? error.message : 'Could not start that listing');
      }
    },
    [navigate, openDraft],
  );

  const handlePatch = useCallback(
    (patch: ListingPatchInput) => {
      setCoverageRefusal(null);
      save(patch);
    },
    [save],
  );

  /**
   * Advance, saving first.
   *
   * `saveAsync` rather than the fire-and-forget `save`, because a step that
   * advanced through a failed write would show the next screen while quietly
   * losing the last one — and the promise the wizard makes is that nothing is
   * lost.
   */
  const advance = async (delta: number) => {
    const next = WIZARD_STEP_IDS[stepIndex(step) + delta];
    if (!next) return;

    try {
      if (id) await saveAsync({});
      goTo(next);
    } catch (error) {
      if (error instanceof ApiRequestError && error.coverage) {
        setCoverageRefusal(error.coverage);
        return;
      }
      toast.error('Could not save that step — nothing was lost, try again');
    }
  };

  const handlePublish = () => {
    setPublishError(null);
    publish.mutate(undefined, {
      onSuccess: (result) => {
        toast.success(
          result.roleUpgraded
            ? 'Published. You are a lister now — your dashboard is under your name.'
            : 'Published.',
        );
        navigate(`/listings/${result.slug}`);
      },
      onError: (error) => {
        const message =
          error instanceof ApiRequestError ? error.message : 'Could not publish that listing';
        setPublishError(message);
        toast.error(message);
      },
    });
  };

  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center" role="status">
        <Loader2 className="size-5 animate-spin text-ink-faint" aria-hidden />
        <span className="sr-only">Loading your draft…</span>
      </div>
    );
  }

  const canGoBack = stepIndex(step) > 0;
  const canGoForward = stepIndex(step) < WIZARD_STEP_IDS.length - 1;

  return (
    <WizardShell
      step={step}
      direction={direction}
      saveState={saveState}
      completed={(candidate) => stepComplete(candidate, draft)}
      onJump={(next) => {
        // Jumping ahead before a draft exists has nothing to write into.
        if (!draft) return;
        goTo(next);
      }}
      footer={
        <>
          <Button
            variant="ghost"
            disabled={!canGoBack}
            onClick={() => {
              void advance(-1);
            }}
          >
            <ArrowLeft className="size-4" aria-hidden />
            Back
          </Button>

          {canGoForward ? (
            <Button
              disabled={!draft || openDraft.isPending}
              onClick={() => {
                void advance(1);
              }}
            >
              Next
              <ArrowRight className="size-4" aria-hidden />
            </Button>
          ) : null}
        </>
      }
    >
      {step === 'location' ? (
        <LocationStep
          draft={draft}
          onOpenDraft={handleOpenDraft}
          onPatch={handlePatch}
          coverageRefusal={coverageRefusal}
          onClearRefusal={() => {
            setCoverageRefusal(null);
          }}
          busy={openDraft.isPending}
        />
      ) : !draft ? (
        // Every step past the first needs a row to write into, and the only way
        // to get one is to place a pin.
        <NeedsAPin
          onBack={() => {
            goTo('location');
          }}
        />
      ) : step === 'basics' ? (
        <BasicsStep draft={draft} onPatch={handlePatch} />
      ) : step === 'pricing' ? (
        <PricingStep draft={draft} onPatch={handlePatch} />
      ) : step === 'amenities' ? (
        <AmenitiesStep draft={draft} onPatch={handlePatch} />
      ) : step === 'photos' ? (
        <PhotosStep draft={draft} />
      ) : step === 'availability' ? (
        <AvailabilityStep draft={draft} onPatch={handlePatch} />
      ) : (
        <ReviewStep
          draft={draft}
          onJump={goTo}
          onPublish={handlePublish}
          isPublishing={publish.isPending}
          publishError={publishError}
        />
      )}
    </WizardShell>
  );
}

function NeedsAPin({ onBack }: { onBack: () => void }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
      <p className="text-title max-w-[32ch] text-balance">
        Place the pin first — everything else hangs off where the property is.
      </p>
      <p className="max-w-[42ch] text-sm text-ink-soft">
        The city, the search radius it appears in and the commute every seeker sees are all computed
        from that one point.
      </p>
      <Button onClick={onBack}>Back to the map</Button>
    </div>
  );
}
