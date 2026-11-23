package credentialusage

import (
	"context"

	usage "github.com/codetreker/daynight/packages/daynight-server/internal/core/credentialusage"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/oauth"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/requestid"
)

// ObserveRotation records only a confirmed rotation. An unknown commit is a
// diagnostic, since the candidate alone cannot establish that it committed.
func (r *Recorder) ObserveRotation(ctx context.Context, observation oauth.RotationObservation) {
	ctx = WithSource(ctx, usage.SourceOAuthRefresh)
	switch observation.Outcome {
	case store.TransactionCommitted:
		_, _ = r.Record(ctx, observation.Event)
	case store.TransactionUnknown:
		if collector := usage.CollectorFrom(ctx); collector != nil {
			_ = collector.Record(usage.Fault{
				Phase: usage.PhaseRotation, Code: usage.CodeRotationOutcomeUnknown, Cause: usage.CauseUnknown,
				Observation: usage.Observation{Event: observation.Event, RequestID: requestid.From(ctx), Source: usage.SourceOAuthRefresh},
				OccurredAt:  r.clock(),
			})
		}
	}
}
