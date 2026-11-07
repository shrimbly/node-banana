# Polled generations and picking them up again

Kie and Comfy Router runs are long. `/api/generate` submits the request and
answers at once with a polling envelope (`polling: true`, `taskId`,
`pollProvider`, `pollModelId`, `pollModelName`, `pollMediaType`). The browser
then polls `/api/generate/poll` until the provider answers
(`pollGenerateTask` in `src/store/execution/pollTaskCompletion.ts`). The
provider goes on with the run whatever the app does, so the node keeps the
request and the run can be collected later.

## How long the app waits

The poller waits for as long as the provider says the run is going. The
interval ramps from 3 s to 8 s and follows the Router's `Retry-After` (at
most 60 s).

A safety net (`POLL_SAFETY_NET_MS`, 90 minutes) stops a poller that would
otherwise never end. No wait reaches past it. The poll made there is a last
look: a run that finished or failed meanwhile reports its real outcome. If
the provider still says the run is going, the poller throws
`GenerationStillRunningError` with the request id, and the node says:

> Seedance 2.5: still running on Comfy Router after 90 minutes (request
> 3544457f-…). The node keeps the request; pick it up again from the node.

The poller also stops waiting, with the request kept, after ten failed checks
in a row, and when the poll is refused for the key (401, 402, 403). These say
nothing about the run itself.

## What the poll route answers

| Status | Meaning | The client |
|--------|---------|------------|
| 200, `polling: true` | Still running | Polls again |
| 200, media | Done | Finishes the run |
| 422 | The provider failed the run; `error` is its reason | Shows the reason, lets the request go |
| 401, 402, 403 | The check was refused (no key, a rejected key, no credits) | Stops waiting, keeps the request |
| 408, 429, 5xx | No answer this time | Polls again |
| Other 4xx | The request cannot be answered (expired, unknown) | Shows the error, lets the request go |

For Comfy Router, a status of `COMPLETED` with an `error_type` names only the
code. The explanation, in the partner's own words, is the 4xx that the
request's result URL answers with (`detail`, `error_type`). The status check
reads it there (`failureReason` in `src/app/api/generate/providers/comfy.ts`).

## Where the request is kept

`pendingTask` on the node data of `nanoBanana`, `generateVideo`,
`generateAudio` and `generate3d` nodes (`PendingGenerationTask` in
`src/types/nodes.ts`):

```ts
{ provider, taskId, modelId, modelName, mediaType, submittedAt }
```

`waitForPendingTask` (`src/store/execution/pendingTask.ts`) owns it:

- **Set** as soon as the polling envelope arrives.
- **Cleared** when the provider answers (the media, or its reason for failing
  the run), and when the user presses Stop.
- **Kept** when the poller stops waiting without an answer, and when the run
  is cut off another way (another node's failure, the local server going
  away), since the provider carries on.
- **Replaced** when the node runs again: a new run lets go of an older request.

It is node data, so it is saved with the workflow and held in the desktop
app's crash checkpoint (which turns a node that was loading into an error,
keeping the request). Autosave never writes during a run, so a browser
reload in the middle of a run, before the workflow is saved again, loses it
like any other unsaved edit; the page warns before it reloads.

A run that is still going is not a failure to fall back from:
`runWithFallback` does not start the fallback model, which would be a second
paid run beside the first.

## Picking it up

When `pendingTask` is set and the node is not loading, the card shows
`PendingTaskNotice` (`src/components/nodes/ui/`) instead of the failure:
where the request runs, when it was sent, the request id (selectable, with a
copy button) and **Pick up**.

**Pick up** calls the store's `resumeGeneration(nodeId)`. It is a single
node's own run, like the node's Run button: beside other node runs, never
inside a workflow run or a batch. It polls the request with the headers the
run would have sent and finishes it through the executor's own success path
(`finishNanoBanana`, `finishGenerateVideo`, `finishGenerateAudio`,
`finishGenerate3D`), so the output reaches the carousel, the asset library,
downstream galleries and the generations folder as a normal run's would.

The run's request payload is gone by then. The output is recorded with what
the node holds: the model that sent the request (the node's model or its
fallback, whichever matches) with that model's settings, and the prompt the
run started with.

The provider failing the run clears the request and shows its reason. Hitting
the safety net again keeps it. Stop lets it go.

## How long a result lasts

Comfy Router keeps a request's output for 24 hours. After that the poll
answers that the result expired, and Pick up clears the request.
