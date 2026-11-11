package worker

import (
	"context"
	"errors"
	"reflect"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

func TestWorkerToolPathsServiceValidatesTargetsInsideWrite(t *testing.T) {
	for _, refuse := range []bool{false, true} {
		t.Run(map[bool]string{false: "success", true: "target refusal"}[refuse], func(t *testing.T) {
			f := newAdmissionServiceFixture(t)
			report := &model.ToolPathTelemetry{SchemaVersion: 1, ObservedAt: f.observed, Entries: []model.ToolPathObservation{}}
			f.input.Telemetry.ToolPaths = report
			f.normalized.Telemetry.ToolPaths = report
			f.want = append(f.want[:len(f.want)-2], "targets", "clock", "completion")
			failure := errors.New("target unavailable")
			f.service.report.validateToolPathTargets = func(ctx context.Context, dao store.WorkerWriteDAO, p model.Principal, id string, value *model.ToolPathTelemetry) error {
				f.take("targets")
				f.checkContext(ctx)
				if dao != f || p != f.principal || id != f.worker || value != report {
					t.Fatal("target validation lost transaction or normalized facts")
				}
				if refuse {
					return failure
				}
				return nil
			}
			if refuse {
				f.want = append(f.want[:len(f.want)-2], "completion")
				f.completion.Outcome = store.TransactionNotCommitted
			}
			result, err := f.service.Report(f.ctx, f.principal, f.worker, f.input)
			if refuse {
				if !errors.Is(err, failure) || !reflect.DeepEqual(result, WorkerReportResult{}) {
					t.Fatalf("refusal was published: %+v %v", result, err)
				}
			} else if err != nil || result.LastReportedAt != f.stored.LastReportedAt {
				t.Fatalf("report failed: %+v %v", result, err)
			}
		})
	}
}
