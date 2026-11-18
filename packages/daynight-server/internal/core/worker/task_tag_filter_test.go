package worker

import (
	"context"
	"encoding/json"
	"reflect"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	workerprotocol "github.com/codetreker/daynight/packages/daynight-server/internal/protocol/worker"
)

func TestParseTaskTagFilterStrict(t *testing.T) {
	for _, raw := range []string{`null`, `{}`, `{"names":null,"match":"any"}`, `{"names":[null],"match":"any"}`, `{"names":[],"match":"bad"}`, `{"names":[" "],"match":"any"}`, `{"names":[],"match":"any","future":1}`, `{"names":[],"names":[],"match":"any"}`} {
		if _, err := ParseTaskTagFilter(json.RawMessage(raw)); err == nil {
			t.Errorf("accepted %s", raw)
		}
	}
	got, err := ParseTaskTagFilter(json.RawMessage(`{"names":[" Backend ","backend","Urgent"],"match":"all"}`))
	if err != nil || !reflect.DeepEqual(got, model.TagNameFilter{Names: []string{"Backend", "Urgent"}, Match: "all"}) {
		t.Fatalf("normalization = %+v, %v", got, err)
	}
	got, err = ParseTaskTagFilter(json.RawMessage(`{"names":[],"match":"all"}`))
	if err != nil || !reflect.DeepEqual(got, model.TagNameFilter{Names: []string{}, Match: "any"}) {
		t.Fatalf("empty = %+v, %v", got, err)
	}
}

func TestTaskTagFilterPutAdmissionAndPreservation(t *testing.T) {
	ctx := context.Background()
	principal := model.Principal{UserID: "user"}
	filter := func(names ...string) *model.TagNameFilter {
		return &model.TagNameFilter{Names: append([]string{}, names...), Match: "any"}
	}
	for _, tc := range []struct {
		name            string
		previous, next  *model.TagNameFilter
		omit, supported bool
		fault           string
		writes          int
	}{
		{name: "enable without support", previous: filter(), next: filter("backend"), fault: "worker_task_tag_filter_unsupported"},
		{name: "enable with support", previous: filter(), next: filter("backend"), supported: true, writes: 1},
		{name: "change without support", previous: filter("backend"), next: filter("urgent"), fault: "worker_task_tag_filter_unsupported"},
		{name: "clear without support", previous: filter("backend"), next: filter(), writes: 1},
		{name: "same semantics without support", previous: filter("Backend"), next: filter("backend")},
		{name: "old omission without support", previous: filter("Backend"), omit: true, writes: 1},
	} {
		t.Run(tc.name, func(t *testing.T) {
			old := configurationFixture()
			old.TaskTagFilter = tc.previous
			raw, err := json.Marshal(old)
			if err != nil {
				t.Fatal(err)
			}
			d := configuredDAO("7")
			d.current.Desired.Raw = raw
			d.current.Desired.ArchiveSessions = old.ArchiveSessions
			if tc.supported {
				d.current.Observation = &model.WorkerConfigurationReportedObservation{WorkerConfigurationObservation: model.WorkerConfigurationObservation{Items: []model.WorkerConfigurationItem{{Key: model.WorkerConfigurationItemKey{Kind: "taskTagFilter"}}}}}
			}
			next := configurationFixture()
			next.TaskTagFilter = tc.next
			if tc.omit {
				next.PreserveTaskTagFilter = true
				next.MaxConcurrent = 2
			}
			got, err := PutConfiguration(ctx, d, principal, "worker", 7, next)
			if tc.fault != "" {
				requireFault(t, err, tc.fault)
			} else if err != nil {
				t.Fatal(err)
			}
			if d.desiredWrites != tc.writes {
				t.Fatalf("writes=%d want %d", d.desiredWrites, tc.writes)
			}
			if tc.omit {
				var saved map[string]json.RawMessage
				if err := json.Unmarshal(d.rawWritten, &saved); err != nil {
					t.Fatal(err)
				}
				retained, err := ParseTaskTagFilter(saved["taskTagFilter"])
				if err != nil || !reflect.DeepEqual(retained, *tc.previous) {
					t.Fatalf("retained=%+v err=%v", retained, err)
				}
			}
			if tc.name == "same semantics without support" && got.Desired.Revision != "7" {
				t.Fatalf("semantic no-op changed revision: %+v", got.Desired)
			}
		})
	}
}

func TestTaskTagFilterRawBudget(t *testing.T) {
	const empty = `{"names":[],"match":"any"}`
	for _, tc := range []struct {
		raw    string
		exempt bool
	}{{empty, true}, {`{"names":[],"match":"all"}`, false}, {`{"names":["x"],"match":"any"}`, false}, {`null`, false}} {
		fields := map[string]json.RawMessage{"taskTagFilter": json.RawMessage(tc.raw), "other": json.RawMessage(`true`)}
		raw, err := json.Marshal(fields)
		if err != nil {
			t.Fatal(err)
		}
		got := int64(len(raw)) - configurationRawSize(fields, raw)
		if tc.exempt && got != workerprotocol.EmptyTaskTagFilterMemberBytes || !tc.exempt && got != 0 {
			t.Errorf("%s exempt bytes=%d", tc.raw, got)
		}
	}
}

func TestTaskTagFilterObservationDigest(t *testing.T) {
	template := `{"bootstrap":null,"observation":{"baseRevision":"0","desiredRevision":"1","items":[{"key":{"kind":"taskTagFilter"},"targetRevision":"1","appliedValue":VALUE,"state":"applied","error":null,"lastFailure":null,"nextAttemptAt":null}]}}`
	for _, tc := range []struct {
		value string
		valid bool
	}{{`"` + strings.Repeat("a", 64) + `"`, true}, {`"` + strings.Repeat("A", 64) + `"`, false}, {`"abc"`, false}, {`12`, false}, {`null`, false}} {
		_, err := ParseWorkerConfigurationExchange(json.RawMessage(strings.Replace(template, "VALUE", tc.value, 1)))
		if (err == nil) != tc.valid {
			t.Errorf("value %s err=%v", tc.value, err)
		}
	}
}

func TestBootstrapRejectsExplicitTaskTagFilter(t *testing.T) {
	base := configurationFixture()
	for _, filter := range []*model.TagNameFilter{{Names: []string{}, Match: "any"}, {Names: []string{"backend"}, Match: "any"}} {
		value := base
		value.TaskTagFilter = filter
		raw, err := json.Marshal(model.WorkerConfigurationExchange{Bootstrap: &value})
		if err != nil {
			t.Fatal(err)
		}
		if _, err := ParseWorkerConfigurationExchange(raw); err == nil {
			t.Fatal("bootstrap parser accepted explicit task tag filter")
		}
		dao := configuredDAO("1")
		if _, err := ExchangeConfiguration(context.Background(), dao, model.Principal{UserID: "user"}, "worker", model.WorkerConfigurationExchange{Bootstrap: &value}); err == nil || len(dao.scopes) != 0 {
			t.Fatalf("bootstrap core ignored filter: %v", err)
		}
	}
}
