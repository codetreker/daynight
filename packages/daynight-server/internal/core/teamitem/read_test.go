package teamitem

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/google/uuid"
)

func authority() Authority {
	p := model.Principal{Kind: model.PATCredential, UserID: uuid.NewString(), CredentialID: uuid.NewString()}
	return Authority{Principal: p, Kind: "pat", ID: p.CredentialID}
}
func faultCode(t *testing.T, err error, want string) {
	t.Helper()
	var fault *model.Fault
	if !errors.As(err, &fault) || fault.Code != want {
		t.Fatalf("error %v; want %s", err, want)
	}
}

func TestValidateItemReadRejectsAmbiguousIdentityAndUnboundedChunks(t *testing.T) {
	a := authority()
	target := Target{Kind: "team", TeamID: uuid.NewString()}
	valid := Input{Target: target, Action: "chunk", Revision: "revision", Field: "name", MaxBytes: 1}
	if err := Validate(a, valid); err != nil {
		t.Fatal(err)
	}
	for _, kind := range []string{"member", "project"} {
		in := Input{Target: Target{Kind: kind, TeamID: target.TeamID}, Action: "inspect"}
		if kind == "member" {
			in.Target.UserID = uuid.NewString()
		} else {
			in.Target.ProjectID = uuid.NewString()
		}
		if err := Validate(a, in); err != nil {
			t.Fatal(err)
		}
	}
	for _, change := range []func(*Input){
		func(in *Input) { in.Target.TeamID = "invalid" },
		func(in *Input) { in.Target.UserID = uuid.NewString() },
		func(in *Input) { in.Target.Kind = "unknown" },
		func(in *Input) { in.Target.Kind = "member"; in.Target.UserID = "invalid" },
		func(in *Input) { in.Target.Kind = "project"; in.Target.ProjectID = "invalid" },
		func(in *Input) { in.Action = "inspect" },
		func(in *Input) { in.Action = "unknown" },
		func(in *Input) { in.Revision = "" },
		func(in *Input) { in.Revision = strings.Repeat("x", 513) },
		func(in *Input) { in.Offset = -1 },
		func(in *Input) { in.Offset = 1<<30 + 1 },
		func(in *Input) { in.MaxBytes = 0 },
		func(in *Input) { in.MaxBytes = MaxChunkBytes + 1 },
	} {
		in := valid
		change(&in)
		faultCode(t, Validate(a, in), "invalid_input")
	}
	for _, change := range []func(*Authority){
		func(a *Authority) { a.Principal.UserID = "bad" },
		func(a *Authority) { a.Kind = "session" },
		func(a *Authority) { a.ID = uuid.NewString() },
		func(a *Authority) { a.Kind = "oauth"; a.Principal.Kind = model.OAuthCredential },
		func(a *Authority) {
			a.Kind = "oauth"
			a.Principal.Kind = model.OAuthCredential
			a.Resource = "resource"
			a.Scope = "scope"
			a.ID = "bad"
		},
	} {
		bad := a
		change(&bad)
		faultCode(t, Validate(bad, valid), "unauthenticated")
	}
}

type itemReader struct {
	metadata             Metadata
	data                 []byte
	metadataErr, readErr error
	reads                int
}

func (d *itemReader) Metadata(context.Context, model.Principal, Target) (Metadata, error) {
	return d.metadata, d.metadataErr
}
func (d *itemReader) FieldBytes(context.Context, Target, string, int64, int) ([]byte, error) {
	d.reads++
	return d.data, d.readErr
}

func TestRevisionPreservesEarlierTimestampChangeAndActorScope(t *testing.T) {
	a := authority()
	target := Target{Kind: "member", TeamID: uuid.NewString(), UserID: uuid.NewString()}
	early := time.Date(2026, 1, 1, 0, 0, 0, 123001000, time.UTC)
	late := early.Add(time.Hour)
	first, err := Revision(a.Principal, target, []time.Time{early, late})
	if err != nil {
		t.Fatal(err)
	}
	second, err := Revision(a.Principal, target, []time.Time{early.Add(time.Microsecond), late})
	if err != nil || first == second {
		t.Fatalf("earlier constituent change lost: %v", err)
	}
	other, err := Revision(authority().Principal, target, []time.Time{early, late})
	if err != nil || first == other {
		t.Fatalf("actor scope lost: %v", err)
	}
	_, err = Revision(a.Principal, target, []time.Time{time.Date(10000, 1, 1, 0, 0, 0, 0, time.UTC)})
	if err == nil {
		t.Fatal("invalid timestamp encoded")
	}
}

func TestReadRejectsChangedOrInvalidFieldsBeforeReadingBytes(t *testing.T) {
	a := authority()
	target := Target{Kind: "member", TeamID: uuid.NewString(), UserID: uuid.NewString()}
	m := Metadata{ModifiedAt: []time.Time{time.Now().UTC()}, Fields: []Field{{Name: "profile.name", SizeBytes: 3}, {Name: "profile.email", IsNull: true}}}
	revision, err := Revision(a.Principal, target, m.ModifiedAt)
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		name, revision, field string
		offset                int64
		code                  string
	}{
		{"changed", "old", "profile.name", 0, "version_conflict"},
		{"unknown", revision, "unknown", 0, "invalid_input"},
		{"null", revision, "profile.email", 0, "invalid_input"},
		{"past EOF", revision, "profile.name", 4, "invalid_input"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			d := &itemReader{metadata: m}
			result, err := Read(t.Context(), d, a, Input{Target: target, Action: "chunk", Revision: tc.revision, Field: tc.field, Offset: tc.offset, MaxBytes: 1})
			faultCode(t, err, tc.code)
			if d.reads != 0 || result.Metadata.Revision != "" {
				t.Fatal("invalid read accessed or exposed bytes")
			}
		})
	}
	failure := errors.New("read failed")
	d := &itemReader{metadataErr: failure}
	if _, err := Read(t.Context(), d, a, Input{Target: target, Action: "inspect"}); err != failure {
		t.Fatalf("metadata cause lost: %v", err)
	}
	d = &itemReader{metadata: m, readErr: failure}
	if _, err := Read(t.Context(), d, a, Input{Target: target, Action: "chunk", Revision: revision, Field: "profile.name", MaxBytes: 3}); err != failure {
		t.Fatalf("byte cause lost: %v", err)
	}
	d = &itemReader{metadata: m, data: []byte("ab")}
	if _, err := Read(t.Context(), d, a, Input{Target: target, Action: "chunk", Revision: revision, Field: "profile.name", MaxBytes: 3}); err == nil {
		t.Fatal("short source accepted")
	}
	d.data = []byte("abc")
	result, err := Read(t.Context(), d, a, Input{Target: target, Action: "chunk", Revision: revision, Field: "profile.name", MaxBytes: 5})
	if err != nil || !result.EOF || string(result.Content) != "abc" {
		t.Fatalf("complete read: %#v %v", result, err)
	}
	result, err = Read(t.Context(), d, a, Input{Target: target, Action: "chunk", Revision: revision, Field: "profile.name", Offset: 3, MaxBytes: 1})
	if err != nil || !result.EOF || len(result.Content) != 0 {
		t.Fatalf("EOF: %#v %v", result, err)
	}
}

func TestReadMissingItemPreservesLookupCause(t *testing.T) {
	a := authority()
	target := Target{Kind: "team", TeamID: uuid.NewString()}
	missing := errors.Join(model.ErrNotFound, errors.New("selected Team membership absent"))
	dao := &itemReader{metadataErr: missing}
	result, err := Read(t.Context(), dao, a, Input{Target: target, Action: "inspect"})
	faultCode(t, err, "not_found")
	if !errors.Is(err, missing) || !errors.Is(err, model.ErrNotFound) || dao.reads != 0 || result.Metadata.Revision != "" {
		t.Fatalf("missing resource cause or empty-result guarantee lost: %#v %v", result, err)
	}
}
