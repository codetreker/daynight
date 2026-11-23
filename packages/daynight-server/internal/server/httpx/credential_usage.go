package httpx

import (
	"context"
	"errors"
	"log/slog"
	"time"

	usage "github.com/codetreker/daynight/packages/daynight-server/internal/core/credentialusage"
)

var ErrCredentialUsageObservation = errors.New("credential usage publication requires a request collector and logger")

// PublishCredentialUsageFaults publishes a copied request-local revision before
// protocol handling can become long-lived. Healthy requests produce no record.
// A handler error leaves the revision pending for the request completion fallback;
// a fault recorded during publication is not cleared by the older acknowledgement.
// Callers preserve the authentication or rotation result when publication fails.
func PublishCredentialUsageFaults(logger *slog.Logger, ctx context.Context) error {
	if logger == nil || ctx == nil {
		return ErrCredentialUsageObservation
	}
	collector := usage.CollectorFrom(ctx)
	if collector == nil {
		return ErrCredentialUsageObservation
	}
	summary, pending := collector.Snapshot()
	if !pending {
		return nil
	}
	f := summary.Latest
	event := f.Observation.Event
	counts := make([]any, 0, 4)
	for phase := usage.PhaseSubmit; phase <= usage.PhaseShutdown; phase++ {
		for code := usage.CodeQueueFull; code <= usage.CodeShutdownIncomplete; code++ {
			if count := summary.Counts[phase][code]; count != 0 {
				counts = append(counts, slog.Group(phase.String()+"/"+code.String(), slog.Uint64("count", count)))
			}
		}
	}
	record := slog.NewRecord(time.Now(), slog.LevelError, "credential usage recording fault", 0)
	record.AddAttrs(slog.String("type", "request_error"), slog.String("component", "server"),
		slog.String("phase", "credential_usage"), slog.String("request_id", RequestID(ctx)),
		slog.Group("credential_usage",
			slog.String("component", "credential_usage"), slog.String("phase", f.Phase.String()),
			slog.String("error_code", f.Code.String()), slog.String("cause", f.Cause.String()),
			slog.String("kind", string(event.Kind)), slog.String("user_id", event.UserID), slog.String("subject_id", event.SubjectID),
			slog.String("origin_request_id", f.Observation.RequestID), slog.String("source", f.Observation.Source.String()),
			slog.Time("event_at", event.At), slog.Time("occurred_at", f.OccurredAt),
			slog.Int64("pending_age_ms", f.PendingAge.Milliseconds()), slog.Int("depth", f.Depth), slog.String("sqlstate", f.SQLState),
			slog.Uint64("revision", summary.Revision), slog.Group("counts", counts...),
			slog.Group("first", slog.String("origin_request_id", summary.First.Observation.RequestID),
				slog.Time("event_at", summary.First.Observation.Event.At), slog.Time("occurred_at", summary.First.OccurredAt))))
	// Like the background consumer, use Handle's result rather than slog's
	// fire-and-forget methods: a failed sink cannot confirm this revision.
	if err := logger.Handler().Handle(ctx, record); err != nil {
		return err
	}
	collector.Acknowledge(summary.Revision)
	return nil
}
