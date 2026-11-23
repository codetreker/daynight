package usage

import (
	"bytes"
	"errors"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
)

func TestRegistrationBindingIncludesImmutableIdentityAndExcludesMutableState(t *testing.T) {
	identity := model.UsageRecord{ID: "state", Scope: "task", ProjectID: Ptr("project"), TaskID: Ptr("task"), TestExecutionID: Ptr("test"), SessionID: "session", ClaimID: Ptr("claim"), Generation: "1", WorkerID: Ptr("worker"), AuthorityUserID: "owner", ParentCredentialID: Ptr("parent"), Provider: "copilot", NativeSessionID: "native", AnchorStateID: Ptr("anchor"), RegistrationID: Ptr("registration"), ProfileID: "profile", ProviderVersion: "runtime"}
	digest, err := RegistrationBinding(identity, "controller", "1")
	if err != nil {
		t.Fatal(err)
	}
	for _, change := range []func(*model.UsageRecord){
		func(r *model.UsageRecord) { r.ID = "other" },
		func(r *model.UsageRecord) { r.Scope = "test" },
		func(r *model.UsageRecord) { r.ProjectID = Ptr("other") },
		func(r *model.UsageRecord) { r.TaskID = Ptr("other") },
		func(r *model.UsageRecord) { r.TestExecutionID = Ptr("other") },
		func(r *model.UsageRecord) { r.SessionID = "other" },
		func(r *model.UsageRecord) { r.ClaimID = Ptr("other") },
		func(r *model.UsageRecord) { r.Generation = "2" },
		func(r *model.UsageRecord) { r.WorkerID = Ptr("other") },
		func(r *model.UsageRecord) { r.AuthorityUserID = "other" },
		func(r *model.UsageRecord) { r.ParentCredentialID = Ptr("other") },
		func(r *model.UsageRecord) { r.Provider = "claude" },
		func(r *model.UsageRecord) { r.NativeSessionID = "other" },
		func(r *model.UsageRecord) { r.AnchorStateID = nil },
		func(r *model.UsageRecord) { r.RegistrationID = Ptr("other") },
		func(r *model.UsageRecord) { r.ProfileID = "other" },
		func(r *model.UsageRecord) { r.ProviderVersion = "other" },
	} {
		other := identity
		change(&other)
		actual, e := RegistrationBinding(other, "controller", "1")
		if e != nil || actual == digest {
			t.Fatal("identity not committed", other, e)
		}
	}
	for _, pair := range [][2]string{{"other", "1"}, {"controller", "2"}} {
		actual, e := RegistrationBinding(identity, pair[0], pair[1])
		if e != nil || actual == digest {
			t.Fatal(pair, e)
		}
	}
	identity.RowVersion = "9"
	identity.CollectionState = Ptr("partial")
	identity.ReasonCodes = []string{"source_conflict"}
	identity.GrantHash = []byte("mutable")
	identity.BodyHash = "mutable"
	actual, err := RegistrationBinding(identity, "controller", "1")
	if err != nil || actual != digest {
		t.Fatal("mutable state changed registration identity", err)
	}
	verifier := GrantVerifier{Binding: digest}
	verifier.TokenHash[0] = 42
	raw := verifier.Encode()
	decoded, err := ParseGrantVerifier(raw)
	if err != nil || decoded != verifier {
		t.Fatal(decoded, err)
	}
	raw[1] = 0
	if decoded.TokenHash[0] != 42 {
		t.Fatal("decoder retained mutable raw slice")
	}
	for _, bad := range [][]byte{nil, {}, make([]byte, 32), bytes.Repeat([]byte{1}, 64), bytes.Repeat([]byte{1}, 66), make([]byte, 65), append([]byte{2}, make([]byte, 64)...)} {
		if _, err = ParseGrantVerifier(bad); !errors.Is(err, ErrInvalidGrantVerifier) {
			t.Fatal("malformed envelope accepted", len(bad), err)
		}
	}
}
