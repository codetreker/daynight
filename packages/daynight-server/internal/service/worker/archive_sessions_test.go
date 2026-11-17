package worker

import (
	"context"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/testdata/testsupport"
	"github.com/google/uuid"
)

func TestReportBootstrapPreservesArchiveSessions(t *testing.T) {
	_, database, _, principal := testsupport.ProjectService(t)
	workers := NewWorkersWithPrompts(database, database)
	ctx := context.Background()
	for _, tc := range []struct {
		name   string
		choice *bool
		want   bool
		sync   bool
	}{
		{"legacy default", nil, true, false},
		{"report false", pointer(false), false, false},
		{"report true", pointer(true), true, false},
		{"sync false", pointer(false), false, true},
		{"sync true", pointer(true), true, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			id := uuid.NewString()
			value := cloudWorkerConfiguration("")
			value.ArchiveSessions = tc.choice
			report := serviceWorkerReport()
			report.Configuration = &model.WorkerConfigurationExchange{Bootstrap: &value}
			var result WorkerReportResult
			var err error
			if tc.sync {
				var sync ConfigurationSyncResult
				sync, err = workers.ReportSync(ctx, principal, id, report, nil)
				result = sync.Native
			} else {
				result, err = workers.Report(ctx, principal, id, report)
			}
			if err != nil || result.Configuration == nil || result.Configuration.Desired == nil || result.Configuration.Desired.Revision != "1" || result.Configuration.Desired.Value.ArchiveSessions == nil || *result.Configuration.Desired.Value.ArchiveSessions != tc.want {
				t.Fatalf("bootstrap receipt: %+v %v", result, err)
			}
			stored, err := workers.Configuration(ctx, principal, id)
			if err != nil || stored.Desired == nil || stored.Desired.Value.ArchiveSessions == nil || *stored.Desired.Value.ArchiveSessions != tc.want {
				t.Fatalf("persisted: %+v %v", stored, err)
			}
			opposite := !tc.want
			value.ArchiveSessions = &opposite
			later, err := workers.Report(ctx, principal, id, report)
			if err != nil || later.Configuration.Desired.Revision != "1" || *later.Configuration.Desired.Value.ArchiveSessions != tc.want {
				t.Fatalf("late bootstrap changed cloud target: %+v %v", later, err)
			}
		})
	}
}
