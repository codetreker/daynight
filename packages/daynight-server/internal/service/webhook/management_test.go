package webhook

import (
	"bytes"
	"context"
	"encoding/base64"
	"errors"
	"io"
	"math"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	wm "github.com/codetreker/daynight/packages/daynight-server/internal/core/webhook/model"
)

func TestManagementCreatesCompleteEndpointAndReceipt(t *testing.T) {
	f := newMgmtFixture(t)
	m := f.mutation("endpoint.create")
	m.EndpointID = ""
	m.IfVersion = 0
	m.Name = mgmtPtr("  Initial  ")
	m.Enabled = mgmtPtr(true)
	m.Destination = &Destination{Kind: "http", AdapterVersion: "1", URL: "https://receiver.example/Case?token=Secret"}
	m.HasSubscriptions = true
	expected := f.endpoint
	expected.ID = mgmtRandomID(0)
	expected.Name = "Initial"
	expected.CreatedAt = f.now
	expected.UpdatedAt = f.now
	expected.ActiveKeyID = mgmtRandomID(16)
	expected.DestinationConfiguration = []byte(`{"kind":"http","adapterVersion":"1","configuration":{"url":"https://receiver.example/Case?token=Secret"}}`)
	secret := make([]byte, 32)
	for i := range secret {
		secret[i] = byte(i + 32)
	}
	key := wm.SigningKey{EndpointID: expected.ID, ID: expected.ActiveKeyID, Slot: "current", Secret: secret, CreatedAt: f.now}
	f.recordWrites()
	op := f.respondMutation(m, expected, "applied", []wm.SigningKey{key})
	result, err := f.service.Mutate(f.ctx, f.principal, f.owner, m)
	if err != nil || result.Replay {
		t.Fatalf("create=%#v err=%v", result, err)
	}
	mgmtWantEqual(t, f.effects.endpoints, []wm.Endpoint{expected})
	mgmtWantEqual(t, f.effects.keys, []wm.SigningKey{key})
	mgmtWantEqual(t, f.effects.deletedKeys, []string{expected.ID})
	mgmtWantEqual(t, f.effects.operations, []wm.Operation{op})
	receipt := result.Body.(map[string]any)["operation"].(map[string]any)
	if value, present := receipt["overlapUntil"]; !present || value != (*time.Time)(nil) {
		t.Fatalf("create receipt has rotation deadline: %#v", receipt)
	}
	view := result.Body.(map[string]any)["endpoint"].(map[string]any)
	if view["id"] != expected.ID || view["configVersion"] != "1" || view["destination"].(map[string]any)["url"] != m.Destination.URL {
		t.Fatalf("view=%#v", view)
	}
	f.order("write.LockConfigurationSources", "write.LockCredential", "write.dao.PutEndpoint", "write.dao.PutOperation", "post.dao.Operation")
}

func TestManagementUpdatesOnlyChangedConfiguration(t *testing.T) {
	for _, kind := range []string{"name", "disabled", "destination", "unchanged"} {
		t.Run(kind, func(t *testing.T) {
			f := newMgmtFixture(t)
			m := f.mutation("endpoint.update")
			expected := f.endpoint
			effect := "applied"
			switch kind {
			case "name":
				m.Name = mgmtPtr(" Changed ")
				expected.Name = "Changed"
			case "disabled":
				m.Enabled = mgmtPtr(false)
				expected.Enabled = false
			case "destination":
				m.Destination = &Destination{Kind: "http", AdapterVersion: "1", URL: "https://other.example/New?token=next"}
				expected.DestinationRevision = 2
				expected.Origin = "https://other.example"
				expected.DestinationConfiguration = []byte(`{"kind":"http","adapterVersion":"1","configuration":{"url":"https://other.example/New?token=next"}}`)
			case "unchanged":
				m.Name = mgmtPtr(f.endpoint.Name)
				effect = "unchanged"
			}
			if effect == "applied" {
				expected.ConfigVersion = 2
				expected.UpdatedAt = f.now
			}
			f.service.Random = bytes.NewReader(nil)
			f.recordWrites()
			op := f.respondMutation(m, expected, effect, []wm.SigningKey{f.key})
			result, err := f.service.Mutate(f.ctx, f.principal, f.owner, m)
			if err != nil || result.Replay {
				t.Fatalf("update=%#v err=%v", result, err)
			}
			mgmtWantEqual(t, f.effects.operations, []wm.Operation{op})
			if effect == "applied" {
				mgmtWantEqual(t, f.effects.endpoints, []wm.Endpoint{expected})
				mgmtWantEqual(t, f.effects.keys, []wm.SigningKey{f.key})
				mgmtWantEqual(t, f.effects.deletedKeys, []string{f.endpoint.ID})
			} else if len(f.effects.endpoints)+len(f.effects.keys)+len(f.effects.deletedKeys) != 0 {
				t.Fatalf("no-op rewrote configuration=%#v", f.effects)
			}
		})
	}
}

func TestManagementDeletesDamagedConfigurationWithoutDecoding(t *testing.T) {
	f := newMgmtFixture(t)
	f.endpoint.DestinationConfiguration = []byte("damaged")
	m := f.mutation("endpoint.delete")
	expected := f.endpoint
	expected.Name = ""
	expected.Enabled = false
	expected.ConfigVersion = 2
	expected.DestinationKind = ""
	expected.AdapterVersion = ""
	expected.Origin = ""
	expected.DestinationConfiguration = nil
	expected.ActiveKeyID = ""
	expected.DeletedAt = mgmtPtr(f.now)
	expected.UpdatedAt = f.now
	f.recordWrites()
	op := f.respondMutation(m, expected, "applied", nil)
	result, err := f.service.Mutate(f.ctx, f.principal, f.owner, m)
	if err != nil {
		t.Fatal(err)
	}
	mgmtWantEqual(t, f.effects.endpoints, []wm.Endpoint{expected})
	mgmtWantEqual(t, f.effects.operations, []wm.Operation{op})
	if len(f.effects.keys) != 0 || result.Body.(map[string]any)["endpoint"].(map[string]any)["lifecycle"] != "deleted" {
		t.Fatalf("tombstone=%#v effects=%#v", result, f.effects)
	}
}

func TestManagementRotationPreservesOverlapAndReplayProjection(t *testing.T) {
	for _, mode := range []string{"overlap", "immediate"} {
		t.Run(mode, func(t *testing.T) {
			f := newMgmtFixture(t)
			m := f.mutation("signing.rotate")
			m.Mode = mode
			expected := f.endpoint
			expected.ActiveKeyID = mgmtRandomID(0)
			expected.ConfigVersion = 2
			expected.UpdatedAt = f.now
			secret := make([]byte, 32)
			for i := range secret {
				secret[i] = byte(i + 16)
			}
			key := wm.SigningKey{EndpointID: expected.ID, ID: expected.ActiveKeyID, Secret: secret, Slot: "current", CreatedAt: f.now}
			keys := []wm.SigningKey{key}
			if mode == "overlap" {
				old := f.key
				old.Slot = "overlap"
				old.OverlapStartedAt = mgmtPtr(f.now)
				old.OverlapUntil = mgmtPtr(f.now.Add(24 * time.Hour))
				keys = []wm.SigningKey{old, key}
			}
			f.recordWrites()
			op := f.respondMutation(m, expected, "applied", keys)
			result, err := f.service.Mutate(f.ctx, f.principal, f.owner, m)
			if err != nil {
				t.Fatal(err)
			}
			mgmtWantEqual(t, f.effects.keys, keys)
			mgmtWantEqual(t, f.effects.endpoints, []wm.Endpoint{expected})
			mgmtWantEqual(t, f.effects.operations, []wm.Operation{op})
			if result.Body.(map[string]any)["signing"].(map[string]any)["activeKeyId"] != key.ID {
				t.Fatalf("signing=%#v", result)
			}
			receipt := result.Body.(map[string]any)["operation"].(map[string]any)
			signing := result.Body.(map[string]any)["signing"].(map[string]any)
			if mode == "overlap" {
				until, present := receipt["overlapUntil"].(*time.Time)
				if !present || until == nil || !until.Equal(*signing["overlapUntil"].(*time.Time)) {
					t.Fatalf("rotation receipt lost original overlap: %#v", result)
				}
			} else if value, present := receipt["overlapUntil"]; !present || value != (*time.Time)(nil) {
				t.Fatalf("immediate rotation receipt has overlap: %#v", receipt)
			}
		})
	}
}

func TestManagementRejectsLiveSecondOverlap(t *testing.T) {
	f := newMgmtFixture(t)
	old := f.key
	old.ID = "77777777-7777-4777-8777-777777777777"
	old.Slot = "overlap"
	old.OverlapUntil = mgmtPtr(f.now.Add(time.Hour))
	f.writer.SigningKeysFn = func(context.Context, string) ([]wm.SigningKey, error) { return []wm.SigningKey{f.key, old}, nil }
	m := f.mutation("signing.rotate")
	m.Mode = "overlap"
	f.recordWrites()
	_, err := f.service.Mutate(f.ctx, f.principal, f.owner, m)
	mgmtWantFault(t, err, "operation_conflict")
	f.noEffects()
}

func TestManagementReplayReadsCurrentAuthorityAndConfiguration(t *testing.T) {
	for _, otherActor := range []bool{false, true} {
		t.Run(map[bool]string{false: "own receipt after demotion", true: "other receipt after demotion"}[otherActor], func(t *testing.T) {
			f := newMgmtFixture(t)
			f.team("shared", model.ProjectAdmin)
			m := f.mutation("endpoint.update")
			m.Name = mgmtPtr("new name")
			m.IssuedAt = f.now.Add(-time.Hour).Format(time.RFC3339Nano)
			old := f.endpoint
			old.Name = "new name"
			old.ConfigVersion = 2
			current := old
			current.ConfigVersion = 3
			current.DestinationConfiguration = []byte(`{"kind":"http","adapterVersion":"1","configuration":{"url":"https://receiver.example/current-private"}}`)
			op := f.respondMutation(m, old, "applied", []wm.SigningKey{f.key})
			op.RecordedAt = f.now.Add(-time.Hour)
			op.ExpiresAt = op.RecordedAt.Add(30 * 24 * time.Hour)
			f.postDAO.EndpointFn = func(_ context.Context, o wm.Owner, id string) (wm.Endpoint, error) {
				if o != current.Owner || id != current.ID {
					t.Errorf("current endpoint identity=%v %s", o, id)
				}
				return current, nil
			}
			if otherActor {
				op.ActorID = "88888888-8888-4888-8888-888888888888"
				op.Fingerprint = "different"
			}
			f.writer.OperationFn = func(context.Context, wm.Owner, string) (wm.Operation, error) { return op, nil }
			f.postDAO.OperationFn = func(context.Context, wm.Owner, string) (wm.Operation, error) { return op, nil }
			entered, release := make(chan struct{}), make(chan struct{})
			base := f.db.WriteFn
			f.db.WriteFn = func(ctx context.Context, o wm.Owner, id string, fn func(store.WebhookWriteScope) error) (store.Completion, error) {
				close(entered)
				select {
				case <-release:
					return base(ctx, o, id, fn)
				case <-ctx.Done():
					return store.Completion{Outcome: store.TransactionNotCommitted}, ctx.Err()
				}
			}
			result := make(chan struct {
				value Result
				err   error
			}, 1)
			ctx, cancel := context.WithTimeout(f.ctx, 3*time.Second)
			defer cancel()
			go func() {
				v, e := f.service.Mutate(ctx, f.principal, f.owner, m)
				result <- struct {
					value Result
					err   error
				}{v, e}
			}()
			select {
			case <-entered:
			case got := <-result:
				t.Fatalf("replay returned before fence: %v", got.err)
			case <-ctx.Done():
				t.Fatal(ctx.Err())
			}
			f.postTeam.TeamFn = func(_ context.Context, user, id string) (model.Team, error) {
				return model.Team{TeamRef: model.TeamRef{ID: id, Kind: "shared"}, Membership: model.TeamMember{UserID: user, Role: model.ProjectMemberRole}}, nil
			}
			close(release)
			select {
			case got := <-result:
				if otherActor {
					mgmtWantFault(t, got.err, "forbidden")
				} else {
					if got.err != nil || !got.value.Replay {
						t.Fatalf("replay=%#v %v", got.value, got.err)
					}
					body := got.value.Body.(map[string]any)
					endpoint := body["endpoint"].(map[string]any)
					receipt := body["operation"].(map[string]any)
					if endpoint["configVersion"] != "3" || receipt["configVersionAfter"] != "2" || receipt["requestSha256"] != op.RequestSHA256 || !receipt["recordedAt"].(time.Time).Equal(op.RecordedAt) {
						t.Fatalf("current projection or frozen receipt=%#v", body)
					}
					dest := endpoint["destination"].(map[string]any)
					if dest["url"] != nil || dest["displayUrl"] != "https://receiver.example/…" {
						t.Fatalf("demoted destination=%#v", dest)
					}
				}
			case <-ctx.Done():
				t.Fatal(ctx.Err())
			}
			f.noEffects()
		})
	}
}

func TestManagementReplayConflictAndDeletedTombstone(t *testing.T) {
	for _, kind := range []string{"different intent", "deleted endpoint", "expired operation replay", "disabled expansion replay", "rotation receipt"} {
		t.Run(kind, func(t *testing.T) {
			f := newMgmtFixture(t)
			m := f.mutation("endpoint.update")
			ep := f.endpoint
			op := f.respondMutation(m, ep, "unchanged", []wm.SigningKey{f.key})
			switch kind {
			case "different intent":
				op.Fingerprint = "different"
			case "deleted endpoint":
				ep.DeletedAt = mgmtPtr(f.now)
				f.postDAO.EndpointFn = func(context.Context, wm.Owner, string) (wm.Endpoint, error) { return ep, nil }
			case "expired operation replay":
				m.IssuedAt = f.now.Add(-24 * time.Hour).Format(time.RFC3339Nano)
				op.IssuedAt = m.IssuedAt
				fp, e := fingerprint(f.principal, f.owner, m)
				if e != nil {
					t.Fatal(e)
				}
				op.Fingerprint = fp
			case "disabled expansion replay":
				f.service.ConfigurationExpansionAvailable = false
			case "rotation receipt":
				m.Kind = "signing.rotate"
				m.Mode = "immediate"
				op = f.respondMutation(m, ep, "applied", []wm.SigningKey{f.key})
				op.ActiveKeyID = f.key.ID
			}
			f.writer.OperationFn = func(context.Context, wm.Owner, string) (wm.Operation, error) { return op, nil }
			f.postDAO.OperationFn = func(context.Context, wm.Owner, string) (wm.Operation, error) { return op, nil }
			got, err := f.service.Mutate(f.ctx, f.principal, f.owner, m)
			if kind == "different intent" {
				mgmtWantFault(t, err, "operation_conflict")
			} else if err != nil || !got.Replay {
				t.Fatalf("replay=%#v err=%v", got, err)
			}
			f.noEffects()
		})
	}
}

func TestManagementInvalidIntentHasNoEffect(t *testing.T) {
	cases := []struct {
		name, code string
		change     func(*mgmtFixture, *Mutation)
	}{
		{"operation ID", "invalid_input", func(_ *mgmtFixture, m *Mutation) { m.OperationID = "bad" }},
		{"actor UUID", "invalid_input", func(_ *mgmtFixture, m *Mutation) { m.ExpectedUserID = "bad" }},
		{"timestamp", "invalid_input", func(_ *mgmtFixture, m *Mutation) { m.IssuedAt = "invalid" }},
		{"actor mismatch", "identity_mismatch", func(_ *mgmtFixture, m *Mutation) { m.ExpectedUserID = "88888888-8888-4888-8888-888888888888" }},
		{"endpoint UUID", "invalid_input", func(_ *mgmtFixture, m *Mutation) { m.EndpointID = "bad" }},
		{"version", "invalid_input", func(_ *mgmtFixture, m *Mutation) { m.IfVersion = 0 }},
		{"name", "invalid_input", func(_ *mgmtFixture, m *Mutation) { m.Name = mgmtPtr(" ") }},
		{"kind", "destination_unsupported", func(_ *mgmtFixture, m *Mutation) {
			m.Destination = &Destination{Kind: "other", AdapterVersion: "1", URL: "https://example.test/"}
		}},
		{"HTTP URL", "invalid_input", func(_ *mgmtFixture, m *Mutation) {
			m.Destination = &Destination{Kind: "http", AdapterVersion: "1", URL: "http://example.test/"}
		}},
		{"future", "invalid_operation_time", func(f *mgmtFixture, m *Mutation) { m.IssuedAt = f.now.Add(2 * time.Minute).Format(time.RFC3339Nano) }},
		{"expired", "operation_expired", func(f *mgmtFixture, m *Mutation) { m.IssuedAt = f.now.Add(-time.Hour).Format(time.RFC3339Nano) }},
		{"missing endpoint", "not_found", func(f *mgmtFixture, m *Mutation) { m.EndpointID = "88888888-8888-4888-8888-888888888888" }},
		{"stale version", "version_conflict", func(_ *mgmtFixture, m *Mutation) { m.IfVersion = 2 }},
		{"unsupported operation", "invalid_input", func(_ *mgmtFixture, m *Mutation) { m.Kind = "other" }},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			f := newMgmtFixture(t)
			m := f.mutation("endpoint.update")
			c.change(f, &m)
			f.recordWrites()
			_, err := f.service.Mutate(f.ctx, f.principal, f.owner, m)
			mgmtWantFault(t, err, c.code)
			f.noEffects()
		})
	}
}

func TestManagementRejectsOwnersAndCredentials(t *testing.T) {
	for _, kind := range []string{"missing principal", "other personal owner", "unknown owner", "personal team", "team outsider", "team member", "revoked credential"} {
		t.Run(kind, func(t *testing.T) {
			f := newMgmtFixture(t)
			m := f.mutation("endpoint.update")
			p, o := f.principal, f.owner
			code := "forbidden"
			switch kind {
			case "missing principal":
				p = model.Principal{}
				m.ExpectedUserID = p.UserID
				_, err := f.service.Get(f.ctx, p, o, f.endpoint.ID)
				if err == nil {
					t.Fatal("invalid principal accepted")
				}
				return
			case "other personal owner":
				o.ID = "88888888-8888-4888-8888-888888888888"
			case "unknown owner":
				o.Kind = "unknown"
				code = "invalid_input"
			case "personal team":
				f.team("personal", model.ProjectAdmin)
				o = f.owner
			case "team outsider":
				f.team("shared", model.ProjectAdmin)
				o = f.owner
				f.preTeam.TeamFn = func(context.Context, string, string) (model.Team, error) { return model.Team{}, model.ErrNotFound }
			case "team member":
				f.team("shared", model.ProjectMemberRole)
				o = f.owner
			case "revoked credential":
				f.preCredential.CredentialFn = func(context.Context, model.Principal) (store.ThreadCredential, error) {
					return store.ThreadCredential{}, model.ErrNotFound
				}
				code = "unauthenticated"
			}
			f.recordWrites()
			_, err := f.service.Mutate(f.ctx, p, o, m)
			mgmtWantFault(t, err, code)
			f.noEffects()
		})
	}
}

func TestManagementRefusesCounterExhaustion(t *testing.T) {
	for _, kind := range []string{"configuration", "destination"} {
		t.Run(kind, func(t *testing.T) {
			f := newMgmtFixture(t)
			if kind == "configuration" {
				f.endpoint.ConfigVersion = math.MaxInt64
			} else {
				f.endpoint.DestinationRevision = math.MaxInt64
			}
			m := f.mutation("endpoint.update")
			if kind == "configuration" {
				m.Name = mgmtPtr("changed")
			} else {
				m.Destination = &Destination{Kind: "http", AdapterVersion: "1", URL: "https://receiver.example/new"}
			}
			f.recordWrites()
			_, err := f.service.Mutate(f.ctx, f.principal, f.owner, m)
			mgmtWantFault(t, err, "version_exhausted")
			f.noEffects()
		})
	}
}

func TestManagementRechecksAuthorityCredentialVersionAndTime(t *testing.T) {
	for _, kind := range []string{"credential after source", "demotion after source", "credential after endpoint", "credential with changed version", "concurrent version", "expired after endpoint", "credential after planning", "expired after planning", "demotion before expired"} {
		t.Run(kind, func(t *testing.T) {
			f := newMgmtFixture(t)
			m := f.mutation("endpoint.update")
			m.Name = mgmtPtr("changed")
			code := "unauthenticated"
			switch kind {
			case "credential after source":
				f.write.LockConfigurationSourcesFn = func(context.Context, wm.Owner, string, []string) error {
					f.writeCredential.CredentialFn = func(context.Context, model.Principal) (store.ThreadCredential, error) {
						return store.ThreadCredential{}, model.ErrNotFound
					}
					return model.ErrNotFound
				}
			case "demotion after source", "demotion before expired":
				f.team("shared", model.ProjectAdmin)
				f.write.LockConfigurationSourcesFn = func(context.Context, wm.Owner, string, []string) error {
					f.writeTeam.TeamFn = func(context.Context, string, string) (model.Team, error) {
						return model.Team{TeamRef: model.TeamRef{Kind: "shared"}, Membership: model.TeamMember{Role: model.ProjectMemberRole}}, nil
					}
					return nil
				}
				code = "forbidden"
				if kind == "demotion before expired" {
					m.IssuedAt = f.now.Add(-299 * time.Second).Format(time.RFC3339Nano)
					calls := 0
					f.write.ObservedAtFn = func(context.Context) (time.Time, error) {
						calls++
						if calls == 1 {
							return f.now, nil
						}
						return f.now.Add(2 * time.Second), nil
					}
				}
			case "credential after endpoint", "credential with changed version":
				f.writer.LockEndpointFn = func(context.Context, wm.Owner, string) (wm.Endpoint, error) {
					f.writeCredential.CredentialFn = func(context.Context, model.Principal) (store.ThreadCredential, error) {
						return store.ThreadCredential{}, model.ErrNotFound
					}
					ep := f.endpoint
					if kind == "credential with changed version" {
						ep.ConfigVersion++
					}
					return ep, nil
				}
			case "concurrent version":
				f.writer.LockEndpointFn = func(context.Context, wm.Owner, string) (wm.Endpoint, error) {
					ep := f.endpoint
					ep.ConfigVersion = 2
					return ep, nil
				}
				code = "version_conflict"
			case "expired after endpoint":
				n := 0
				f.write.ObservedAtFn = func(context.Context) (time.Time, error) {
					n++
					if n == 1 {
						return f.now, nil
					}
					return f.now.Add(301 * time.Second), nil
				}
				code = "operation_expired"
			case "credential after planning":
				f.write.LockCredentialFn = func(context.Context, model.Principal) (store.ThreadCredential, error) {
					return store.ThreadCredential{ExpiresAt: mgmtPtr(f.now)}, nil
				}
			case "expired after planning":
				n := 0
				f.write.ObservedAtFn = func(context.Context) (time.Time, error) {
					n++
					if n < 3 {
						return f.now, nil
					}
					return f.now.Add(301 * time.Second), nil
				}
				code = "operation_expired"
			}
			f.recordWrites()
			_, err := f.service.Mutate(f.ctx, f.principal, f.owner, m)
			mgmtWantFault(t, err, code)
			f.noEffects()
		})
	}
}

func TestManagementConfigurationExpansionPolicy(t *testing.T) {
	for _, kind := range []string{"create", "enable", "destination", "name", "disable", "rotation"} {
		t.Run(kind, func(t *testing.T) {
			f := newMgmtFixture(t)
			f.service.ConfigurationExpansionAvailable = false
			m := f.mutation("endpoint.update")
			expected := f.endpoint
			refuse := false
			switch kind {
			case "create":
				m.Kind = "endpoint.create"
				m.EndpointID = ""
				m.IfVersion = 0
				m.Name = mgmtPtr("new")
				m.Enabled = mgmtPtr(true)
				m.Destination = &Destination{Kind: "http", AdapterVersion: "1", URL: "https://receiver.example/new"}
				m.HasSubscriptions = true
				refuse = true
			case "enable":
				f.endpoint.Enabled = false
				m.Enabled = mgmtPtr(true)
				refuse = true
			case "destination":
				m.Destination = &Destination{Kind: "http", AdapterVersion: "1", URL: "https://receiver.example/new"}
				refuse = true
			case "name":
				m.Name = mgmtPtr("changed")
				expected.Name = "changed"
			case "disable":
				m.Enabled = mgmtPtr(false)
				expected.Enabled = false
			case "rotation":
				m.Kind = "signing.rotate"
				m.Mode = "immediate"
				expected.ActiveKeyID = mgmtRandomID(0)
			}
			f.recordWrites()
			if refuse {
				_, err := f.service.Mutate(f.ctx, f.principal, f.owner, m)
				mgmtWantFault(t, err, "webhooks_unavailable")
				f.noEffects()
				return
			}
			expected.ConfigVersion = 2
			expected.UpdatedAt = f.now
			keys := []wm.SigningKey{f.key}
			if kind == "rotation" {
				secret := make([]byte, 32)
				for i := range secret {
					secret[i] = byte(i + 16)
				}
				keys = []wm.SigningKey{{ID: expected.ActiveKeyID, EndpointID: expected.ID, Slot: "current", Secret: secret, CreatedAt: f.now}}
			}
			f.respondMutation(m, expected, "applied", keys)
			if _, err := f.service.Mutate(f.ctx, f.principal, f.owner, m); err != nil {
				t.Fatal(err)
			}
		})
	}
}

func TestManagementEntropyFailuresDoNotRequestEffects(t *testing.T) {
	for _, kind := range []string{"create", "rotate"} {
		for _, length := range []int{0, 16, 32, 47} {
			t.Run(kind+"/"+string(rune('A'+length)), func(t *testing.T) {
				f := newMgmtFixture(t)
				m := f.mutation("signing.rotate")
				m.Mode = "immediate"
				if kind == "create" {
					m.Kind = "endpoint.create"
					m.EndpointID = ""
					m.IfVersion = 0
					m.Name = mgmtPtr("new")
					m.Enabled = mgmtPtr(true)
					m.Destination = &Destination{Kind: "http", AdapterVersion: "1", URL: "https://receiver.example/"}
					m.HasSubscriptions = true
				}
				f.service.Random = bytes.NewReader(make([]byte, length))
				f.recordWrites()
				_, err := f.service.Mutate(f.ctx, f.principal, f.owner, m)
				if !errors.Is(err, io.EOF) && !errors.Is(err, io.ErrUnexpectedEOF) {
					t.Fatalf("entropy failure=%v", err)
				}
				f.noEffects()
			})
		}
	}
}

func TestManagementPreservesFailureAndCompletionFacts(t *testing.T) {
	cause := errors.New("injected storage failure")
	for _, phase := range []string{"initial snapshot", "operation", "policy", "first clock", "source lock", "endpoint read", "endpoint lock", "keys", "subscriptions", "locked credential", "endpoint write", "key deletion", "key write", "receipt write", "unknown with error", "unknown without error", "not committed without error", "postcommit snapshot", "postcommit credential", "postcommit operation"} {
		t.Run(phase, func(t *testing.T) {
			f := newMgmtFixture(t)
			m := f.mutation("endpoint.update")
			m.Name = mgmtPtr("changed")
			expected := f.endpoint
			expected.Name = "changed"
			expected.ConfigVersion = 2
			expected.UpdatedAt = f.now
			f.recordWrites()
			f.respondMutation(m, expected, "applied", []wm.SigningKey{f.key})
			switch phase {
			case "initial snapshot":
				f.db.ReadFn = func(context.Context, func(store.WebhookReadScope) error) error { return cause }
			case "operation":
				f.writer.OperationFn = func(context.Context, wm.Owner, string) (wm.Operation, error) { return wm.Operation{}, cause }
			case "policy":
				f.writer.PolicyFn = func(context.Context, int64) (wm.Policy, error) { return wm.Policy{}, cause }
			case "first clock":
				f.write.ObservedAtFn = func(context.Context) (time.Time, error) { return time.Time{}, cause }
			case "source lock":
				f.write.LockConfigurationSourcesFn = func(context.Context, wm.Owner, string, []string) error {
					return &store.Error{DatabaseFailure: true, Cause: cause}
				}
			case "endpoint read":
				f.writer.EndpointFn = func(context.Context, wm.Owner, string) (wm.Endpoint, error) { return wm.Endpoint{}, cause }
			case "endpoint lock":
				f.writer.LockEndpointFn = func(context.Context, wm.Owner, string) (wm.Endpoint, error) {
					return wm.Endpoint{}, &store.Error{DatabaseFailure: true, Cause: cause}
				}
			case "keys":
				f.writer.SigningKeysFn = func(context.Context, string) ([]wm.SigningKey, error) { return nil, cause }
			case "subscriptions":
				f.writer.LockSubscriptionsFn = func(context.Context, string) ([]wm.Subscription, error) { return nil, cause }
			case "locked credential":
				f.write.LockCredentialFn = func(context.Context, model.Principal) (store.ThreadCredential, error) {
					return store.ThreadCredential{}, cause
				}
			case "endpoint write":
				f.writer.PutEndpointFn = func(context.Context, wm.Endpoint) error { return cause }
			case "key deletion":
				f.writer.DeleteSigningKeysFn = func(context.Context, string) error { return cause }
			case "key write":
				f.writer.PutSigningKeyFn = func(context.Context, wm.SigningKey) error { return cause }
			case "receipt write":
				f.writer.PutOperationFn = func(context.Context, wm.Operation) error { return cause }
			case "unknown with error", "unknown without error", "not committed without error":
				f.db.WriteFn = func(context.Context, wm.Owner, string, func(store.WebhookWriteScope) error) (store.Completion, error) {
					outcome := store.TransactionUnknown
					if phase == "not committed without error" {
						outcome = store.TransactionNotCommitted
					}
					if phase == "unknown with error" {
						return store.Completion{Outcome: outcome}, cause
					}
					return store.Completion{Outcome: outcome}, nil
				}
			case "postcommit snapshot":
				f.db.ReadFn = func(_ context.Context, fn func(store.WebhookReadScope) error) error {
					f.reads++
					if f.reads == 1 {
						return fn(f.pre)
					}
					return cause
				}
			case "postcommit credential":
				f.postCredential.CredentialFn = func(context.Context, model.Principal) (store.ThreadCredential, error) {
					return store.ThreadCredential{}, cause
				}
			case "postcommit operation":
				f.postDAO.OperationFn = func(context.Context, wm.Owner, string) (wm.Operation, error) { return wm.Operation{}, cause }
			}
			_, err := f.service.Mutate(f.ctx, f.principal, f.owner, m)
			if strings.HasPrefix(phase, "postcommit") || strings.HasPrefix(phase, "unknown") || phase == "not committed without error" {
				mgmtWantFault(t, err, "write_outcome_unknown")
			}
			if !strings.HasSuffix(phase, "without error") && !errors.Is(err, cause) {
				t.Fatalf("lost %s cause: %v", phase, err)
			}
		})
	}
	if !errors.Is(notFound(cause), cause) {
		t.Fatal("classification lost cause")
	}
}

func TestManagementSecretCurrentKeyAndPermissions(t *testing.T) {
	for _, kind := range []string{"active", "wrong length", "missing key", "deleted", "member", "missing endpoint", "revoked credential"} {
		t.Run(kind, func(t *testing.T) {
			f := newMgmtFixture(t)
			switch kind {
			case "wrong length":
				f.key.Secret = bytes.Repeat([]byte{1}, 31)
			case "missing key":
				f.preDAO.SigningKeysFn = func(context.Context, string) ([]wm.SigningKey, error) { return nil, nil }
			case "deleted":
				f.endpoint.DeletedAt = mgmtPtr(f.now)
			case "member":
				f.team("shared", model.ProjectMemberRole)
			case "missing endpoint":
				f.preDAO.EndpointFn = func(context.Context, wm.Owner, string) (wm.Endpoint, error) { return wm.Endpoint{}, model.ErrNotFound }
			case "revoked credential":
				f.preCredential.CredentialFn = func(context.Context, model.Principal) (store.ThreadCredential, error) {
					return store.ThreadCredential{}, model.ErrNotFound
				}
			}
			value, err := f.service.Secret(f.ctx, f.principal, f.owner, f.endpoint.ID)
			if kind != "active" {
				if err == nil {
					t.Fatalf("%s secret exposed: %#v", kind, value)
				}
				return
			}
			v := value.(map[string]any)
			if v["secret"] != "whsec_"+base64.StdEncoding.EncodeToString(f.key.Secret) || v["configVersion"] != "1" || v["keyId"] != f.key.ID {
				t.Fatalf("secret=%#v", v)
			}
		})
	}
}
