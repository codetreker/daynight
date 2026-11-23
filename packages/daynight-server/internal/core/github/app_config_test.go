package github

import (
	"context"
	"errors"
	"math"
	"reflect"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/githubpr"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/google/uuid"
)

type configWriterStub struct {
	facts    store.GitHubAppConfigFacts
	errAt    string
	factsErr error
	steps    []string
	update   store.GitHubAppConfigUpdate
	fence    store.GitHubAppCredentialFence
	impact   int64
}

var errConfigStub = errors.New("controlled failure")

func (s *configWriterStub) step(name string) error {
	s.steps = append(s.steps, name)
	if s.errAt == name {
		return errConfigStub
	}
	return nil
}
func (s *configWriterStub) Facts(_ context.Context, actor string) (store.GitHubAppConfigFacts, error) {
	if actor == "" {
		panic("missing actor")
	}
	err := s.step("facts")
	if s.factsErr != nil {
		err = s.factsErr
	}
	return s.facts, err
}
func (s *configWriterStub) Update(_ context.Context, in store.GitHubAppConfigUpdate) (githubpr.AppMetadata, error) {
	s.update = in
	err := s.step("update")
	return githubpr.AppMetadata{ID: s.facts.App.ID, Version: in.Version}, err
}
func (s *configWriterStub) FenceConnections(_ context.Context, f store.GitHubAppCredentialFence) error {
	s.fence = f
	return s.step("fence")
}
func (s *configWriterStub) StopAppConnections(_ context.Context, d store.GitHubStopDecision) error {
	if d.Enabled || d.SyncEnabled || d.AccessState != "unknown" {
		panic("incorrect stop")
	}
	return s.step("stop")
}
func (s *configWriterStub) RemoveRelations(context.Context) error { return s.step("relations") }
func (s *configWriterStub) Tombstone(_ context.Context, impact int64) error {
	s.impact = impact
	return s.step("tombstone")
}

func configFixture() (model.Principal, string, store.GitHubAppConfigFacts) {
	p := model.Principal{Kind: model.SessionCredential, UserID: uuid.NewString(), CredentialID: uuid.NewString()}
	id := uuid.NewString()
	return p, id, store.GitHubAppConfigFacts{App: githubpr.AppMetadata{ID: id, Name: "name", GitHubAppID: 9, GitHubName: "remote", GitHubSlug: "remote", Version: 3}, CredentialVersion: 4, ImpactVersion: 5, MembershipVersion: 6, Credentials: githubpr.AppCredentials{PrivateKeyPEM: []byte("old key"), WebhookSecret: []byte("old secret")}}
}
func stringPointer(s string) *string { return &s }
func configFaultCode(err error) string {
	var f *model.Fault
	if errors.As(err, &f) {
		return f.Code
	}
	return ""
}

func TestAppConfigValidation(t *testing.T) {
	p, id, _ := configFixture()
	base := UpdateAppInput{Version: 3, ExpectedUserID: p.UserID, Name: stringPointer("valid")}
	if err := ValidateUpdateApp(p, id, base); err != nil {
		t.Fatal(err)
	}
	for _, mutate := range []func(*UpdateAppInput){
		func(i *UpdateAppInput) { i.ExpectedUserID = uuid.NewString() },
		func(i *UpdateAppInput) { i.Version = 0 },
		func(i *UpdateAppInput) { i.Name = nil },
		func(i *UpdateAppInput) { i.Name = stringPointer(" \u2003") },
		func(i *UpdateAppInput) { i.Name = stringPointer("bad\x00name") },
		func(i *UpdateAppInput) { i.Name = stringPointer(strings.Repeat("a", 257)) },
		func(i *UpdateAppInput) { i.Name = stringPointer(strings.Repeat("界", 342)) },
		func(i *UpdateAppInput) { i.Name = stringPointer(string([]byte{0xff})) },
		func(i *UpdateAppInput) { i.PrivateKeyPEM = stringPointer("") },
		func(i *UpdateAppInput) { i.PrivateKeyPEM = stringPointer(strings.Repeat("x", 65537)) },
		func(i *UpdateAppInput) { i.WebhookSecret = stringPointer("") },
		func(i *UpdateAppInput) { i.WebhookSecret = stringPointer(strings.Repeat("x", 4097)) },
	} {
		in := base
		mutate(&in)
		if err := ValidateUpdateApp(p, id, in); err == nil {
			t.Fatalf("accepted invalid input %#v", in)
		}
	}
	if ValidateUpdateApp(p, "invalid", base) == nil {
		t.Fatal("invalid app ID")
	}
	r := RemoveAppInput{Version: 3, ImpactVersion: 5, ExpectedUserID: p.UserID}
	if err := ValidateRemoveApp(p, id, r); err != nil {
		t.Fatal(err)
	}
	for _, in := range []RemoveAppInput{{Version: 0, ImpactVersion: 5, ExpectedUserID: p.UserID}, {Version: 3, ImpactVersion: 0, ExpectedUserID: p.UserID}, {Version: 3, ImpactVersion: 5, ExpectedUserID: uuid.NewString()}} {
		if ValidateRemoveApp(p, id, in) == nil {
			t.Fatalf("accepted %#v", in)
		}
	}
	if ValidateRemoveApp(p, "bad", r) == nil {
		t.Fatal("invalid ID")
	}
}

func TestUpdateAppDecisions(t *testing.T) {
	p, _, facts := configFixture()
	base := UpdateAppInput{Version: 3, ExpectedUserID: p.UserID}
	proof := &AppUpdateProof{MembershipVersion: 6, Version: 3, GitHubAppID: 9, GitHubName: "new remote", GitHubSlug: "new-slug"}
	for _, tc := range []struct {
		name  string
		input UpdateAppInput
		alter func(*configWriterStub)
		proof *AppUpdateProof
		code  string
		steps []string
	}{
		{"same", UpdateAppInput{Version: 3, Name: stringPointer("name")}, nil, nil, "", []string{"facts"}},
		{"stale same", UpdateAppInput{Version: 2, Name: stringPointer("name")}, nil, nil, "version_conflict", []string{"facts"}},
		{"renamed", UpdateAppInput{Version: 3, Name: stringPointer("new")}, nil, nil, "", []string{"facts", "update"}},
		{"credentials", UpdateAppInput{Version: 3, WebhookSecret: stringPointer("new")}, nil, proof, "", []string{"facts", "update", "fence"}},
		{"missing proof", UpdateAppInput{Version: 3, WebhookSecret: stringPointer("new")}, nil, nil, "github_admin_changed", []string{"facts"}},
		{"new membership", UpdateAppInput{Version: 3, WebhookSecret: stringPointer("new")}, func(s *configWriterStub) { s.facts.MembershipVersion++ }, proof, "github_admin_changed", []string{"facts"}},
		{"old version", UpdateAppInput{Version: 3, WebhookSecret: stringPointer("new")}, func(s *configWriterStub) { s.facts.App.Version++ }, proof, "version_conflict", []string{"facts"}},
		{"wrong identity", UpdateAppInput{Version: 3, WebhookSecret: stringPointer("new")}, func(s *configWriterStub) { s.facts.App.GitHubAppID++ }, proof, "github_admin_changed", []string{"facts"}},
		{"version exhausted", UpdateAppInput{Version: math.MaxInt64, Name: stringPointer("new")}, func(s *configWriterStub) { s.facts.App.Version = math.MaxInt64 }, nil, "version_exhausted", []string{"facts"}},
		{"credentials exhausted", UpdateAppInput{Version: 3, WebhookSecret: stringPointer("new")}, func(s *configWriterStub) { s.facts.CredentialVersion = math.MaxInt64 }, proof, "version_exhausted", []string{"facts"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			s := &configWriterStub{facts: facts}
			if tc.alter != nil {
				tc.alter(s)
			}
			tc.input.ExpectedUserID = base.ExpectedUserID
			out, err := UpdateApp(t.Context(), s, p, tc.input, tc.proof)
			if configFaultCode(err) != tc.code || !reflect.DeepEqual(s.steps, tc.steps) {
				t.Fatalf("result=%+v error=%v steps=%v", out, err, s.steps)
			}
			if tc.name == "same" && out.Version != 3 {
				t.Fatal(out)
			}
			if tc.name == "renamed" && (s.update.Name != "new" || s.update.Version != 4 || s.update.CredentialVersion != 4 || s.update.GitHubName != "remote") {
				t.Fatal(s.update)
			}
			if tc.name == "credentials" && (s.update.CredentialVersion != 5 || s.update.GitHubName != "new remote" || string(s.update.Credentials.PrivateKeyPEM) != "old key" || string(s.update.Credentials.WebhookSecret) != "new" || s.fence.CredentialVersion != 5 || s.fence.AccessState != "unknown" || !s.fence.ScheduleSyncAccess) {
				t.Fatalf("update=%+v fence=%+v", s.update, s.fence)
			}
		})
	}
	for _, at := range []string{"facts", "update", "fence"} {
		s := &configWriterStub{facts: facts, errAt: at}
		_, err := UpdateApp(t.Context(), s, p, UpdateAppInput{Version: 3, ExpectedUserID: p.UserID, WebhookSecret: stringPointer("new")}, proof)
		if !errors.Is(err, errConfigStub) {
			t.Fatalf("%s: %v", at, err)
		}
	}
	s := &configWriterStub{facts: facts, errAt: "facts"}
	_, err := ReadAppConfigForUpdate(t.Context(), s, p, base)
	if !errors.Is(err, errConfigStub) {
		t.Fatal(err)
	}
}

func TestAppConfigProofBoundaries(t *testing.T) {
	p, _, facts := configFixture()
	key := "replacement"
	c, changed := ProposedAppCredentials(facts, UpdateAppInput{PrivateKeyPEM: &key})
	if !changed || string(c.PrivateKeyPEM) != key || string(c.WebhookSecret) != "old secret" {
		t.Fatalf("credentials: %+v %v", c, changed)
	}
	s := &configWriterStub{facts: facts, factsErr: model.ErrNotFound}
	_, err := ReadAppConfigForUpdate(t.Context(), s, p, UpdateAppInput{Version: 3, ExpectedUserID: p.UserID})
	if configFaultCode(err) != "not_found" {
		t.Fatalf("precheck: %v", err)
	}
	_, err = UpdateApp(t.Context(), s, p, UpdateAppInput{Version: 3, ExpectedUserID: p.UserID, PrivateKeyPEM: &key}, &AppUpdateProof{MembershipVersion: 6, Version: 3, GitHubAppID: 9})
	if configFaultCode(err) != "github_admin_changed" {
		t.Fatalf("lost membership: %v", err)
	}
	s.steps = nil
	bad := UpdateAppInput{Version: 3, ExpectedUserID: uuid.NewString(), PrivateKeyPEM: &key}
	if _, err = ReadAppConfigForUpdate(t.Context(), s, p, bad); err == nil {
		t.Fatal("precheck accepted another actor")
	}
	if _, err = UpdateApp(t.Context(), s, p, bad, nil); err == nil {
		t.Fatal("update accepted another actor")
	}
	if err = RemoveApp(t.Context(), s, p, RemoveAppInput{Version: 3, ImpactVersion: 5, ExpectedUserID: bad.ExpectedUserID}); err == nil || len(s.steps) != 0 {
		t.Fatalf("remove actor: %v %v", err, s.steps)
	}
}

func TestRemoveAppDecisions(t *testing.T) {
	p, _, facts := configFixture()
	in := RemoveAppInput{Version: 3, ImpactVersion: 5, ExpectedUserID: p.UserID}
	s := &configWriterStub{facts: facts}
	s.facts.HasImpact = true
	if err := RemoveApp(t.Context(), s, p, in); err != nil || s.impact != 6 || !reflect.DeepEqual(s.steps, []string{"facts", "relations", "stop", "tombstone"}) {
		t.Fatalf("%v %#v", err, s)
	}
	s = &configWriterStub{facts: facts}
	if err := RemoveApp(t.Context(), s, p, in); err != nil || s.impact != 5 {
		t.Fatalf("empty: %v %#v", err, s)
	}
	for _, tc := range []struct {
		name  string
		alter func(*configWriterStub)
		in    RemoveAppInput
		code  string
	}{
		{"version", nil, RemoveAppInput{Version: 2, ImpactVersion: 5}, "version_conflict"},
		{"impact", nil, RemoveAppInput{Version: 3, ImpactVersion: 4}, "impact_changed"},
		{"exhausted", func(s *configWriterStub) { s.facts.ImpactVersion = math.MaxInt64; s.facts.HasImpact = true }, RemoveAppInput{Version: 3, ImpactVersion: math.MaxInt64}, "version_exhausted"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			s := &configWriterStub{facts: facts}
			if tc.alter != nil {
				tc.alter(s)
			}
			tc.in.ExpectedUserID = p.UserID
			err := RemoveApp(t.Context(), s, p, tc.in)
			if configFaultCode(err) != tc.code || !reflect.DeepEqual(s.steps, []string{"facts"}) {
				t.Fatalf("%v %v", err, s.steps)
			}
		})
	}
	for _, at := range []string{"facts", "stop", "relations", "tombstone"} {
		s := &configWriterStub{facts: facts, errAt: at}
		if err := RemoveApp(t.Context(), s, p, in); !errors.Is(err, errConfigStub) {
			t.Fatalf("%s: %v", at, err)
		}
	}
}
