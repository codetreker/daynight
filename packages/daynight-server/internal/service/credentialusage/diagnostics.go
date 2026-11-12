package credentialusage

import (
	"context"
	"log/slog"
	"time"

	usage "github.com/codetreker/daynight/packages/daynight-server/internal/core/credentialusage"
)

// runDiagnostics snapshots outside the logger and acknowledges only after all
// fixed phase/code counters have been emitted. Each pass visits all keys before
// beginning another, so a hot key cannot monopolize the consumer.
func (r *Recorder) runDiagnostics() {
	defer close(r.diagnosticDone)
	ticker := time.NewTicker(checkInterval)
	defer ticker.Stop()
	for {
		workerExited := false
		select {
		case <-r.workerDone:
			workerExited = true
		default:
		}
		faults := r.sampler.Faults()
		if workerExited && len(faults) == 0 {
			return
		}
		failed := false
		for _, fault := range faults {
			if err := r.logSummary(fault); err != nil {
				failed = true
				continue
			}
			r.sampler.AcknowledgeFault(fault.Latest.Observation.Key(), fault.Revision)
		}
		if len(faults) != 0 && !failed {
			continue
		}
		select {
		case <-r.diagnosticWake:
		case <-ticker.C:
		}
	}
}

func (r *Recorder) logSummary(summary usage.FaultSummary) error {
	ctx := context.Background()
	for phase := usage.PhaseSubmit; phase <= usage.PhaseShutdown; phase++ {
		for code := usage.CodeQueueFull; code <= usage.CodeShutdownIncomplete; code++ {
			count := summary.Counts[phase][code]
			if count == 0 {
				continue
			}
			first, latest := summary.First, summary.Latest
			event := latest.Observation.Event
			var representative *usage.Fault
			if latest.Phase == phase && latest.Code == code {
				representative = &latest
			} else if first.Phase == phase && first.Code == code {
				representative = &first
			}
			record := slog.NewRecord(r.clock(), slog.LevelError, "credential usage recording fault", 0)
			record.AddAttrs(
				slog.String("component", "credential_usage"),
				slog.String("phase", phase.String()), slog.String("error_code", code.String()),
				slog.Uint64("count", count),
				slog.String("kind", string(event.Kind)), slog.String("user_id", event.UserID),
				slog.String("subject_id", event.SubjectID),
				slog.Group("first", slog.String("phase", first.Phase.String()), slog.String("error_code", first.Code.String()), slog.String("origin_request_id", first.Observation.RequestID), slog.String("source", first.Observation.Source.String()), slog.Time("event_at", first.Observation.Event.At), slog.Time("occurred_at", first.OccurredAt)),
				slog.Group("latest", slog.String("phase", latest.Phase.String()), slog.String("error_code", latest.Code.String()), slog.String("origin_request_id", latest.Observation.RequestID), slog.String("source", latest.Observation.Source.String()), slog.Time("event_at", latest.Observation.Event.At), slog.Time("occurred_at", latest.OccurredAt)),
			)
			if representative != nil {
				f := representative
				record.AddAttrs(slog.String("cause", f.Cause.String()), slog.String("origin_request_id", f.Observation.RequestID), slog.String("source", f.Observation.Source.String()), slog.Time("occurred_at", f.OccurredAt), slog.Int64("pending_age_ms", f.PendingAge.Milliseconds()), slog.Int("depth", f.Depth), slog.String("sqlstate", f.SQLState))
			} else {
				record.AddAttrs(slog.String("cause", usage.CauseUnknown.String()))
			}
			if err := r.logger.Handler().Handle(ctx, record); err != nil {
				return err
			}
		}
	}
	return nil
}
